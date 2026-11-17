/**
 * Live integration test against a running SNOWy (local `pnpm dev` or deployed).
 * Spends real Neurons (roughly 15-40 per model with the tiny prompts below).
 *
 *   SNOWY_URL=http://127.0.0.1:8787 SNOWY_API_KEY=... pnpm test:live [model-id ...]
 */

export {};

const BASE = (process.env.SNOWY_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const KEY = process.env.SNOWY_API_KEY ?? "";
if (KEY === "") {
  console.error("Set SNOWY_API_KEY");
  process.exit(2);
}

interface ModelInfo {
  id: string;
  reasoning_efforts: string[];
  reasoning: boolean;
  codex_compatibility: string;
}
interface SseEvent {
  type: string;
  [k: string]: unknown;
}

const TOOL = {
  type: "function",
  name: "exec_command",
  description: "Run a shell command and return its output.",
  strict: false,
  parameters: { type: "object", properties: { cmd: { type: "string", description: "Shell command" } }, required: ["cmd"] },
};

async function responses(body: unknown): Promise<{ status: number; events: SseEvent[]; raw: string }> {
  const res = await fetch(`${BASE}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  const events = raw
    .split("\n\n")
    .map((b) => b.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => l !== undefined)
    .map((l) => JSON.parse(l.slice(6)) as SseEvent);
  return { status: res.status, events, raw };
}

function terminal(events: SseEvent[]) {
  return events.at(-1) as (SseEvent & { response?: { status: string; output: { type: string; [k: string]: unknown }[]; usage: unknown } }) | undefined;
}

function checkOrdering(events: SseEvent[]): string | null {
  if (events[0]?.type !== "response.created") return "first event is not response.created";
  const seqs = events.map((e) => e.sequence_number as number);
  if (seqs.some((s, i) => s !== i)) return "sequence_number not contiguous";
  const open = new Set<number>();
  for (const e of events) {
    if (e.type === "response.output_item.added") open.add(e.output_index as number);
    if (e.type.endsWith(".delta") && e.output_index !== undefined && !open.has(e.output_index as number)) return `${e.type} before output_item.added`;
    if (e.type === "response.output_item.done") open.delete(e.output_index as number);
  }
  if (open.size > 0) return "output items left open";
  return null;
}

const user = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const dev = { type: "message", role: "developer", content: [{ type: "input_text", text: "You are a coding agent. Use tools when asked." }] };

async function testModel(m: ModelInfo): Promise<Record<string, string>> {
  const r: Record<string, string> = {};
  const t0 = Date.now();

  // 1. basic text
  const basic = await responses({ model: m.id, stream: true, input: [dev, user("Reply with exactly: pong")] });
  const bt = terminal(basic.events);
  const text = basic.events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
  r.basic = basic.status === 200 && bt?.type === "response.completed" && /pong/i.test(text) ? "PASS" : `FAIL(${basic.status} ${bt?.type} ${JSON.stringify(text).slice(0, 60)} ${basic.raw.slice(0, 200)})`;
  r.sse = checkOrdering(basic.events) ?? "PASS";

  // 2. tool call
  const tc = await responses({ model: m.id, stream: true, tools: [TOOL], input: [dev, user("Use exec_command to run `cat README.md`. Do not answer without calling the tool.")] });
  const call = terminal(tc.events)?.response?.output.find((o) => o.type === "function_call") as { call_id: string; name: string; arguments: string } | undefined;
  let argsOk = false;
  try {
    argsOk = call !== undefined && typeof JSON.parse(call.arguments) === "object";
  } catch {
    argsOk = false;
  }
  r.tool_call = call?.name === "exec_command" && argsOk ? "PASS" : `FAIL(${tc.status} ${tc.raw.slice(0, 200)})`;
  const toolOrdering = checkOrdering(tc.events);
  if (toolOrdering) r.sse = `FAIL(tool: ${toolOrdering})`;

  // 3. tool round trip
  if (call) {
    const rt = await responses({
      model: m.id,
      stream: true,
      tools: [TOOL],
      input: [
        dev,
        user("Use exec_command to run `cat README.md`, then tell me the codename."),
        { type: "function_call", call_id: call.call_id, name: "exec_command", arguments: call.arguments },
        { type: "function_call_output", call_id: call.call_id, output: "# Demo\nCodename: AURORA-FALCON-77\n" },
      ],
    });
    const out = rt.events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
    r.round_trip = /AURORA.FALCON.77/.test(out) ? "PASS" : `FAIL(${rt.status} ${JSON.stringify(out).slice(0, 80)} ${rt.raw.slice(0, 160)})`;
  } else {
    r.round_trip = "SKIP(no tool call)";
  }

  // 4. reasoning effort validation (no inference cost for rejected values)
  const all = ["none", "minimal", "low", "medium", "high", "xhigh"];
  const unsupported = m.reasoning ? all.filter((e) => !m.reasoning_efforts.includes(e)) : [];
  const bad = unsupported.length > 0 ? await responses({ model: m.id, stream: true, reasoning: { effort: unsupported[0] }, input: [user("hi")] }) : null;
  r.effort_validation = bad === null || bad.status === 400 ? "PASS" : `FAIL(${bad.status})`;
  if (m.reasoning_efforts.length > 0) {
    const effort = m.reasoning_efforts[0];
    const ok = await responses({ model: m.id, stream: true, reasoning: { effort }, input: [user("Reply with exactly: ok")] });
    r.effort_validation += ok.status === 200 && terminal(ok.events)?.type === "response.completed" ? ` +${effort}:PASS` : ` +${effort}:FAIL(${ok.status})`;
  }
  r.seconds = ((Date.now() - t0) / 1000).toFixed(1);
  return r;
}

const listRes = await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } });
if (listRes.status !== 200) {
  console.error(`GET /v1/models -> ${listRes.status}`);
  process.exit(1);
}
const models = ((await listRes.json()) as { data: ModelInfo[] }).data;
const only = process.argv.slice(2);
let failed = 0;
for (const m of models.filter((x) => only.length === 0 || only.includes(x.id))) {
  try {
    const r = await testModel(m);
    const bad = Object.entries(r).filter(([k, v]) => k !== "seconds" && !v.startsWith("PASS") && !v.startsWith("SKIP"));
    if (bad.length > 0 || Object.values(r).some((v) => v.includes("FAIL"))) failed++;
    console.log(JSON.stringify({ model: m.id, ...r }));
  } catch (err) {
    failed++;
    console.log(JSON.stringify({ model: m.id, error: String(err) }));
  }
}
process.exit(failed > 0 ? 1 : 0);
