import { describe, expect, it } from "vitest";
import { encodeSse, ResponsesTranslator, SseLineDecoder, translateStream, type ResponsesEvent } from "../../src/streaming";
import { parseSse, textChunks, toolChunks, upstreamSse } from "./helpers";

function run(chunks: unknown[], customToolNames: string[] = []): ResponsesEvent[] {
  const events: ResponsesEvent[] = [];
  const t = new ResponsesTranslator({
    responseId: "resp_test",
    model: "@cf/test/model",
    effort: null,
    parallelToolCalls: true,
    customToolNames: new Set(customToolNames),
    emit: (e) => events.push(e),
  });
  t.start();
  for (const c of chunks) t.onChunk(c as never);
  t.finish();
  return events;
}

describe("SseLineDecoder", () => {
  it("reassembles data lines split across chunks and CRLF", () => {
    const d = new SseLineDecoder();
    const enc = new TextEncoder();
    expect(d.push(enc.encode('data: {"a"'))).toEqual([]);
    expect(d.push(enc.encode(':1}\r\n\r\ndata: [DONE]\n'))).toEqual(['{"a":1}', "[DONE]"]);
    expect(d.push(undefined)).toEqual([]);
  });
});

describe("ResponsesTranslator", () => {
  it("emits the full text lifecycle in order with consistent ids and indices", () => {
    const events = run(textChunks("Hello world", "thinking..."));
    expect(events.map((e) => e.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.reasoning_text.delta",
      "response.reasoning_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    // sequence numbers strictly increase from 0
    events.forEach((e, i) => expect(e.sequence_number).toBe(i));
    const msgAdded = events[8]!;
    expect(msgAdded.output_index).toBe(1);
    const msgId = (msgAdded.item as { id: string }).id;
    for (const e of events.slice(9, 16)) expect(e.item_id ?? (e.item as { id: string }).id).toBe(msgId);
    const completed = events.at(-1)!.response as Record<string, unknown>;
    expect(completed.status).toBe("completed");
    expect(completed.output).toEqual([
      expect.objectContaining({ type: "reasoning", content: [{ type: "reasoning_text", text: "thinking..." }] }),
      expect.objectContaining({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Hello world", annotations: [], logprobs: [] }],
      }),
    ]);
    expect(completed.usage).toEqual({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    });
  });

  it("streams function calls with argument deltas and preserves the upstream call id", () => {
    const events = run(toolChunks("shell", '{"command":["ls","-la"]}', "call_up_42"));
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "response.function_call_arguments.delta")).toHaveLength(2);
    const done = events.find((e) => e.type === "response.output_item.done" && (e.item as { type: string }).type === "function_call");
    expect(done?.item).toEqual({
      type: "function_call",
      id: expect.stringMatching(/^fc_/),
      status: "completed",
      call_id: "call_up_42",
      name: "shell",
      arguments: '{"command":["ls","-la"]}',
    });
    expect(types.indexOf("response.function_call_arguments.done")).toBeLessThan(types.lastIndexOf("response.output_item.done"));
    expect(types.at(-1)).toBe("response.completed");
  });

  it("converts calls to freeform (custom) tools back into custom_tool_call items", () => {
    const patch = "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch";
    const events = run(toolChunks("apply_patch", JSON.stringify({ input: patch })), ["apply_patch"]);
    const done = events.find((e) => e.type === "response.output_item.done" && (e.item as { type: string }).type === "custom_tool_call");
    expect(done?.item).toMatchObject({ type: "custom_tool_call", name: "apply_patch", input: patch, call_id: "call_up_1" });
    expect(events.some((e) => e.type === "response.function_call_arguments.delta")).toBe(false);
  });

  it("does not emit an assistant message for whitespace-only content", () => {
    const chunks = [{ choices: [{ index: 0, delta: { content: "\n" } }] }, ...toolChunks("shell", "{}")];
    const events = run(chunks);
    expect(events.some((e) => (e.item as { type?: string } | undefined)?.type === "message")).toBe(false);
  });

  it("maps finish_reason=length to response.incomplete", () => {
    const events = run([
      { choices: [{ index: 0, delta: { content: "partial" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
    ]);
    const last = events.at(-1)!;
    expect(last.type).toBe("response.incomplete");
    expect((last.response as { incomplete_details: unknown }).incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  it("encodes events as named SSE frames", () => {
    expect(encodeSse({ type: "response.created", sequence_number: 0 })).toBe(
      'event: response.created\ndata: {"type":"response.created","sequence_number":0}\n\n',
    );
  });
});

describe("translateStream", () => {
  const opts = { responseId: "resp_x", model: "m", effort: null, parallelToolCalls: true, customToolNames: new Set<string>() };
  const mapError = (e: unknown) => ({ code: "server_error", message: String(e) });

  it("handles byte-split upstream input", async () => {
    const out = await new Response(translateStream(upstreamSse(textChunks("abc def"), { splitEvery: 7 }), opts, mapError)).text();
    const events = parseSse(out);
    expect(events.at(-1)?.event).toBe("response.completed");
    const text = events.filter((e) => e.event === "response.output_text.delta").map((e) => e.data.delta).join("");
    expect(text).toBe("abc def");
    for (const e of events) expect(e.event).toBe(e.data.type);
  });

  it("emits response.failed when the upstream stream errors mid-way", async () => {
    let n = 0;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (n++ === 0) controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'));
        else controller.error(new Error("Network connection lost."));
      },
    });
    const events = parseSse(await new Response(translateStream(upstream, opts, mapError)).text());
    const last = events.at(-1)!;
    expect(last.event).toBe("response.failed");
    expect((last.data.response as { error: unknown }).error).toEqual({ code: "server_error", message: "Error: Network connection lost." });
  });

  it("propagates client cancellation to the upstream reader", async () => {
    let cancelled: unknown = null;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"tok "}}]}\n\n'));
      },
      cancel(reason) {
        cancelled = reason ?? "cancelled";
      },
    });
    const reader = translateStream(upstream, opts, mapError).getReader();
    await reader.read();
    await reader.read();
    await reader.cancel("client went away");
    expect(cancelled).toBe("client went away");
  });

  it("finishes with response.completed even without [DONE] or usage", async () => {
    const out = await new Response(
      translateStream(upstreamSse([{ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }] }], { done: false }), opts, mapError),
    ).text();
    const last = parseSse(out).at(-1)!;
    expect(last.event).toBe("response.completed");
    expect((last.data.response as { usage: unknown }).usage).toBeNull();
  });
});
