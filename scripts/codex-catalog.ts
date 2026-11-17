/**
 * Generate a Codex `model_catalog_json` file from the SNOWy model registry, so the
 * Cloudflare models appear in Codex's /model picker with correct context windows and
 * reasoning levels (instead of Codex's generic "fallback metadata").
 *
 *   node scripts/codex-catalog.ts [--out codex/snowy-models.json] [--codex-version 0.169.0]
 *                                 [--instructions-file path/to/prompt.md] [--plan free|paid]
 *
 * --plan paid adds the Workers Paid-only models at the top of /model (default: free).
 * It must match the Worker's WORKERS_PLAN, or Codex lists models the Worker rejects.
 *
 * Every catalog entry must carry base instructions. By default this script downloads
 * the exact prompt Codex itself uses for unknown/local models
 * (codex-rs/models-manager/prompt.md) from the openai/codex release tag matching your
 * installed `codex --version`, so agent behaviour is identical to the fallback.
 *
 * The catalog is only used by the `snowy` profile overlay; normal `codex` is unaffected.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { modelsForPlan, parsePlan, supportedEfforts, type Effort, type ModelSpec } from "../src/models.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const EFFORT_TEXT: Record<Effort, string> = {
  none: "Reasoning off",
  minimal: "Minimal reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balanced speed and reasoning depth",
  high: "Deeper reasoning",
  xhigh: "Maximum reasoning depth",
};

function effortDescription(model: ModelSpec, effort: Effort): string {
  if (model.reasoning?.control === "enable_thinking") {
    if (effort === "none") return "Thinking off (enable_thinking=false)";
    if (effort === "high") return "Thinking on (model default)";
    if (effort === "low") return "Low-effort thinking";
  }
  return EFFORT_TEXT[effort];
}

async function baseInstructions(): Promise<string> {
  const file = arg("instructions-file");
  if (file) return readFileSync(file, "utf8");
  let version = arg("codex-version");
  if (!version) {
    const out = execFileSync("codex", ["--version"], { encoding: "utf8" });
    version = /(\d+\.\d+\.\d+)/.exec(out)?.[1];
  }
  if (!version) throw new Error("Could not determine Codex version; pass --codex-version");
  const url = `https://raw.githubusercontent.com/openai/codex/rust-v${version}/codex-rs/models-manager/prompt.md`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}; pass --instructions-file instead`);
  console.error(`Using Codex ${version} base instructions from ${url}`);
  return res.text();
}

const instructions = await baseInstructions();
const planArg = arg("plan") ?? "free";
if (planArg !== "free" && planArg !== "paid") throw new Error(`--plan must be free or paid, got '${planArg}'`);
const plan = parsePlan(planArg);
const models = modelsForPlan(plan).filter((m) => m.functionCalling).map((m, i) => {
  const levels = supportedEfforts(m);
  return {
    slug: m.id,
    display_name: `${m.displayName} (Cloudflare${m.requiresPaid ? " Paid" : ""})`,
    description: `${m.category} · ${Math.round(m.contextWindow / 1000)}k context · ${m.neurons.inputPerM}/${m.neurons.outputPerM} neurons per M in/out${m.sunset ? ` · retires ${m.sunset}` : ""}`,
    default_reasoning_level: m.reasoning?.defaultEffort ?? null,
    supported_reasoning_levels: levels.map((effort) => ({ effort, description: effortDescription(m, effort) })),
    // Same tool surface Codex gives unknown models (exec_command / write_stdin) ...
    shell_type: "unified_exec",
    // ... plus a dedicated apply_patch tool (SNOWy converts this freeform tool to a function).
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    visibility: "list",
    supported_in_api: true,
    priority: i + 1,
    availability_nux: null,
    upgrade: null,
    supports_reasoning_summary_parameter: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: null,
    truncation_policy: { mode: "bytes", limit: 10_000 },
    context_window: m.contextWindow,
    // Leave room for max_tokens: Workers AI rejects prompt + max_tokens > context.
    auto_compact_token_limit: Math.floor(m.contextWindow * 0.8),
    experimental_supported_tools: [],
    input_modalities: m.vision ? ["text", "image"] : ["text"],
    base_instructions: instructions,
  };
});

const out = resolve(arg("out") ?? "codex/snowy-models.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ models }, null, 2)}\n`);
console.error(`Wrote ${models.length} models (${plan} plan) to ${out}`);
