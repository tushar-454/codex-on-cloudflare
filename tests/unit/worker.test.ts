import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { MODELS, supportedEfforts } from "../../src/models";
import { API_KEY, fakeEnv, parseSse, post, streamingEnv, textChunks, toolChunks, upstreamSse } from "./helpers";

const call = (req: Request, env: Parameters<typeof worker.fetch>[1]) => worker.fetch(req, env);
const DEFAULT = "@cf/zai-org/glm-4.7-flash";

function basicBody(extra: Record<string, unknown> = {}) {
  return { model: DEFAULT, stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], ...extra };
}

async function errorOf(res: Response) {
  return ((await res.json()) as { error: { code: string; message: string; type: string } }).error;
}

describe("routing and methods", () => {
  it("GET /health needs no auth and leaks nothing", async () => {
    const res = await call(new Request("https://x/health"), streamingEnv([], { SNOWY_API_KEY: undefined }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
  it("404 for unknown routes, 405 for wrong methods", async () => {
    const env = streamingEnv([]);
    expect((await call(new Request("https://x/v1/chat/completions", { method: "POST" }), env)).status).toBe(404);
    const res = await call(new Request("https://x/v1/responses"), env);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });
});

describe("authentication", () => {
  it("rejects a missing Authorization header", async () => {
    const res = await call(post(basicBody(), { auth: null }), streamingEnv(textChunks("x")));
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("missing_api_key");
  });
  it("rejects an incorrect token", async () => {
    const res = await call(post(basicBody(), { auth: `Bearer ${API_KEY}x` }), streamingEnv(textChunks("x")));
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("invalid_api_key");
  });
  it("rejects malformed headers (wrong scheme, empty token)", async () => {
    for (const auth of [`Basic ${API_KEY}`, "Bearer ", "Bearer", API_KEY]) {
      const res = await call(post(basicBody(), { auth }), streamingEnv(textChunks("x")));
      expect(res.status).toBe(401);
    }
  });
  it("rejects everything when the server secret is missing or empty (no empty-token bypass)", async () => {
    for (const secret of [undefined, "", "   "]) {
      const env = streamingEnv(textChunks("x"), { SNOWY_API_KEY: secret as string });
      // Fails closed before even looking at the header.
      for (const auth of [null, "Bearer ", `Bearer ${secret ?? ""}`, `Bearer ${API_KEY}`]) {
        const res = await call(post(basicBody(), { auth }), env);
        expect(res.status).toBe(500);
      }
      const ok = await call(post(basicBody()), env);
      expect(ok.status).toBe(500);
      const err = await errorOf(ok);
      expect(err.code).toBe("server_misconfigured");
      expect(JSON.stringify(err)).not.toContain(API_KEY);
      expect(env.calls).toHaveLength(0);
    }
  });
  it("accepts the valid token", async () => {
    const res = await call(post(basicBody()), streamingEnv(textChunks("hello")));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });
  it("protects /v1/models too", async () => {
    const res = await call(new Request("https://x/v1/models"), streamingEnv([]));
    expect(res.status).toBe(401);
  });
});

describe("abuse protection", () => {
  it("returns 429 with Retry-After when the rate limiter denies", async () => {
    const env = streamingEnv(textChunks("x"), { RATE_LIMITER: { limit: async () => ({ success: false }) } });
    const res = await call(post(basicBody()), env);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(env.calls).toHaveLength(0);
  });
  it("rejects oversized bodies with 413 (declared and streamed)", async () => {
    const env = streamingEnv(textChunks("x"), { MAX_BODY_BYTES: "1000" });
    const big = basicBody({ input: "a".repeat(5000) });
    expect((await call(post(big), env)).status).toBe(413);
    const chunked = new Request("https://x/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(JSON.stringify(big)));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect((await call(chunked, env)).status).toBe(413);
    expect(env.calls).toHaveLength(0);
  });
  it("rejects non-JSON content types and compressed bodies", async () => {
    const env = streamingEnv(textChunks("x"));
    expect((await call(post(basicBody(), { headers: { "Content-Type": "text/plain" } }), env)).status).toBe(415);
    expect((await call(post(basicBody(), { headers: { "Content-Encoding": "zstd" } }), env)).status).toBe(415);
  });
});

describe("request validation", () => {
  it("400 on malformed JSON", async () => {
    const res = await call(post("{not json"), streamingEnv([]));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("invalid_json");
  });
  it("400 on missing or invalid input", async () => {
    for (const input of [undefined, 42, [], [{ type: "message", role: "assistant", content: "only assistant" }], [{ type: "bogus_item" }]]) {
      const res = await call(post({ model: DEFAULT, input }), streamingEnv([]));
      expect(res.status).toBe(400);
    }
  });
  it("400 on unsupported model without calling Workers AI (cost guard)", async () => {
    const env = streamingEnv(textChunks("x"));
    for (const model of ["@cf/zai-org/glm-5.3", "gpt-5", "@cf/meta/llama-3.2-1b-instruct", 123]) {
      const res = await call(post(basicBody({ model })), env);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toMatch(/model_not_supported|invalid_request/);
    }
    expect(env.calls).toHaveLength(0);
  });
  it("uses DEFAULT_MODEL when model is omitted, never silently substitutes otherwise", async () => {
    const env = streamingEnv(textChunks("x"), { DEFAULT_MODEL: "@cf/openai/gpt-oss-20b" });
    const body = basicBody();
    delete (body as { model?: string }).model;
    expect((await call(post(body), env)).status).toBe(200);
    expect(env.calls[0]?.model).toBe("@cf/openai/gpt-oss-20b");
  });
  it("rejects previous_response_id (stateless) and unknown text formats", async () => {
    expect((await call(post(basicBody({ previous_response_id: "resp_1" })), streamingEnv([]))).status).toBe(400);
    expect((await call(post(basicBody({ text: { format: { type: "xml" } } })), streamingEnv([]))).status).toBe(400);
  });

  it("structured output runs non-streaming upstream and is replayed as (simulated) SSE", async () => {
    const env = fakeEnv(async () => ({
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: '{"title":"Fix calc"}', reasoning: "short" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
    }));
    const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
    const res = await call(post(basicBody({ text: { format: { type: "json_schema", name: "title", strict: true, schema } } })), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Snowy-Streaming")).toBe("simulated");
    expect(env.calls[0]?.inputs).toMatchObject({ stream: false, response_format: { type: "json_schema", json_schema: { name: "title", schema, strict: true } } });
    const events = parseSse(await res.text());
    expect(events.at(-1)?.event).toBe("response.completed");
    const out = (events.at(-1)!.data.response as { output: unknown[]; usage: { total_tokens: number } });
    expect(out.output).toEqual([
      expect.objectContaining({ type: "reasoning", content: [{ type: "reasoning_text", text: "short" }] }),
      expect.objectContaining({ type: "message", content: [expect.objectContaining({ text: '{"title":"Fix calc"}' })] }),
    ]);
    expect(out.usage.total_tokens).toBe(13);
  });
});

describe("supported models", () => {
  it("lists every registered model in OpenAI list format", async () => {
    const res = await call(new Request("https://x/v1/models", { headers: { Authorization: `Bearer ${API_KEY}` } }), streamingEnv([]));
    const body = (await res.json()) as { object: string; data: { id: string; object: string; reasoning_efforts: string[] }[] };
    expect(body.object).toBe("list");
    const now = new Date().toISOString().slice(0, 10);
    const active = MODELS.filter((m) => !m.sunset || now < m.sunset);
    expect(body.data.map((m) => m.id).sort()).toEqual(active.map((m) => m.id).sort());
    for (const m of body.data) expect(m.object).toBe("model");
  });

  for (const model of MODELS) {
    describe(model.id, () => {
      it("basic streamed inference sends the model id and an explicit max_tokens", async () => {
        const env = streamingEnv(textChunks("Hello from " + model.displayName));
        const res = await call(post(basicBody({ model: model.id })), env);
        if (model.sunset && new Date().toISOString().slice(0, 10) >= model.sunset) {
          expect(res.status).toBe(410);
          return;
        }
        expect(res.status).toBe(200);
        const events = parseSse(await res.text());
        expect(events.at(-1)?.event).toBe("response.completed");
        expect(env.calls[0]?.model).toBe(model.id);
        expect(env.calls[0]?.inputs.stream).toBe(true);
        expect(env.calls[0]?.inputs.max_tokens).toBe(model.defaultMaxOutputTokens);
      });

      it("tool calling round-trips into a function_call item", async () => {
        if (model.sunset && new Date().toISOString().slice(0, 10) >= model.sunset) return;
        const env = streamingEnv(toolChunks("exec_command", '{"cmd":"ls"}', "call_x1"));
        const res = await call(
          post(basicBody({ model: model.id, tools: [{ type: "function", name: "exec_command", description: "run", parameters: { type: "object", properties: { cmd: { type: "string" } } } }] })),
          env,
        );
        const done = parseSse(await res.text()).find((e) => e.event === "response.output_item.done" && (e.data.item as { type: string }).type === "function_call");
        expect(done?.data.item).toMatchObject({ name: "exec_command", call_id: "call_x1", arguments: '{"cmd":"ls"}' });
        expect(env.calls[0]?.inputs.tools).toEqual([
          { type: "function", function: { name: "exec_command", description: "run", parameters: { type: "object", properties: { cmd: { type: "string" } } } } },
        ]);
      });

      it("validates reasoning effort against the model's documented levels", async () => {
        if (model.sunset && new Date().toISOString().slice(0, 10) >= model.sunset) return;
        const supported = supportedEfforts(model);
        for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
          const env = streamingEnv(textChunks("ok"));
          const res = await call(post(basicBody({ model: model.id, reasoning: { effort, summary: "auto" } })), env);
          if (model.reasoning === null) {
            // Not applicable: accepted, nothing reasoning-related sent upstream, reported in header.
            expect(res.status).toBe(200);
            expect(res.headers.get("X-Snowy-Reasoning-Ignored")).toContain(effort);
            expect(env.calls[0]?.inputs).not.toHaveProperty("reasoning_effort");
            expect(env.calls[0]?.inputs).not.toHaveProperty("chat_template_kwargs");
          } else if (supported.includes(effort as never)) {
            expect(res.status).toBe(200);
            const expected = model.reasoning.efforts[effort as keyof typeof model.reasoning.efforts]!;
            for (const [k, v] of Object.entries(expected)) expect(env.calls[0]?.inputs[k]).toMatchObject(v as object);
          } else {
            expect(res.status).toBe(400);
            expect((await errorOf(res)).code).toBe("unsupported_reasoning_effort");
            expect(env.calls).toHaveLength(0);
          }
        }
      });
    });
  }

  it("shrinks max_tokens so prompt + output fits the context window", async () => {
    const env = streamingEnv(textChunks("ok"));
    // ~60k bytes ≈ 20k estimated tokens on a 24k-context model (default max 4096).
    await call(post(basicBody({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", input: "x ".repeat(30_000) })), env);
    const max = env.calls[0]?.inputs.max_tokens as number;
    expect(max).toBeLessThan(4096);
    expect(max).toBeGreaterThanOrEqual(1024);
  });

  it("omitted effort sends no reasoning parameter (model default applies)", async () => {
    const env = streamingEnv(textChunks("ok"));
    await call(post(basicBody({ model: "@cf/openai/gpt-oss-120b", reasoning: { summary: "auto" } })), env);
    expect(env.calls[0]?.inputs).not.toHaveProperty("reasoning_effort");
  });
  it("rejects nonsense effort values", async () => {
    const res = await call(post(basicBody({ model: "@cf/openai/gpt-oss-20b", reasoning: { effort: "turbo" } })), streamingEnv([]));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("invalid_reasoning_effort");
  });
});

describe("Codex conversation translation", () => {
  const codexTurn2 = {
    model: "@cf/openai/gpt-oss-20b",
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "019a-thread-uuid",
    reasoning: { effort: "low", summary: "auto" },
    tools: [
      { type: "function", name: "exec_command", description: "Run", strict: false, parameters: { type: "object", properties: { cmd: { type: "string" } } } },
      { type: "namespace", name: "multi_agent_v1", description: "agents", tools: [{ type: "function", name: "spawn_agent", description: "spawn", parameters: { type: "object", properties: {} } }] },
      { type: "custom", name: "apply_patch", description: "Patch files", format: { type: "grammar", syntax: "lark", definition: "start: x" } },
      { type: "web_search", external_web_access: false },
    ],
    input: [
      { type: "message", id: "msg_1", role: "developer", content: [{ type: "input_text", text: "You are Codex." }] },
      { type: "message", id: "msg_2", role: "user", content: [{ type: "input_text", text: "<environment_context/>" }] },
      { type: "message", id: "msg_3", role: "user", content: [{ type: "input_text", text: "List files" }] },
      { type: "reasoning", id: "rs_1", summary: [], content: [{ type: "reasoning_text", text: "Need ls." }], encrypted_content: "" },
      { type: "function_call", id: "fc_1", name: "exec_command", arguments: '{"cmd":"ls"}', call_id: "call_1" },
      { type: "function_call_output", id: "fco_1", call_id: "call_1", output: "README.md\nsrc\n" },
      { type: "function_call", name: "spawn_agent", namespace: "multi_agent_v1", arguments: "{}", call_id: "call_2" },
      { type: "function_call_output", call_id: "call_2", output: [{ type: "input_text", text: "agent started" }] },
      { type: "custom_tool_call", name: "apply_patch", call_id: "call_3", input: "*** Begin Patch\n*** End Patch" },
      { type: "custom_tool_call_output", call_id: "call_3", output: "Done!" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Files: README.md, src" }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Approval policy changed." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Thanks" }] },
    ],
  };

  it("converts the full multi-turn Codex history into chat messages without losing items", async () => {
    const env = streamingEnv(textChunks("You're welcome"));
    const res = await call(post(codexTurn2), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Snowy-Dropped-Tools")).toBe("web_search");
    const inputs = env.calls[0]!.inputs;
    expect(inputs.reasoning_effort).toBe("low");
    expect(env.calls[0]!.options).toMatchObject({ extraHeaders: { "x-session-affinity": "019a-thread-uuid" } });
    expect(inputs.messages).toEqual([
      { role: "system", content: "You are Codex." },
      { role: "user", content: "<environment_context/>\n\nList files" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "Need ls.",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "exec_command", arguments: '{"cmd":"ls"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "README.md\nsrc\n" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_2", type: "function", function: { name: "multi_agent_v1__spawn_agent", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_2", content: "agent started" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_3", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }) } }] },
      { role: "tool", tool_call_id: "call_3", content: "Done!" },
      { role: "assistant", content: "Files: README.md, src" },
      { role: "user", content: "<developer_message>\nApproval policy changed.\n</developer_message>\n\nThanks" },
    ]);
    const toolNames = (inputs.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(toolNames).toEqual(["exec_command", "multi_agent_v1__spawn_agent", "apply_patch"]);
  });

  it("restores namespace on namespaced tool calls", async () => {
    const env = streamingEnv(toolChunks("multi_agent_v1__spawn_agent", '{"task":"x"}'));
    const events = parseSse(await (await call(post(codexTurn2), env)).text());
    const done = events.find((e) => e.event === "response.output_item.done" && (e.data.item as { type: string }).type === "function_call");
    expect(done?.data.item).toMatchObject({ name: "spawn_agent", namespace: "multi_agent_v1", arguments: '{"task":"x"}' });
  });

  it("answers orphaned tool calls so chat templates stay valid", async () => {
    const env = streamingEnv(textChunks("ok"));
    await call(
      post(
        basicBody({
          input: [
            { type: "message", role: "user", content: "go" },
            { type: "function_call", name: "exec_command", arguments: "{}", call_id: "c9" },
            { type: "message", role: "user", content: "stop, do something else" },
          ],
        }),
      ),
      env,
    );
    const msgs = env.calls[0]!.inputs.messages as { role: string; tool_call_id?: string }[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(msgs[2]?.tool_call_id).toBe("c9");
  });

  it("keeps text emitted after a tool call in the same assistant turn", async () => {
    const env = streamingEnv(textChunks("ok"));
    await call(
      post(
        basicBody({
          input: [
            { type: "message", role: "user", content: "go" },
            { type: "function_call", name: "exec_command", arguments: "{}", call_id: "c1" },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "running it" }] },
            { type: "function_call_output", call_id: "c1", output: "done" },
          ],
        }),
      ),
      env,
    );
    expect(env.calls[0]!.inputs.messages).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "running it", tool_calls: [{ id: "c1", type: "function", function: { name: "exec_command", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "done" },
    ]);
  });

  it("returns a JSON Response object when stream=false", async () => {
    const res = await call(post(basicBody({ stream: false })), streamingEnv(textChunks("Plain answer", "hmm")));
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as { object: string; status: string; output: { type: string }[]; usage: { total_tokens: number } };
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.output.map((o) => o.type)).toEqual(["reasoning", "message"]);
    expect(body.usage.total_tokens).toBe(15);
  });
});

describe("provider errors", () => {
  const throwing = (message: string) => fakeEnv(async () => {
    const e = new Error(message);
    e.name = "AiError";
    throw e;
  });
  const cases: [string, number, string][] = [
    ["3036: You have used up your daily free allocation of 10,000 neurons.", 429, "insufficient_quota"],
    ["3040: Capacity temporarily exceeded, please try again.", 503, "server_is_overloaded"],
    ["5035: Model is not available on the Workers Free plan.", 403, "model_requires_paid_plan"],
    ["5028: model was deprecated", 410, "model_retired"],
    ["8001: Invalid input", 400, "upstream_invalid_input"],
    ["5006: Error: oneOf at '/' not met, 0 matches", 400, "upstream_invalid_input"],
    ["This model's maximum context length is 131072 tokens", 400, "context_length_exceeded"],
    ["something exploded", 502, "upstream_error"],
  ];
  for (const [message, status, code] of cases) {
    it(`maps "${message.slice(0, 30)}" to ${status} ${code}`, async () => {
      const res = await call(post(basicBody()), throwing(message));
      expect(res.status).toBe(status);
      const err = await errorOf(res);
      expect(err.code).toBe(code);
      expect(JSON.stringify(err)).not.toMatch(/at \w+ \(|\.ts:\d+/); // no stack traces
    });
  }

  it("mid-stream upstream failure becomes response.failed", async () => {
    const env = fakeEnv(async () => upstreamSse([{ choices: [{ index: 0, delta: { content: "par" } }] }, { error: { message: "inference crashed" } }]));
    const events = parseSse(await (await call(post(basicBody()), env)).text());
    expect(events.at(-1)?.event).toBe("response.failed");
  });

  it("client cancellation aborts the upstream stream", async () => {
    let cancelled = false;
    const env = fakeEnv(async () =>
      new ReadableStream<Uint8Array>({
        pull(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\n'));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const res = await call(post(basicBody()), env);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(cancelled).toBe(true);
  });
});
