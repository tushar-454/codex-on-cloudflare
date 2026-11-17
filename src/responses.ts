/**
 * Responses API request validation and translation to Workers AI Chat-Completions input.
 *
 * Codex sends the FULL conversation every turn (store=false, no previous_response_id):
 * instructions + input items (messages, reasoning, function_call, function_call_output,
 * custom_tool_call(_output), ...). We translate those items into an equivalent
 * OpenAI chat `messages` array, keeping tool-call ids so tool results stay linked.
 */

import { HttpError } from "./http";
import { ALL_EFFORTS, availableOnPlan, findModel, isSunset, modelsForPlan, supportedEfforts, type Effort, type ModelSpec, type Plan } from "./models";

// ---------- Chat types sent upstream ----------

type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatContentPart[] }
  // content is always a string: GPT-OSS's schema rejects null (verified: error 5006).
  | { role: "assistant"; content: string; tool_calls?: ChatToolCall[]; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ParsedRequest {
  model: ModelSpec;
  stream: boolean;
  effort: Effort | null;
  messages: ChatMessage[];
  tools: ChatTool[];
  toolChoice: unknown;
  parallelToolCalls: boolean;
  maxOutputTokens: number;
  temperature?: number;
  topP?: number;
  customToolNames: Set<string>;
  /** Flattened upstream tool name -> Codex namespace + inner name. */
  namespacedTools: Map<string, { namespace: string; name: string }>;
  /** Hosted/unsupported tools dropped from the request (reported via header). */
  droppedTools: string[];
  /** Effort sent by the client but not applicable (model has no reasoning control). */
  ignoredEffort: string | null;
  /** Chat `response_format` derived from Responses `text.format` (structured output). */
  responseFormat?: Record<string, unknown>;
}

// ---------- small validators ----------

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function invalid(message: string, param: string | null = null, code = "invalid_request"): HttpError {
  return new HttpError(400, "invalid_request_error", code, message, param);
}

function optionalNumber(body: Json, key: string, min: number, max: number): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw invalid(`'${key}' must be a number between ${min} and ${max}.`, key);
  }
  return v;
}

// ---------- models listing ----------

export function listModels(plan: Plan = "free", now: Date = new Date()) {
  return {
    object: "list",
    workers_plan: plan,
    data: modelsForPlan(plan, now).map((m) => ({
      id: m.id,
      object: "model",
      created: 0,
      owned_by: m.id.split("/")[1] ?? "cloudflare",
      display_name: m.displayName,
      category: m.category,
      context_window: m.contextWindow,
      max_output_tokens: m.defaultMaxOutputTokens,
      function_calling: m.functionCalling,
      streaming: m.streaming,
      vision: m.vision,
      reasoning: m.reasoning !== null,
      reasoning_efforts: supportedEfforts(m),
      reasoning_default_effort: m.reasoning?.defaultEffort ?? null,
      reasoning_default: m.reasoning?.defaultBehavior ?? null,
      free_plan_verified: m.freePlanVerified,
      requires_workers_paid: m.requiresPaid === true,
      codex_compatibility: m.codex,
      neurons_per_million_tokens: { input: m.neurons.inputPerM, output: m.neurons.outputPerM },
      ...(m.sunset ? { sunset: m.sunset } : {}),
    })),
  };
}

// ---------- model + effort ----------

export function resolveModel(id: unknown, fallback: string | undefined, plan: Plan = "free", now: Date = new Date()): ModelSpec {
  const requested = id === undefined || id === null || id === "" ? fallback : id;
  if (typeof requested !== "string") throw invalid("'model' must be a string.", "model");
  const model = findModel(requested);
  if (model === undefined) {
    throw new HttpError(
      400,
      "invalid_request_error",
      "model_not_supported",
      `Model '${requested.slice(0, 200)}' is not enabled on this SNOWy endpoint. GET /v1/models lists the supported models.`,
      "model",
    );
  }
  if (isSunset(model, now)) {
    throw new HttpError(410, "invalid_request_error", "model_retired", `Model '${model.id}' was retired by Cloudflare on ${model.sunset}.`, "model");
  }
  if (!availableOnPlan(model, plan)) {
    throw new HttpError(
      403,
      "permission_error",
      "model_requires_paid_plan",
      `Model '${model.id}' requires the Workers Paid plan. This SNOWy endpoint runs with WORKERS_PLAN="${plan}"; re-run ./setup.sh on a Paid account to enable it.`,
      "model",
    );
  }
  return model;
}

/**
 * Returns the validated effort. For models without any reasoning control, an effort is
 * "not applicable": it is reported back in `ignored` and never sent upstream.
 */
export function resolveEffort(reasoning: unknown, model: ModelSpec): { effort: Effort | null; ignored: string | null } {
  if (reasoning === undefined || reasoning === null) return { effort: null, ignored: null };
  if (!isObject(reasoning)) throw invalid("'reasoning' must be an object.", "reasoning");
  const effort = reasoning.effort;
  if (effort === undefined || effort === null) return { effort: null, ignored: null };
  if (typeof effort !== "string" || !(ALL_EFFORTS as readonly string[]).includes(effort)) {
    throw invalid(`Unknown reasoning effort '${String(effort).slice(0, 40)}'. Valid values: ${ALL_EFFORTS.join(", ")}.`, "reasoning.effort", "invalid_reasoning_effort");
  }
  if (model.reasoning === null) return { effort: null, ignored: effort };
  const supported = supportedEfforts(model);
  if (!supported.includes(effort as Effort)) {
    throw invalid(
      `Reasoning effort '${effort}' is not supported by '${model.id}'. Supported: ${supported.join(", ")} ` +
        `(default: ${model.reasoning.defaultBehavior}). In Codex use -c model_reasoning_effort=<level>.`,
      "reasoning.effort",
      "unsupported_reasoning_effort",
    );
  }
  return { effort: effort as Effort, ignored: null };
}

// ---------- input items -> chat messages ----------

function textOfContent(content: unknown, param: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw invalid("Message content must be a string or an array.", param);
  const parts: string[] = [];
  for (const part of content) {
    if (!isObject(part)) continue;
    if (typeof part.text === "string") parts.push(part.text);
    else if (part.type === "input_image") parts.push("[image omitted]");
    else if (typeof part.refusal === "string") parts.push(part.refusal);
  }
  return parts.join("\n");
}

function userContent(content: unknown, vision: boolean, param: string): string | ChatContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw invalid("Message content must be a string or an array.", param);
  const parts: ChatContentPart[] = [];
  for (const part of content) {
    if (!isObject(part)) continue;
    if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "input_image") {
      const url = typeof part.image_url === "string" ? part.image_url : undefined;
      if (vision && url) parts.push({ type: "image_url", image_url: { url } });
      else parts.push({ type: "text", text: "[image omitted: the selected model does not accept images]" });
    } else if (part.type === "input_file") {
      parts.push({ type: "text", text: "[file attachment omitted: not supported by SNOWy]" });
    }
  }
  if (parts.every((p) => p.type === "text")) return parts.map((p) => (p as { text: string }).text).join("\n");
  return parts;
}

/** function_call_output.output may be a string or an array of content items. */
function toolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return textOfContent(output, "output");
  if (isObject(output) && typeof output.content === "string") return output.content;
  return JSON.stringify(output ?? "");
}

function reasoningText(item: Json): string {
  const pieces: string[] = [];
  for (const key of ["content", "summary"] as const) {
    const arr = item[key];
    if (!Array.isArray(arr)) continue;
    for (const p of arr) if (isObject(p) && typeof p.text === "string") pieces.push(p.text);
    if (pieces.length > 0) break; // prefer raw content; fall back to summary
  }
  return pieces.join("\n");
}

export function convertInput(
  instructions: unknown,
  input: unknown,
  model: ModelSpec,
): ChatMessage[] {
  if (instructions !== undefined && instructions !== null && typeof instructions !== "string") {
    throw invalid("'instructions' must be a string.", "instructions");
  }
  let items: unknown[];
  if (typeof input === "string") items = [{ type: "message", role: "user", content: input }];
  else if (Array.isArray(input)) items = input;
  else throw invalid("'input' is required and must be a string or an array of input items.", "input");
  if (items.length === 0 && !instructions) throw invalid("'input' must not be empty.", "input");

  const systemParts: string[] = typeof instructions === "string" && instructions.trim() !== "" ? [instructions] : [];
  const messages: ChatMessage[] = [];
  let pendingReasoning = "";
  let sawConversation = false;

  /** Current trailing assistant message, created on demand so text + tool calls merge. */
  const assistant = (): Extract<ChatMessage, { role: "assistant" }> => {
    const last = messages.at(-1);
    if (last?.role === "assistant") return last;
    const msg: Extract<ChatMessage, { role: "assistant" }> = { role: "assistant", content: "" };
    messages.push(msg);
    return msg;
  };
  const attachReasoning = (msg: Extract<ChatMessage, { role: "assistant" }>): void => {
    if (pendingReasoning !== "" && model.reasoning !== null) {
      msg.reasoning_content = (msg.reasoning_content ? msg.reasoning_content + "\n" : "") + pendingReasoning;
    }
    pendingReasoning = "";
  };
  const addToolCall = (callId: string, name: string, args: string): void => {
    const msg = assistant();
    attachReasoning(msg);
    (msg.tool_calls ??= []).push({ id: callId, type: "function", function: { name, arguments: args } });
  };

  items.forEach((raw, i) => {
    const param = `input[${i}]`;
    if (!isObject(raw)) throw invalid("Each input item must be an object.", param);
    // Items without "type" but with "role" are messages (EasyInputMessage).
    const type = typeof raw.type === "string" ? raw.type : raw.role !== undefined ? "message" : "";

    switch (type) {
      case "message": {
        const role = raw.role;
        if (role === "system" || role === "developer") {
          const text = textOfContent(raw.content, `${param}.content`);
          if (!sawConversation) systemParts.push(text);
          // Mid-conversation developer/system updates (e.g. permission or model changes):
          // many chat templates reject non-leading system messages, so deliver as user turn.
          else messages.push({ role: "user", content: `<${role}_message>\n${text}\n</${role}_message>` });
          return;
        }
        if (role === "user") {
          sawConversation = true;
          pendingReasoning = "";
          messages.push({ role: "user", content: userContent(raw.content, model.vision, `${param}.content`) });
          return;
        }
        if (role === "assistant") {
          sawConversation = true;
          const text = textOfContent(raw.content, `${param}.content`);
          // Text and tool calls from the same model turn belong to one assistant message,
          // in whichever order they were emitted (a new turn starts after tool results).
          const msg = assistant();
          msg.content = msg.content ? `${msg.content}\n${text}` : text;
          attachReasoning(msg);
          return;
        }
        throw invalid(`Unsupported message role '${String(role).slice(0, 40)}'.`, `${param}.role`);
      }
      case "reasoning": {
        const text = reasoningText(raw);
        if (text !== "") pendingReasoning = pendingReasoning ? `${pendingReasoning}\n${text}` : text;
        // encrypted_content is OpenAI-only and cannot be used by Workers AI models.
        return;
      }
      case "function_call": {
        if (typeof raw.call_id !== "string" || typeof raw.name !== "string") {
          throw invalid("function_call items need string 'call_id' and 'name'.", param);
        }
        const name = typeof raw.namespace === "string" && raw.namespace !== "" ? flattenToolName(raw.namespace, raw.name) : raw.name;
        addToolCall(raw.call_id, name, typeof raw.arguments === "string" ? raw.arguments : JSON.stringify(raw.arguments ?? {}));
        sawConversation = true;
        return;
      }
      case "custom_tool_call": {
        if (typeof raw.call_id !== "string" || typeof raw.name !== "string") {
          throw invalid("custom_tool_call items need string 'call_id' and 'name'.", param);
        }
        const name = typeof raw.namespace === "string" && raw.namespace !== "" ? flattenToolName(raw.namespace, raw.name) : raw.name;
        addToolCall(raw.call_id, name, JSON.stringify({ input: typeof raw.input === "string" ? raw.input : "" }));
        sawConversation = true;
        return;
      }
      case "local_shell_call": {
        const callId = typeof raw.call_id === "string" ? raw.call_id : typeof raw.id === "string" ? raw.id : "";
        if (callId === "") throw invalid("local_shell_call items need 'call_id'.", param);
        addToolCall(callId, "local_shell", JSON.stringify(raw.action ?? {}));
        sawConversation = true;
        return;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        if (typeof raw.call_id !== "string") throw invalid(`${type} items need a string 'call_id'.`, param);
        messages.push({ role: "tool", tool_call_id: raw.call_id, content: toolOutputText(raw.output) });
        return;
      }
      case "agent_message": {
        // Codex multi-agent message between agents: deliver as a user-turn note.
        const author = typeof raw.author === "string" ? raw.author : "agent";
        const recipient = typeof raw.recipient === "string" ? raw.recipient : "";
        const text = textOfContent(raw.content ?? [], `${param}.content`);
        messages.push({ role: "user", content: `<agent_message author="${author}" recipient="${recipient}">\n${text}\n</agent_message>` });
        sawConversation = true;
        return;
      }
      case "additional_tools":
        // Tool definitions injected mid-thread: handled by the caller via extractAdditionalTools().
        return;
      case "web_search_call":
      case "image_generation_call":
      case "tool_search_call":
      case "tool_search_output":
      case "compaction":
      case "context_compaction":
      case "compaction_summary":
      case "compaction_trigger":
      case "configuration_update":
      case "item_reference":
        // OpenAI-hosted, encrypted or client-control items. Hosted calls only exist if this
        // thread previously used an OpenAI model; their payloads are server-side/encrypted,
        // so there is nothing a Workers AI model could consume.
        return;
      default:
        throw invalid(`Unsupported input item type '${String(type).slice(0, 60)}'.`, `${param}.type`);
    }
  });

  if (systemParts.length > 0) messages.unshift({ role: "system", content: systemParts.join("\n\n") });
  if (!messages.some((m) => m.role === "user")) {
    throw invalid("The conversation must contain at least one user message.", "input");
  }
  return mergeConsecutiveUsers(fixOrphanToolCalls(messages));
}

/**
 * Chat templates require every assistant tool_call to be answered by a tool message
 * (e.g. when the user interrupted Codex mid-call). Add an explicit placeholder result.
 */
function fixOrphanToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    out.push(msg);
    if (msg.role !== "assistant" || !msg.tool_calls) continue;
    const answered = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === "tool") {
      answered.add((messages[j] as { tool_call_id: string }).tool_call_id);
      out.push(messages[j]!);
      j++;
    }
    for (const tc of msg.tool_calls) {
      if (!answered.has(tc.id)) out.push({ role: "tool", tool_call_id: tc.id, content: "aborted: no result was recorded for this tool call" });
    }
    i = j - 1;
  }
  return out;
}

function mergeConsecutiveUsers(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const msg of messages) {
    const last = out.at(-1);
    if (msg.role === "user" && last?.role === "user" && typeof msg.content === "string" && typeof last.content === "string") {
      last.content = `${last.content}\n\n${msg.content}`;
    } else {
      out.push(msg);
    }
  }
  return out;
}

// ---------- tools ----------

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Codex namespace tools (e.g. multi_agent_v1 -> spawn_agent) become flat function names
 * upstream, because chat function calling has no namespaces.
 */
export function flattenToolName(namespace: string, name: string): string {
  const joined = name.startsWith(namespace) ? name : `${namespace}__${name}`;
  if (NAME_RE.test(joined)) return joined;
  // MCP/plugin namespaces can carry characters like '.', '@', '/' or ':' and long names;
  // upstream only accepts ^[a-zA-Z0-9_-]{1,64}$. Sanitize deterministically (the same
  // input always maps to the same name, so history items line up) and keep a hash
  // suffix when we had to alter or truncate, so distinct tools stay distinct.
  const clean = joined.replace(/[^a-zA-Z0-9_-]/g, "_");
  const suffix = `_${fnv1a(joined)}`;
  return clean.length <= 64 && clean === joined ? clean : `${clean.slice(0, 64 - suffix.length)}${suffix}`;
}

/** 32-bit FNV-1a, base36: short stable suffix for sanitized tool names. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export interface ConvertedTools {
  tools: ChatTool[];
  customToolNames: Set<string>;
  namespacedTools: Map<string, { namespace: string; name: string }>;
  dropped: string[];
}

export function convertTools(tools: unknown): ConvertedTools {
  const result: ChatTool[] = [];
  const customToolNames = new Set<string>();
  const namespacedTools = new Map<string, { namespace: string; name: string }>();
  const dropped: string[] = [];
  const out = { tools: result, customToolNames, namespacedTools, dropped };
  if (tools === undefined || tools === null) return out;
  if (!Array.isArray(tools)) throw invalid("'tools' must be an array.", "tools");

  const addFunction = (name: unknown, description: unknown, parameters: unknown, param: string): void => {
    if (typeof name !== "string" || name === "") throw invalid("Tool names must be non-empty strings.", param);
    if (!NAME_RE.test(name)) {
      // One odd tool name (e.g. from an MCP server) shouldn't fail the whole turn.
      dropped.push(`invalid-name:${name.slice(0, 40)}`);
      return;
    }
    result.push({
      type: "function",
      function: {
        name,
        description: typeof description === "string" ? description : "",
        parameters: isObject(parameters) ? parameters : { type: "object", properties: {} },
      },
    });
  };

  const convertOne = (tool: unknown, param: string, namespace: string | null): void => {
    if (!isObject(tool)) throw invalid("Each tool must be an object.", param);
    const name = namespace !== null && typeof tool.name === "string" ? flattenToolName(namespace, tool.name) : tool.name;
    if (namespace !== null && typeof tool.name === "string") namespacedTools.set(name as string, { namespace, name: tool.name });
    switch (tool.type) {
      case "function":
        addFunction(name, tool.description, tool.parameters, param);
        return;
      case "namespace": {
        if (typeof tool.name !== "string" || !Array.isArray(tool.tools)) throw invalid("Namespace tools need 'name' and 'tools'.", param);
        const ns = tool.name;
        tool.tools.forEach((inner, j) => convertOne(inner, `${param}.tools[${j}]`, ns));
        return;
      }
      case "custom": {
        // Freeform tool (e.g. Codex apply_patch with a Lark grammar). Workers AI models
        // only support JSON function calling, so expose it as a single-string-argument
        // function and convert calls back to custom_tool_call items on the way out.
        const format = isObject(tool.format) ? tool.format : {};
        const grammar = typeof format.definition === "string" ? `\n\nThe 'input' value must follow this ${String(format.syntax ?? "")} grammar:\n${format.definition}` : "";
        addFunction(
          name,
          `${typeof tool.description === "string" ? tool.description : ""}${grammar}`,
          {
            type: "object",
            properties: { input: { type: "string", description: "The raw freeform input for this tool." } },
            required: ["input"],
          },
          param,
        );
        customToolNames.add(name as string);
        return;
      }
      default:
        // Hosted tools (web_search, image_generation, file_search, tool_search, ...) run on
        // OpenAI's servers; Workers AI cannot execute them.
        dropped.push(typeof tool.type === "string" ? tool.type.slice(0, 40) : "unknown");
    }
  };
  tools.forEach((tool, i) => convertOne(tool, `tools[${i}]`, null));
  return out;
}

/** Tools introduced mid-thread through `additional_tools` input items. */
function extractAdditionalTools(input: unknown): unknown[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item) => (isObject(item) && item.type === "additional_tools" && Array.isArray(item.tools) ? item.tools : []));
}

function convertToolChoice(choice: unknown, haveTools: boolean): unknown {
  if (!haveTools || choice === undefined || choice === null) return undefined;
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (isObject(choice) && choice.type === "function" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  throw invalid("Unsupported 'tool_choice'.", "tool_choice");
}

// ---------- request ----------

export function parseResponsesRequest(body: unknown, defaultModel: string | undefined, plan: Plan = "free", now: Date = new Date()): ParsedRequest {
  if (!isObject(body)) throw invalid("Request body must be a JSON object.");
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    throw invalid(
      "'previous_response_id' is not supported: SNOWy is stateless. Send the full conversation in 'input' (Codex does this by default).",
      "previous_response_id",
      "unsupported_parameter",
    );
  }
  if (body.background === true) throw invalid("'background' mode is not supported.", "background", "unsupported_parameter");

  const responseFormat = convertTextFormat(body.text);

  const model = resolveModel(body.model, defaultModel, plan, now);
  const { effort, ignored } = resolveEffort(body.reasoning, model);
  const messages = convertInput(body.instructions, body.input, model);
  const allTools = [...(Array.isArray(body.tools) ? body.tools : body.tools === undefined || body.tools === null ? [] : [body.tools]), ...extractAdditionalTools(body.input)];
  if (body.tools !== undefined && body.tools !== null && !Array.isArray(body.tools)) throw invalid("'tools' must be an array.", "tools");
  const { tools, customToolNames, namespacedTools, dropped } = convertTools(allTools);
  if (tools.length > 0 && !model.functionCalling) {
    throw invalid(`Model '${model.id}' does not support tool calling.`, "tools", "tools_not_supported");
  }

  const requestedMax = optionalNumber(body, "max_output_tokens", 1, 1_000_000);
  const maxOutputTokens = Math.min(requestedMax ?? model.defaultMaxOutputTokens, model.defaultMaxOutputTokens);
  const temperature = optionalNumber(body, "temperature", 0, 2);
  const topP = optionalNumber(body, "top_p", 0, 1);

  return {
    model,
    stream: body.stream === true,
    effort,
    messages,
    tools,
    toolChoice: convertToolChoice(body.tool_choice, tools.length > 0),
    parallelToolCalls: body.parallel_tool_calls !== false,
    maxOutputTokens,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    customToolNames,
    namespacedTools,
    droppedTools: dropped,
    ignoredEffort: ignored,
    ...(responseFormat ? { responseFormat } : {}),
  };
}

/** Responses `text.format` -> chat `response_format` (Codex uses this for e.g. thread titles). */
function convertTextFormat(text: unknown): Record<string, unknown> | undefined {
  if (text === undefined || text === null) return undefined;
  if (!isObject(text)) throw invalid("'text' must be an object.", "text");
  const format = text.format;
  if (format === undefined || format === null) return undefined;
  if (!isObject(format)) throw invalid("'text.format' must be an object.", "text.format");
  switch (format.type) {
    case "text":
      return undefined;
    case "json_object":
      return { type: "json_object" };
    case "json_schema":
      if (!isObject(format.schema)) throw invalid("'text.format.schema' must be an object.", "text.format.schema");
      return {
        type: "json_schema",
        json_schema: { name: typeof format.name === "string" ? format.name : "output", schema: format.schema, strict: format.strict === true },
      };
    default:
      throw invalid(`Unsupported text.format type '${String(format.type).slice(0, 40)}'.`, "text.format.type", "unsupported_parameter");
  }
}
