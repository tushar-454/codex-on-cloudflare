/**
 * Translates a Workers AI Chat-Completions SSE stream (chat.completion.chunk) into an
 * OpenAI Responses API SSE stream, chunk by chunk (real token streaming, not simulated).
 *
 * Why: Workers AI only offers the Responses API for GPT-OSS and only with stream:false
 * (verified: streaming Responses input on the binding returns an empty/aborted stream),
 * while Chat-Completions streaming works with real deltas, reasoning_content and
 * tool_calls for every registered model.
 *
 * Event lifecycle emitted (per OpenAI Responses streaming spec):
 *   response.created -> response.in_progress
 *   per output item, in order:
 *     reasoning: output_item.added, content_part.added, reasoning_text.delta*, reasoning_text.done,
 *                content_part.done, output_item.done
 *     message:   output_item.added, content_part.added, output_text.delta*, output_text.done,
 *                content_part.done, output_item.done
 *     function:  output_item.added, function_call_arguments.delta*, function_call_arguments.done,
 *                output_item.done
 *     custom:    output_item.added, custom_tool_call_input.delta, custom_tool_call_input.done, output_item.done
 *   response.completed | response.incomplete | response.failed
 */

// ---------- Responses output types ----------

export interface OutputTextPart {
  type: "output_text";
  text: string;
  annotations: unknown[];
  logprobs: unknown[];
}
export interface ReasoningTextPart {
  type: "reasoning_text";
  text: string;
}
export interface MessageItem {
  type: "message";
  id: string;
  status: "in_progress" | "completed" | "incomplete";
  role: "assistant";
  content: OutputTextPart[];
}
export interface ReasoningItem {
  type: "reasoning";
  id: string;
  status?: "in_progress" | "completed" | "incomplete";
  summary: unknown[];
  content: ReasoningTextPart[];
}
export interface FunctionCallItem {
  type: "function_call";
  id: string;
  status: "in_progress" | "completed" | "incomplete";
  call_id: string;
  name: string;
  /** Codex tool namespace (e.g. "multi_agent_v1") for namespaced tools. */
  namespace?: string;
  arguments: string;
}
export interface CustomToolCallItem {
  type: "custom_tool_call";
  id: string;
  status: "in_progress" | "completed" | "incomplete";
  call_id: string;
  name: string;
  namespace?: string;
  input: string;
}
export type OutputItem = MessageItem | ReasoningItem | FunctionCallItem | CustomToolCallItem;

export interface ResponsesUsage {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
}

export interface ResponseError {
  code: string;
  message: string;
}

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  status: "in_progress" | "completed" | "incomplete" | "failed";
  model: string;
  output: OutputItem[];
  usage: ResponsesUsage | null;
  error: ResponseError | null;
  incomplete_details: { reason: string } | null;
  parallel_tool_calls: boolean;
  reasoning: { effort: string | null; summary: null };
  store: false;
}

// ---------- Upstream chunk types (subset we rely on) ----------

interface ChunkToolCallDelta {
  index?: number;
  id?: string | null;
  type?: string;
  function?: { name?: string | null; arguments?: string | null };
}
interface ChunkChoice {
  index?: number;
  delta?: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: ChunkToolCallDelta[] | null;
  };
  finish_reason?: string | null;
}
interface UpstreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}
export interface UpstreamChunk {
  choices?: ChunkChoice[];
  usage?: UpstreamUsage | null;
  /** Workers AI's trailing summary chunk: {"response":"","usage":{...totals}}. */
  response?: string;
}

// ---------- SSE helpers ----------

export type ResponsesEvent = { type: string } & Record<string, unknown>;

export function encodeSse(event: ResponsesEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Incremental parser for upstream `data: ...` SSE lines (handles split chunks, CRLF). */
export class SseLineDecoder {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  /** Returns the `data:` payloads completed by this chunk (pass `undefined` to flush). */
  push(chunk: Uint8Array | undefined): string[] {
    this.buffer += chunk === undefined ? this.decoder.decode() : this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = chunk === undefined ? "" : (lines.pop() ?? "");
    const out: string[] = [];
    for (const line of lines) {
      if (line.startsWith("data:")) out.push(line.slice(5).trimStart());
    }
    return out;
  }
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

// ---------- Translator ----------

export interface TranslatorOptions {
  responseId: string;
  model: string;
  effort: string | null;
  parallelToolCalls: boolean;
  /** Names of Responses `custom` (freeform) tools, which we exposed upstream as functions. */
  customToolNames: ReadonlySet<string>;
  /** Flattened upstream name -> Codex namespace + inner tool name. */
  namespacedTools?: ReadonlyMap<string, { namespace: string; name: string }>;
  emit: (event: ResponsesEvent) => void;
}

interface ToolState {
  outputIndex: number;
  item: FunctionCallItem;
  custom: boolean;
}

/**
 * Stateful Chat-chunk -> Responses-event translator. Feed it upstream chunks with
 * `onChunk`, then call `finish()` (or `fail()`); read `response` for the final object.
 */
export class ResponsesTranslator {
  readonly response: ResponseObject;
  private seq = 0;
  private reasoning: { index: number; item: ReasoningItem } | null = null;
  private message: { index: number; item: MessageItem } | null = null;
  /** Whitespace-only text held back so we don't emit empty assistant messages. */
  private pendingWhitespace = "";
  private readonly tools = new Map<number, ToolState>();
  private finishReason: string | null = null;
  private usage: UpstreamUsage | null = null;
  private done = false;

  constructor(private readonly opts: TranslatorOptions) {
    this.response = {
      id: opts.responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "in_progress",
      model: opts.model,
      output: [],
      usage: null,
      error: null,
      incomplete_details: null,
      parallel_tool_calls: opts.parallelToolCalls,
      reasoning: { effort: opts.effort, summary: null },
      store: false,
    };
  }

  private send(type: string, payload: Record<string, unknown>): void {
    this.opts.emit({ type, sequence_number: this.seq++, ...payload });
  }

  private snapshot(): ResponseObject {
    return structuredClone(this.response);
  }

  start(): void {
    this.send("response.created", { response: this.snapshot() });
    this.send("response.in_progress", { response: this.snapshot() });
  }

  private addItem(item: OutputItem): number {
    const index = this.response.output.length;
    this.response.output.push(item);
    return index;
  }

  // ----- reasoning -----
  private appendReasoning(delta: string): void {
    if (this.reasoning === null) {
      this.closeMessage();
      const item: ReasoningItem = { type: "reasoning", id: randomId("rs"), status: "in_progress", summary: [], content: [] };
      const index = this.addItem(item);
      this.reasoning = { index, item };
      this.send("response.output_item.added", { output_index: index, item: structuredClone(item) });
      item.content.push({ type: "reasoning_text", text: "" });
      this.send("response.content_part.added", {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        part: { type: "reasoning_text", text: "" },
      });
    }
    const { index, item } = this.reasoning;
    const part = item.content[0];
    if (part) part.text += delta;
    this.send("response.reasoning_text.delta", { item_id: item.id, output_index: index, content_index: 0, delta });
  }

  private closeReasoning(): void {
    if (this.reasoning === null) return;
    const { index, item } = this.reasoning;
    this.reasoning = null;
    const text = item.content[0]?.text ?? "";
    this.send("response.reasoning_text.done", { item_id: item.id, output_index: index, content_index: 0, text });
    this.send("response.content_part.done", {
      item_id: item.id,
      output_index: index,
      content_index: 0,
      part: { type: "reasoning_text", text },
    });
    item.status = "completed";
    this.send("response.output_item.done", { output_index: index, item: structuredClone(item) });
  }

  // ----- assistant text -----
  private appendText(delta: string): void {
    if (this.message === null) {
      if (delta.trim() === "") {
        this.pendingWhitespace += delta;
        return;
      }
      delta = this.pendingWhitespace + delta;
      this.pendingWhitespace = "";
      this.closeReasoning();
      const item: MessageItem = { type: "message", id: randomId("msg"), status: "in_progress", role: "assistant", content: [] };
      const index = this.addItem(item);
      this.message = { index, item };
      this.send("response.output_item.added", { output_index: index, item: structuredClone(item) });
      item.content.push({ type: "output_text", text: "", annotations: [], logprobs: [] });
      this.send("response.content_part.added", {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [], logprobs: [] },
      });
    }
    const { index, item } = this.message;
    const part = item.content[0];
    if (part) part.text += delta;
    this.send("response.output_text.delta", { item_id: item.id, output_index: index, content_index: 0, delta, logprobs: [] });
  }

  private closeMessage(status: MessageItem["status"] = "completed"): void {
    this.pendingWhitespace = "";
    if (this.message === null) return;
    const { index, item } = this.message;
    this.message = null;
    const part = item.content[0] ?? { type: "output_text" as const, text: "", annotations: [], logprobs: [] };
    this.send("response.output_text.done", { item_id: item.id, output_index: index, content_index: 0, text: part.text, logprobs: [] });
    this.send("response.content_part.done", { item_id: item.id, output_index: index, content_index: 0, part: structuredClone(part) });
    item.status = status;
    this.send("response.output_item.done", { output_index: index, item: structuredClone(item) });
  }

  // ----- tool calls -----
  /** Undo namespace flattening so Codex can route the call. */
  private restoreNamespace(item: FunctionCallItem): void {
    const mapped = this.opts.namespacedTools?.get(item.name);
    if (mapped === undefined) return;
    item.name = mapped.name;
    item.namespace = mapped.namespace;
  }

  private appendToolCall(tc: ChunkToolCallDelta, fallbackIndex: number): void {
    const key = tc.index ?? fallbackIndex;
    let state = this.tools.get(key);
    if (state === undefined) {
      this.closeReasoning();
      this.closeMessage();
      const callId = tc.id && tc.id.length > 0 ? tc.id : randomId("call");
      const item: FunctionCallItem = {
        type: "function_call",
        id: randomId("fc"),
        status: "in_progress",
        call_id: callId,
        name: tc.function?.name ?? "",
        arguments: "",
      };
      state = { outputIndex: -1, item, custom: false };
      this.tools.set(key, state);
    } else if (tc.function?.name) {
      // Some backends split the name across deltas.
      state.item.name += tc.function.name;
    }
    if (state.outputIndex === -1 && state.item.name !== "") {
      state.custom = this.opts.customToolNames.has(state.item.name);
      // Custom (freeform) calls are announced once their input is complete, because the
      // upstream arguments are a JSON wrapper `{"input": "..."}` we must unwrap first.
      if (!state.custom) {
        this.restoreNamespace(state.item);
        state.outputIndex = this.addItem(state.item);
        this.send("response.output_item.added", { output_index: state.outputIndex, item: structuredClone(state.item) });
      }
    }
    const delta = tc.function?.arguments ?? "";
    if (delta === "") return;
    state.item.arguments += delta;
    if (state.outputIndex !== -1 && !state.custom) {
      this.send("response.function_call_arguments.delta", { item_id: state.item.id, output_index: state.outputIndex, delta });
    }
  }

  private closeTools(): void {
    for (const state of this.tools.values()) {
      const { item } = state;
      if (item.name === "") continue; // never received a name; nothing Codex could execute
      item.status = "completed";
      if (state.custom) {
        const mapped = this.opts.namespacedTools?.get(item.name);
        const custom: CustomToolCallItem = {
          type: "custom_tool_call",
          id: item.id.replace(/^fc_/, "ctc_"),
          status: "completed",
          call_id: item.call_id,
          name: mapped?.name ?? item.name,
          ...(mapped ? { namespace: mapped.namespace } : {}),
          input: unwrapCustomInput(item.arguments),
        };
        const index = this.addItem(custom);
        this.send("response.output_item.added", { output_index: index, item: { ...structuredClone(custom), status: "in_progress", input: "" } });
        this.send("response.custom_tool_call_input.delta", { item_id: custom.id, output_index: index, delta: custom.input });
        this.send("response.custom_tool_call_input.done", { item_id: custom.id, output_index: index, input: custom.input });
        this.send("response.output_item.done", { output_index: index, item: structuredClone(custom) });
        continue;
      }
      if (item.arguments.trim() === "") item.arguments = "{}";
      this.send("response.function_call_arguments.done", {
        item_id: item.id,
        output_index: state.outputIndex,
        name: item.name,
        arguments: item.arguments,
      });
      this.send("response.output_item.done", { output_index: state.outputIndex, item: structuredClone(item) });
    }
    this.tools.clear();
  }

  /** Feed one parsed upstream chunk. */
  onChunk(chunk: UpstreamChunk): void {
    if (this.done) return;
    if (chunk.usage && (chunk.choices === undefined || chunk.choices.length === 0)) {
      // Trailing totals chunk (Workers AI) or OpenAI-style usage-only chunk.
      this.usage = chunk.usage;
    } else if (chunk.usage && (chunk.usage.prompt_tokens ?? 0) > 0 && this.usage === null) {
      this.usage = chunk.usage; // provisional; replaced by the totals chunk
    }
    for (const choice of chunk.choices ?? []) {
      if ((choice.index ?? 0) !== 0) continue; // n>1 is never requested
      const d = choice.delta ?? {};
      const reasoning = d.reasoning_content ?? d.reasoning ?? "";
      if (reasoning !== "") this.appendReasoning(reasoning);
      if (typeof d.content === "string" && d.content !== "") this.appendText(d.content);
      (d.tool_calls ?? []).forEach((tc, i) => this.appendToolCall(tc, i));
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
    }
  }

  private mapUsage(): ResponsesUsage | null {
    if (this.usage === null) return null;
    const input = this.usage.prompt_tokens ?? 0;
    const output = this.usage.completion_tokens ?? 0;
    return {
      input_tokens: input,
      input_tokens_details: { cached_tokens: this.usage.prompt_tokens_details?.cached_tokens ?? 0 },
      output_tokens: output,
      output_tokens_details: { reasoning_tokens: this.usage.completion_tokens_details?.reasoning_tokens ?? 0 },
      total_tokens: this.usage.total_tokens ?? input + output,
    };
  }

  /** Close all open items and emit the terminal event. */
  finish(): ResponseObject {
    if (this.done) return this.response;
    this.done = true;
    const truncated = this.finishReason === "length" || this.finishReason === "content_filter";
    this.closeReasoning();
    this.closeMessage(truncated ? "incomplete" : "completed");
    this.closeTools();
    this.response.usage = this.mapUsage();
    if (truncated) {
      this.response.status = "incomplete";
      this.response.incomplete_details = {
        reason: this.finishReason === "length" ? "max_output_tokens" : "content_filter",
      };
      this.send("response.incomplete", { response: this.snapshot() });
    } else {
      this.response.status = "completed";
      this.send("response.completed", { response: this.snapshot() });
    }
    return this.response;
  }

  /** Terminate with response.failed (upstream error mid-stream). */
  fail(error: ResponseError): ResponseObject {
    if (this.done) return this.response;
    this.done = true;
    this.response.status = "failed";
    this.response.error = error;
    this.response.usage = this.mapUsage();
    this.send("response.failed", { response: this.snapshot() });
    return this.response;
  }

  get finished(): boolean {
    return this.done;
  }
}

/** Freeform tools are exposed upstream as `{input: string}` functions; unwrap the argument. */
export function unwrapCustomInput(args: string): string {
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed === "object" && parsed !== null && "input" in parsed) {
      const input = (parsed as { input: unknown }).input;
      if (typeof input === "string") return input;
    }
  } catch {
    // fall through: model produced raw text instead of JSON
  }
  return args;
}

/**
 * Pipe an upstream Workers AI SSE byte stream through the translator, producing a
 * Responses SSE byte stream. Pull-based: backpressure flows to the upstream, and if
 * the client disconnects, `cancel` aborts the upstream read (stops inference billing
 * as soon as Workers AI notices).
 */
export function translateStream(
  upstream: ReadableStream<Uint8Array>,
  opts: Omit<TranslatorOptions, "emit">,
  mapError: (err: unknown) => ResponseError,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new SseLineDecoder();
  const reader = upstream.getReader();
  let queue: string[] = [];
  const translator = new ResponsesTranslator({ ...opts, emit: (e) => queue.push(encodeSse(e)) });
  translator.start();

  const flush = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (queue.length > 0) controller.enqueue(encoder.encode(queue.join("")));
    queue = [];
  };

  const handlePayloads = (payloads: string[]): void => {
    for (const data of payloads) {
      if (data === "" || data === "[DONE]") continue;
      let chunk: UpstreamChunk;
      try {
        chunk = JSON.parse(data) as UpstreamChunk;
      } catch {
        continue; // ignore malformed keep-alive noise rather than killing the turn
      }
      if (typeof (chunk as { error?: unknown }).error !== "undefined") {
        translator.fail({ code: "upstream_error", message: describeUpstreamError((chunk as { error: unknown }).error) });
        return;
      }
      translator.onChunk(chunk);
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      flush(controller); // response.created / in_progress go out immediately
    },
    async pull(controller) {
      try {
        while (queue.length === 0 && !translator.finished) {
          const { done, value } = await reader.read();
          if (done) {
            handlePayloads(decoder.push(undefined));
            translator.finish();
            break;
          }
          handlePayloads(decoder.push(value));
        }
      } catch (err) {
        translator.fail(mapError(err));
      }
      flush(controller);
      if (translator.finished) {
        controller.close();
        reader.cancel().catch(() => undefined);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

/** Non-streaming variant: run the same translation and return the final object. */
export async function collectResponse(
  upstream: ReadableStream<Uint8Array>,
  opts: Omit<TranslatorOptions, "emit">,
  mapError: (err: unknown) => ResponseError,
): Promise<ResponseObject> {
  let final: ResponseObject | null = null;
  const reader = translateStream(upstream, opts, mapError).getReader();
  const decoder = new SseLineDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    const payloads = decoder.push(done ? undefined : value);
    for (const data of payloads) {
      const event = JSON.parse(data) as { type: string; response?: ResponseObject };
      if (event.response && /^response\.(completed|incomplete|failed)$/.test(event.type)) final = event.response;
    }
    if (done) break;
  }
  if (final === null) throw new Error("translator produced no terminal event");
  return final;
}

function describeUpstreamError(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Upstream inference error.";
}
