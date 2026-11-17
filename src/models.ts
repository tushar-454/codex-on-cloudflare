/**
 * Model registry: the ONLY models SNOWy will forward to Workers AI.
 *
 * Every entry was checked against the Cloudflare docs (2026-11-17) AND a live
 * env.AI.run() call on a Workers Free account. To add/remove a model, edit MODELS
 * below; nothing else needs to change. Paid-only models (error 5035 on Free) must
 * not be added.
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
  | "limited";

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

export const MODELS: readonly ModelSpec[] = [
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

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));

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
