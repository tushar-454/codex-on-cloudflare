/**
 * Calls Workers AI through the AI binding and returns a Responses API answer.
 *
 * Every request goes upstream as a streaming Chat-Completions call; the result is
 * either piped to the client as Responses SSE (stream=true, what Codex uses) or
 * collected into a single Responses JSON object (stream=false).
 */

import { HttpError, jsonResponse, sseResponse } from "./http";
import { parsePlan, type ModelSpec, type UpstreamParams } from "./models";
import { parseResponsesRequest, type ParsedRequest } from "./responses";
import { collectResponse, randomId, translateStream, type ResponseError } from "./streaming";

export interface AiRunner {
  run(model: string, inputs: Record<string, unknown>, options?: AiOptions): Promise<unknown>;
}

export interface InferenceEnv {
  AI: AiRunner;
  DEFAULT_MODEL?: string;
  /** "paid" enables Workers Paid-only models; anything else = Free. Set by setup.sh. */
  WORKERS_PLAN?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Shallow merge, except nested plain objects (e.g. chat_template_kwargs) are merged one level deep. */
function mergeParams(target: Record<string, unknown>, extra: UpstreamParams | undefined): void {
  if (extra === undefined) return;
  for (const [key, value] of Object.entries(extra)) {
    const existing = target[key];
    target[key] = isPlainObject(existing) && isPlainObject(value) ? { ...existing, ...value } : value;
  }
}

/**
 * Workers AI (vLLM) rejects requests where prompt + max_tokens exceeds the context
 * window, so shrink max_tokens when the prompt is large. Token count is estimated
 * conservatively (~3 bytes/token); if even 1024 output tokens don't fit, the request is
 * sent anyway and the upstream context error is surfaced as context_length_exceeded.
 */
export function fitMaxTokens(req: ParsedRequest): number {
  const promptBytes = new TextEncoder().encode(JSON.stringify(req.messages) + JSON.stringify(req.tools)).byteLength;
  const estimatedPromptTokens = Math.ceil(promptBytes / 3);
  const room = req.model.contextWindow - estimatedPromptTokens - 256;
  return Math.max(Math.min(req.maxOutputTokens, room), Math.min(1024, req.maxOutputTokens));
}

export function buildUpstreamInputs(req: ParsedRequest): Record<string, unknown> {
  const inputs: Record<string, unknown> = {
    messages: req.messages,
    stream: true,
    max_tokens: fitMaxTokens(req),
  };
  if (req.tools.length > 0) {
    inputs.tools = req.tools;
    if (req.toolChoice !== undefined) inputs.tool_choice = req.toolChoice;
    if (!req.parallelToolCalls) inputs.parallel_tool_calls = false;
  }
  if (req.responseFormat !== undefined) {
    // Workers AI JSON mode does not support streaming (documented), so structured-output
    // requests run non-streaming and are replayed as SSE (see completionToSse).
    inputs.stream = false;
    inputs.response_format = req.responseFormat;
  }
  if (req.temperature !== undefined) inputs.temperature = req.temperature;
  if (req.topP !== undefined) inputs.top_p = req.topP;
  mergeParams(inputs, req.model.baseParams);
  if (req.effort !== null) mergeParams(inputs, req.model.reasoning?.efforts[req.effort]);
  return inputs;
}

/** Extract Workers AI's "NNNN: message" error code. */
function parseAiError(err: unknown): { code: number | null; message: string; name: string } {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const match = /^\s*(?:AiError:\s*)?(\d{4}):\s*(.*)$/s.exec(message);
  return match ? { code: Number(match[1]), message: (match[2] ?? "").trim(), name } : { code: null, message, name };
}

function clip(s: string, n = 300): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Map a Workers AI failure (thrown before streaming starts) to an HTTP error. */
export function mapAiError(err: unknown, model: ModelSpec): HttpError {
  const { code, message, name } = parseAiError(err);
  const detail = clip(message || "Workers AI request failed.");
  if (/context length|context window|maximum context|too many tokens|prompt is too long/i.test(message)) {
    return new HttpError(400, "invalid_request_error", "context_length_exceeded", `Input exceeds the context window of '${model.id}' (${model.contextWindow} tokens). ${detail}`);
  }
  switch (code) {
    case 3036:
      // Daily free allocation exhausted: retrying cannot help until 00:00 UTC.
      return new HttpError(429, "rate_limit_error", "insufficient_quota", "Workers AI daily free allocation (10,000 Neurons) is used up; it resets at 00:00 UTC.");
    case 3040:
      return new HttpError(503, "server_error", "server_is_overloaded", `Workers AI capacity temporarily exceeded for '${model.id}'. Please try again.`);
    case 5035:
      return new HttpError(403, "permission_error", "model_requires_paid_plan", `Model '${model.id}' requires the Workers Paid plan and is not available on Workers Free.`);
    case 5028:
      return new HttpError(410, "invalid_request_error", "model_retired", `Model '${model.id}' has been retired by Cloudflare. ${detail}`);
    case 5007:
    case 3042:
      return new HttpError(502, "server_error", "model_unavailable", `Workers AI does not currently serve '${model.id}'. ${detail}`);
    case 3006:
      return new HttpError(413, "invalid_request_error", "request_too_large", `Workers AI rejected the request as too large. ${detail}`);
    case 3007:
    case 3008:
      return new HttpError(504, "server_error", "upstream_timeout", `Workers AI request timed out. ${detail}`);
    case 5018:
    case 5016:
    case 3023:
    case 3041:
      return new HttpError(403, "permission_error", "upstream_forbidden", detail);
    case 5006: // input schema validation ("oneOf at '/' not met ...")
    case 8001:
    case 5004:
    case 3003:
      return new HttpError(400, "invalid_request_error", "upstream_invalid_input", `Workers AI rejected the translated request for '${model.id}': ${detail}`);
    default:
      if (name === "AbortError") return new HttpError(499, "invalid_request_error", "client_closed_request", "Client closed the request.");
      return new HttpError(502, "server_error", "upstream_error", `Workers AI error${code !== null ? ` ${code}` : ""}: ${detail}`);
  }
}

/** Errors that happen after the SSE stream has started become response.failed payloads. */
function mapStreamError(model: ModelSpec): (err: unknown) => ResponseError {
  return (err) => {
    const http = mapAiError(err, model);
    return { code: http.code, message: http.message };
  };
}

/**
 * Convert a complete (non-streaming) chat.completion — or the legacy Workers AI
 * `{response, tool_calls, usage}` shape — into an equivalent one-shot SSE chunk stream,
 * so it can go through the same Responses translator. This is SIMULATED streaming:
 * the client receives the whole answer at once, after inference has finished.
 */
export function completionToSse(result: unknown): ReadableStream<Uint8Array> {
  const delta: Record<string, unknown> = {};
  let finish = "stop";
  let usage: unknown;
  if (isPlainObject(result) && Array.isArray(result.choices)) {
    const choice = result.choices[0] as Record<string, unknown> | undefined;
    const message = (isPlainObject(choice?.message) ? choice.message : {}) as Record<string, unknown>;
    const reasoning = message.reasoning_content ?? message.reasoning;
    if (typeof reasoning === "string" && reasoning !== "") delta.reasoning_content = reasoning;
    if (typeof message.content === "string") delta.content = message.content;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) delta.tool_calls = normalizeToolCalls(message.tool_calls);
    if (typeof choice?.finish_reason === "string") finish = choice.finish_reason;
    usage = result.usage;
  } else if (isPlainObject(result)) {
    const response = result.response;
    delta.content = typeof response === "string" ? response : response === undefined || response === null ? "" : JSON.stringify(response);
    if (Array.isArray(result.tool_calls) && result.tool_calls.length > 0) {
      delta.tool_calls = normalizeToolCalls(result.tool_calls);
      finish = "tool_calls";
    }
    usage = result.usage;
  }
  const chunks: unknown[] = [{ choices: [{ index: 0, delta, finish_reason: finish }] }];
  if (usage !== undefined) chunks.push({ choices: [], usage });
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text).body as ReadableStream<Uint8Array>;
}

function normalizeToolCalls(calls: unknown[]): unknown[] {
  return calls.map((raw, index) => {
    const tc = isPlainObject(raw) ? raw : {};
    const fn = isPlainObject(tc.function) ? tc.function : tc; // legacy: {name, arguments}
    const args = fn.arguments;
    return {
      index,
      id: typeof tc.id === "string" ? tc.id : undefined,
      type: "function",
      function: { name: fn.name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
    };
  });
}

/** Codex's prompt_cache_key is a per-thread id: reuse it for Workers AI prefix-cache routing. */
function sessionAffinity(body: unknown): string | undefined {
  if (!isPlainObject(body)) return undefined;
  const key = body.prompt_cache_key;
  return typeof key === "string" && /^[\w.:-]{1,128}$/.test(key) ? key : undefined;
}

export async function handleResponses(body: unknown, env: InferenceEnv, signal?: AbortSignal): Promise<Response> {
  const req = parseResponsesRequest(body, env.DEFAULT_MODEL, parsePlan(env.WORKERS_PLAN));
  const inputs = buildUpstreamInputs(req);
  const affinity = sessionAffinity(body);
  // Observability (no content, no secrets): visible in `wrangler tail` / Workers Logs.
  console.log(
    `snowy model=${req.model.id} effort=${req.effort ?? "default"} stream=${req.stream} messages=${req.messages.length} tools=${req.tools.length}`,
  );
  const options: AiOptions = {
    ...(signal ? { signal } : {}),
    ...(affinity ? { extraHeaders: { "x-session-affinity": affinity } } : {}),
  };

  let upstream: unknown;
  try {
    upstream = await env.AI.run(req.model.id, inputs, options);
  } catch (err) {
    const mapped = mapAiError(err, req.model);
    console.warn(`Workers AI error for ${req.model.id}: ${mapped.code}`);
    throw mapped;
  }
  let simulated = false;
  if (!(upstream instanceof ReadableStream)) {
    if (inputs.stream !== false) {
      throw new HttpError(502, "server_error", "upstream_bad_response", `Workers AI returned a non-streaming response for '${req.model.id}'.`);
    }
    upstream = completionToSse(upstream);
    simulated = true;
  }

  const translatorOptions = {
    responseId: randomId("resp"),
    model: req.model.id,
    effort: req.effort,
    parallelToolCalls: req.parallelToolCalls,
    customToolNames: req.customToolNames,
    namespacedTools: req.namespacedTools,
  };
  const extraHeaders: Record<string, string> = { "X-Snowy-Model": req.model.id };
  if (req.droppedTools.length > 0) extraHeaders["X-Snowy-Dropped-Tools"] = [...new Set(req.droppedTools)].join(",");
  if (simulated) extraHeaders["X-Snowy-Streaming"] = "simulated";
  if (req.ignoredEffort !== null) extraHeaders["X-Snowy-Reasoning-Ignored"] = `${req.ignoredEffort}; model has no reasoning control`;

  if (req.stream) {
    const res = sseResponse(translateStream(upstream as ReadableStream<Uint8Array>, translatorOptions, mapStreamError(req.model)));
    for (const [k, v] of Object.entries(extraHeaders)) res.headers.set(k, v);
    return res;
  }

  const response = await collectResponse(upstream as ReadableStream<Uint8Array>, translatorOptions, mapStreamError(req.model));
  if (response.status === "failed" && response.error !== null) {
    throw new HttpError(502, "server_error", response.error.code, response.error.message);
  }
  return jsonResponse(response, 200, extraHeaders);
}
