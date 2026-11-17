/** Test helpers: fake Workers AI binding + SSE utilities. */

import type { SnowyEnv } from "../../src/index";

export const API_KEY = "test-key-0123456789abcdefghijklmnop";

export interface RunCall {
  model: string;
  inputs: Record<string, unknown>;
  options: unknown;
}

/** Build an upstream Workers AI chat SSE body from chunk objects. */
export function upstreamSse(chunks: unknown[], opts: { done?: boolean; splitEvery?: number } = {}): ReadableStream<Uint8Array> {
  let text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
  if (opts.done !== false) text += "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  const step = opts.splitEvery ?? bytes.length;
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + step));
      offset += step;
    },
  });
}

export function textChunks(text: string, reasoning = ""): unknown[] {
  const chunks: unknown[] = [{ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }];
  if (reasoning) chunks.push({ choices: [{ index: 0, delta: { reasoning_content: reasoning } }] });
  for (const piece of text.match(/.{1,4}/gs) ?? []) chunks.push({ choices: [{ index: 0, delta: { content: piece } }] });
  chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  chunks.push({ response: "", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, neurons: 1.2 } });
  return chunks;
}

export function toolChunks(name: string, args: string, id = "call_up_1"): unknown[] {
  const half = Math.ceil(args.length / 2);
  return [
    { choices: [{ index: 0, delta: { reasoning_content: "I should call a tool." } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { response: "", usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
  ];
}

export type RunImpl = (model: string, inputs: Record<string, unknown>, options?: unknown) => Promise<unknown>;

export function fakeEnv(run: RunImpl, overrides: Partial<SnowyEnv> = {}): SnowyEnv & { calls: RunCall[] } {
  const calls: RunCall[] = [];
  const ai = {
    run: async (model: string, inputs: Record<string, unknown>, options?: unknown) => {
      calls.push({ model, inputs, options });
      return run(model, inputs, options);
    },
  };
  return { AI: ai as unknown as SnowyEnv["AI"], SNOWY_API_KEY: API_KEY, MAX_BODY_BYTES: "200000", calls, ...overrides };
}

export function streamingEnv(chunks: unknown[], overrides: Partial<SnowyEnv> = {}) {
  return fakeEnv(async () => upstreamSse(chunks), overrides);
}

export function post(body: unknown, init: { auth?: string | null; headers?: Record<string, string>; path?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...init.headers };
  if (init.auth !== null) headers.Authorization = init.auth ?? `Bearer ${API_KEY}`;
  return new Request(`https://snowy.test${init.path ?? "/v1/responses"}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export interface SseEvent {
  event: string;
  data: Record<string, unknown> & { type: string };
}

export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split("\n\n")) {
    if (block.trim() === "") continue;
    const lines = block.split("\n");
    const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "";
    const data = lines.find((l) => l.startsWith("data: "))?.slice(6) ?? "{}";
    events.push({ event, data: JSON.parse(data) as SseEvent["data"] });
  }
  return events;
}
