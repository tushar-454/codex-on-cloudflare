/**
 * Model registry: the ONLY models SNOWy will forward to Workers AI.
 *
 * Free-plan entries were checked against the Cloudflare docs (2026-11-17) AND a live
 * env.AI.run() call on a Workers Free account. Paid-only entries (`requiresPaid`,
 * error 5035 on Free) come from the Workers AI model catalog API (2026-11-17:
 * require_workers_paid, context_window, reasoning_effort, price) and are only listed
 * and accepted when the Worker runs with WORKERS_PLAN="paid" (setup.sh detects the
 * plan and sets it). To add/remove a model, edit MODELS below; nothing else needs to
 * change.
 *
 * Reasoning effort: `efforts` maps each *accepted* OpenAI effort value to the exact
 * upstream parameters for that model. Values not listed are rejected with HTTP 400 –
 * we never silently remap an unsupported effort to a different level. When the
 * request omits effort, nothing is sent and the model's documented default applies.
 * Models with `reasoning: null` have no reasoning at all: an effort in the request is
 * not applicable, is never sent upstream, and the response reports `effort: null`.
 */

export type Category = "Coding" | "Reasoning" | "General" | "Fast";
export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const ALL_EFFORTS: readonly Effort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];

/** Upstream request fields merged into the env.AI.run() input for a given effort. */
export type UpstreamParams = Record<string, unknown>;

export interface ReasoningSpec {
  /** How reasoning is controlled upstream (documentation only). */
  control: "reasoning_effort" | "enable_thinking";
  /** Effort that matches the model's documented default (what happens when none is sent). */
  defaultEffort: Effort;
  /** Human-readable description of the default. */
  defaultBehavior: string;
  efforts: Partial<Record<Effort, UpstreamParams>>;
}

export type CodexStatus =
  /** Multi-turn Codex tool loop verified live with real Codex CLI. */
  | "verified"
  /** Streaming + tool-call round trip verified live via the binding; not run under real Codex. */
  | "compatible"
  /** Works, but a hard limit (e.g. small context) makes real Codex sessions unreliable. */
  | "limited"
  /** Paid-only: request format matches the catalog schema, not yet run live through SNOWy. */
  | "untested";

/** Cloudflare Workers plan of the account the Worker runs on (wrangler var WORKERS_PLAN). */
export type Plan = "free" | "paid";

/** Anything other than an explicit "paid" is treated as Free (fail closed: no paid models). */
export function parsePlan(value: unknown): Plan {
  return typeof value === "string" && value.trim().toLowerCase() === "paid" ? "paid" : "free";
}

export interface ModelSpec {
  id: string;
  displayName: string;
  category: Category;
  contextWindow: number;
  /** max_tokens sent upstream when the client doesn't cap output (old schemas default to 256!). */
  defaultMaxOutputTokens: number;
  functionCalling: boolean;
  streaming: boolean;
  /** Accepts image inputs (image_url parts). */
  vision: boolean;
  reasoning: ReasoningSpec | null;
  /** Live env.AI.run() call succeeded on a Workers Free account. */
  freePlanVerified: boolean;
  /** Workers Paid plan only (Workers AI error 5035 on Free). */
  requiresPaid?: boolean;
  codex: CodexStatus;
  /** Neurons per 1M tokens, from the pricing page (cost guard / docs). */
  neurons: { inputPerM: number; outputPerM: number };
  /** Always merged into the upstream request (before effort params). */
  baseParams?: UpstreamParams;
  /** ISO date Cloudflare stops serving the model (HTTP 410 / error 5028). */
  sunset?: string;
  notes?: string;
}

const GPT_OSS_REASONING: ReasoningSpec = {
  control: "reasoning_effort",
  defaultEffort: "medium",
  defaultBehavior: "medium (reasoning cannot be disabled)",
  efforts: {
    low: { reasoning_effort: "low" },
    medium: { reasoning_effort: "medium" },
    high: { reasoning_effort: "high" },
  },
};

/**
 * Models whose only reasoning control is chat_template_kwargs.enable_thinking (on by
 * default). They have no graded levels, so exactly two efforts are accepted:
 * "none" = thinking off, "high" = thinking on (the model's documented default, the same
 * convention Cloudflare documents for on/off reasoning models such as Kimi K2.6).
 * low/medium/xhigh are rejected rather than silently treated as on or off.
 */
const THINKING_TOGGLE: ReasoningSpec = {
  control: "enable_thinking",
  defaultEffort: "high",
  defaultBehavior: "high (thinking enabled)",
  efforts: {
    none: { chat_template_kwargs: { enable_thinking: false } },
    high: { chat_template_kwargs: { enable_thinking: true } },
  },
};

/**
 * Catalog reasoning_effort levels max/high/low[/none]. Codex has no "max", so its top
 * level "xhigh" sends "max" explicitly; "medium"/"minimal" are not offered because the
 * catalog only aliases them to another level.
 */
function maxHighLow(opts: { none: boolean; defaultEffort: Effort; defaultBehavior: string }): ReasoningSpec {
  return {
    control: "reasoning_effort",
    defaultEffort: opts.defaultEffort,
    defaultBehavior: opts.defaultBehavior,
    efforts: {
      ...(opts.none ? { none: { reasoning_effort: "none" } } : {}),
      low: { reasoning_effort: "low" },
      high: { reasoning_effort: "high" },
      xhigh: { reasoning_effort: "max" },
    },
  };
}

/** USD per 1M tokens -> Neurons per 1M tokens ($0.011 per 1,000 Neurons). */
const usd = (inputPerM: number, outputPerM: number) => ({
  inputPerM: Math.round((inputPerM / 0.011) * 1000),
  outputPerM: Math.round((outputPerM / 0.011) * 1000),
});

/** Workers Paid only. Listed before the free models when WORKERS_PLAN="paid". */
const PAID_MODELS: readonly ModelSpec[] = [
  {
    id: "@cf/zai-org/glm-5.3",
    displayName: "GLM-5.3",
    category: "Coding",
    contextWindow: 1_048_576,
    defaultMaxOutputTokens: 32_768,
    functionCalling: true,
    streaming: true,
    vision: false,
    reasoning: maxHighLow({ none: false, defaultEffort: "xhigh", defaultBehavior: "max (reasoning cannot be disabled)" }),
    freePlanVerified: false,
    requiresPaid: true,
    codex: "untested",
    neurons: usd(1.4, 4.4),
    notes: "Z.ai flagship agentic coding model, 1M context. $1.40 / $4.40 per M tokens in/out.",
  },
  {
    id: "@cf/deepseek-ai/deepseek-v4-pro-0813",
    displayName: "DeepSeek V4 Pro",
    category: "Reasoning",
    contextWindow: 1_048_576,
    defaultMaxOutputTokens: 32_768,
    functionCalling: true,
    streaming: true,
    vision: false,
    reasoning: maxHighLow({ none: true, defaultEffort: "high", defaultBehavior: "high" }),
    freePlanVerified: false,
    requiresPaid: true,
    codex: "untested",
    neurons: usd(1.32, 3.96),
    sunset: "2026-11-20",
    notes: "Cloudflare retires this model on 2026-11-20. $1.32 / $3.96 per M tokens in/out.",
  },
  {
    id: "@cf/moonshotai/kimi-k2.7-code",
    displayName: "Kimi K2.7 Code",
    category: "Coding",
    contextWindow: 262_144,
    defaultMaxOutputTokens: 32_768,
    functionCalling: true,
    streaming: true,
    vision: true,
    // Reasoning is mandatory and has no effort parameter: only the default level exists.
    reasoning: { control: "enable_thinking", defaultEffort: "high", defaultBehavior: "high (always on)", efforts: { high: {} } },
    freePlanVerified: false,
    requiresPaid: true,
    codex: "untested",
    neurons: usd(0.95, 4),
    sunset: "2026-11-20",
    notes: "Cloudflare retires this model on 2026-11-20. $0.95 / $4.00 per M tokens in/out.",
  },
  {
    id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
    displayName: "DeepSeek V4.1 Flash",
    category: "Coding",
    contextWindow: 1_048_576,
    defaultMaxOutputTokens: 32_768,
    functionCalling: true,
    streaming: true,
    vision: true,
    reasoning: maxHighLow({ none: true, defaultEffort: "high", defaultBehavior: "high" }),
    freePlanVerified: false,
    requiresPaid: true,
    codex: "untested",
    neurons: usd(0.3, 1.2),
    notes: "Cheapest paid frontier model, 1M context. $0.30 / $1.20 per M tokens in/out.",
  },
  {
    id: "@cf/thinkingmachines/inkling-2-small",
    displayName: "Inkling 2 Small",
    category: "General",
    contextWindow: 1_048_576,
    defaultMaxOutputTokens: 32_768,
    functionCalling: true,
    streaming: true,
    vision: true,
    reasoning: {
      control: "reasoning_effort",
      defaultEffort: "high",
      defaultBehavior: "high",
      efforts: {
        none: { reasoning_effort: "none" },
        minimal: { reasoning_effort: "minimal" },
        low: { reasoning_effort: "low" },
        medium: { reasoning_effort: "medium" },
        high: { reasoning_effort: "high" },
        xhigh: { reasoning_effort: "max" },
      },
    },
    freePlanVerified: false,
    requiresPaid: true,
    codex: "untested",
    neurons: usd(0.3, 1),
    notes: "594B MoE, 1M context. $0.30 / $1.00 per M tokens in/out.",
  },
];

const FREE_MODELS: readonly ModelSpec[] = [
  {
    id: "@cf/zai-org/glm-4.7-flash",
    displayName: "GLM-4.7 Flash",
    category: "Coding",
    contextWindow: 131_072,
    defaultMaxOutputTokens: 16_384,
    functionCalling: true,
    streaming: true,
    vision: false,
    reasoning: THINKING_TOGGLE,
    freePlanVerified: true,
    codex: "verified",
    neurons: { inputPerM: 5_500, outputPerM: 36_400 },
    notes: "Codex CLI 0.169: text, file reads, shell, approvals, apply_patch edits, multi-turn. Cheapest verified model.",
  },
  {
    id: "@cf/openai/gpt-oss-120b",
    displayName: "GPT-OSS 120B",
    category: "Reasoning",
    contextWindow: 128_000,
    defaultMaxOutputTokens: 16_384,
    functionCalling: true,
    streaming: true,
    vision: false,
    reasoning: GPT_OSS_REASONING,
    freePlanVerified: true,
    codex: "verified",
    neurons: { inputPerM: 31_818, outputPerM: 68_182 },
    notes: "Codex CLI 0.169: multi-turn tool loop incl. switching from GPT-OSS 20B mid-thread, effort low/medium/high.",
  },
  {
    id: "@cf/openai/gpt-oss-20b",
    displayName: "GPT-OSS 20B",
    category: "Reasoning",
    contextWindow: 128_000,
    defaultMaxOutputTokens: 16_384,
    functionCalling: true,
    streaming: true,
    vision: false,
    reasoning: GPT_OSS_REASONING,
    freePlanVerified: true,
    codex: "limited",
    neurons: { inputPerM: 18_182, outputPerM: 27_273 },
    notes: "Tool calls with Codex's full prompt intermittently arrive inside the reasoning channel (Workers AI harmony parsing), ending the turn with no action. Simple tool loops work.",
  },
  {
    id: "@cf/qwen/qwen3.8-27b",
    displayName: "Qwen 3.8 27B",
    category: "Coding",
    contextWindow: 262_144,
    defaultMaxOutputTokens: 16_384,
    functionCalling: true,
    streaming: true,
    vision: true,
    reasoning: {
      control: "reasoning_effort",
      defaultEffort: "xhigh",
      defaultBehavior: "xhigh",
      efforts: {
        low: { reasoning_effort: "low" },
        medium: { reasoning_effort: "medium" },
        xhigh: { reasoning_effort: "xhigh" },
      },
    },
    freePlanVerified: true,
    codex: "compatible",
    neurons: { inputPerM: 40_909, outputPerM: 290_909 },
    notes: "Highest Neuron cost per output token of the free models.",
  },
  {
    id: "@cf/google/gemma-4-26b-a4b-it",
    displayName: "Gemma 4 26B A4B",
    category: "General",
    contextWindow: 256_000,
    defaultMaxOutputTokens: 16_384,
    functionCalling: true,
    streaming: true,
    vision: true,
    reasoning: THINKING_TOGGLE,
    freePlanVerified: true,
    codex: "verified",
    neurons: { inputPerM: 9_091, outputPerM: 27_273 },
    notes: "Codex CLI 0.169: read -> apply_patch edit -> verify, first try; prefix cache hits observed.",
  },
  {
    id: "@cf/mistralai/mistral-small-3.1-24b-instruct",
    displayName: "Mistral Small 3.1 24B",
    category: "General",
    contextWindow: 128_000,
    defaultMaxOutputTokens: 8_192,
    functionCalling: true,
    streaming: true,
    vision: false,
    reasoning: null,
    freePlanVerified: true,
    codex: "compatible",
    neurons: { inputPerM: 31_876, outputPerM: 50_488 },
  },
  {
    id: "@cf/meta/llama-4-scout-17b-16e-instruct",
    displayName: "Llama 4 Scout 17B",
    category: "General",
    contextWindow: 131_000,
    defaultMaxOutputTokens: 8_192,
    functionCalling: true,
    streaming: true,
    vision: true,
    reasoning: null,
    freePlanVerified: true,
    codex: "compatible",
    neurons: { inputPerM: 24_545, outputPerM: 77_273 },
  },
  {
    id: "@cf/ibm-granite/granite-4.0-h-micro",
    displayName: "Granite 4.0 H Micro",
    category: "Fast",
    contextWindow: 131_000,
    defaultMaxOutputTokens: 8_192,
    functionCalling: true,
    streaming: true,
    vision: false,
    reasoning: null,
    freePlanVerified: true,
    codex: "limited",
    neurons: { inputPerM: 1_542, outputPerM: 10_158 },
    notes: "Tool calls work, but in a real Codex edit task it never edited the file and claimed success. Use for simple chat only.",
  },
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    displayName: "Llama 3.3 70B FP8 Fast",
    category: "General",
    contextWindow: 24_000,
    defaultMaxOutputTokens: 4_096,
    functionCalling: true,
    streaming: true,
    vision: false,
    reasoning: null,
    freePlanVerified: true,
    codex: "limited",
    neurons: { inputPerM: 26_668, outputPerM: 204_805 },
    notes: "24k context: Codex's prompt + tool schemas alone use ~8-12k tokens, so sessions hit the limit after a few tool calls.",
  },
  {
    id: "@cf/nvidia/nemotron-3-120b-a12b",
    displayName: "Nemotron 3 120B A12B",
    category: "Reasoning",
    contextWindow: 256_000,
    defaultMaxOutputTokens: 16_384,
    functionCalling: true,
    streaming: true,
    vision: false,
    reasoning: {
      control: "enable_thinking",
      // Documented modes: off / low / normal (default). "high" = normal, as for THINKING_TOGGLE.
      defaultEffort: "high",
      defaultBehavior: "high (normal thinking)",
      efforts: {
        none: { chat_template_kwargs: { enable_thinking: false } },
        low: { chat_template_kwargs: { enable_thinking: true, low_effort: true } },
        high: { chat_template_kwargs: { enable_thinking: true } },
      },
    },
    // Model page: "For coding agents, set force_nonempty_content to True".
    baseParams: { chat_template_kwargs: { force_nonempty_content: true } },
    freePlanVerified: true,
    codex: "compatible",
    neurons: { inputPerM: 45_455, outputPerM: 136_364 },
    sunset: "2026-11-20",
    notes: "Cloudflare retires this model on 2026-11-20 (HTTP 410). Most expensive free model.",
  },
];

/** Every registered model (paid first). Use modelsForPlan() for what a deployment serves. */
export const MODELS: readonly ModelSpec[] = [...PAID_MODELS, ...FREE_MODELS];

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));

/** True when the model can run on an account with this plan. */
export function availableOnPlan(model: ModelSpec, plan: Plan): boolean {
  return plan === "paid" || model.requiresPaid !== true;
}

/** Models served on this plan, not yet retired: paid models first, then the free ones. */
export function modelsForPlan(plan: Plan, now: Date = new Date()): ModelSpec[] {
  return MODELS.filter((m) => availableOnPlan(m, plan) && !isSunset(m, now));
}

export function findModel(id: string): ModelSpec | undefined {
  return BY_ID.get(id);
}

/** True once the model's announced retirement date has passed (UTC). */
export function isSunset(model: ModelSpec, now: Date = new Date()): boolean {
  return model.sunset !== undefined && now.toISOString().slice(0, 10) >= model.sunset;
}

export function supportedEfforts(model: ModelSpec): Effort[] {
  return ALL_EFFORTS.filter((e) => model.reasoning?.efforts[e] !== undefined);
}
