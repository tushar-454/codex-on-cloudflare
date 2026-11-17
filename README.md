# SNOWy

SNOWy is a small Cloudflare Worker that lets the **unmodified OpenAI Codex CLI** use **Cloudflare Workers AI** models. Codex sees an OpenAI Responses API endpoint (`/v1/responses`, streaming SSE). The Worker sends each request to Workers AI through the `env.AI` binding.

You keep Codex's tools, sandbox, approvals and sessions. Commands and file edits still run locally in Codex; the Worker only runs inference. Plain `codex` keeps using your normal OpenAI provider and model. Cloudflare models are used only when you start Codex with `--profile snowy` (or the `snowy` shell function).

```
Codex CLI ──(Responses API + SSE, Bearer SNOWY_API_KEY)──▶ SNOWy Worker ──(env.AI.run, chat format, stream)──▶ Workers AI
          ◀──────────── response.* SSE events ─────────────            ◀──────── chat.completion.chunk SSE ──────
```

## Models

All of these are Workers **Free** plan models. Each one was called live on a Free account on 2026-11-17. Codex status means:

- **verified**: a real Codex CLI 0.169 session worked (tool calls, local execution, results sent back, final answer).
- **compatible**: streaming, tool calls and a tool round trip all passed live through SNOWy, but no real Codex session was run.
- **limited**: works, but has a known problem with Codex (see the notes).

| Model | Category | Context | Reasoning effort | Codex | Neurons per M tokens (in / out) |
|---|---|---|---|---|---|
| `@cf/zai-org/glm-4.7-flash` **(default)** | Coding | 131k | `none`, `high` (default) | **verified** | 5,500 / 36,400 |
| `@cf/google/gemma-4-26b-a4b-it` | General | 256k | `none`, `high` (default) | **verified** | 9,091 / 27,273 |
| `@cf/openai/gpt-oss-120b` | Reasoning | 128k | `low`, `medium` (default), `high` | **verified** | 31,818 / 68,182 |
| `@cf/openai/gpt-oss-20b` | Reasoning | 128k | `low`, `medium` (default), `high` | limited¹ | 18,182 / 27,273 |
| `@cf/qwen/qwen3.8-27b` | Coding | 262k | `low`, `medium`, `xhigh` (default) | compatible | 40,909 / 290,909 |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | General | 128k | no reasoning | compatible | 31,876 / 50,488 |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | General | 131k | no reasoning | compatible | 24,545 / 77,273 |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | General | 24k | no reasoning | limited² | 26,668 / 204,805 |
| `@cf/ibm-granite/granite-4.0-h-micro` | Fast | 131k | no reasoning | limited³ | 1,542 / 10,158 |
| `@cf/nvidia/nemotron-3-120b-a12b` | Reasoning | 256k | `none`, `low`, `high` (default) | compatible, **retires 2026-11-20** | 45,455 / 136,364 |

1. GPT-OSS 20B sometimes puts its tool call inside its reasoning text instead of returning a real tool call. Workers AI then reports it as plain reasoning, so the Codex turn ends without doing anything. This happened in 3 of 3 runs through chat format and 2 of 3 through Workers AI's native Responses API. The problem is upstream, so SNOWy does not try to guess the tool call from the reasoning text.
2. Codex's instructions and tool definitions alone take about 8–12k tokens, so a session fills the 24k context window after a few tool calls.
3. Tool calls work, but in a real edit task it never edited the file and then said it had.

**Recommendations**

| Use | Model | Why |
|---|---|---|
| Best free coding model (default) | GLM-4.7 Flash | Verified on every Codex test (reads, shell, approvals, `apply_patch` edits, multi-turn), and the cheapest verified model per input token. |
| Best free reasoning model | GPT-OSS 120B | Verified in multi-turn Codex use, with real low/medium/high effort levels. Costs about 6× more Neurons than GLM. |
| Best free general-purpose model | Gemma 4 26B A4B | Verified (fixed a bug first try), 256k context, accepts images, and prefix-cache hits were observed. |
| Fastest economical model | Granite 4.0 H Micro for chat; GLM-4.7 Flash for Codex | Granite costs about 1,500 Neurons per M input tokens but is unreliable for agent work. |

**Not included:**

- Models that need a paid plan, which return error 5035 on Free: kimi-k2.6, kimi-k2.7-code, glm-5.2, glm-5.3, glm-5.3-flash, deepseek-v4-flash-0731, deepseek-v4.1-flash-1017, deepseek-v4-pro-0813 and inkling-2-small.
- Models without function calling: qwen2.5-coder-32b, llama-3.2-*, llama-3.1-8b-fp8, gemma-sea-lion and the LoRA models.
- Models retiring on 2026-11-20: qwq-32b, deepseek-r1-distill and qwen3-30b-a3b.
- Classifiers: llama-guard and the clef models.
- Form-gated models whose Free access I couldn't confirm: `apertus-v1.5-8b` and `eurollm-9b-it`.

**Budget:** the Free plan allows 10,000 Neurons per day. One Codex turn sends the full conversation every time, about 8–15k input tokens, so a small fix-and-verify task costs roughly:

- about 250 Neurons on GLM-4.7 Flash
- about 550 on Gemma 4
- over 1,500 on GPT-OSS 120B

To add or remove a model, edit `MODELS` in [src/models.ts](src/models.ts) and run `pnpm test`; no other change is needed. The default model is the `DEFAULT_MODEL` var in [wrangler.jsonc](wrangler.jsonc). It is only used when a request has no `model` field. If a request names a model that isn't registered, SNOWy rejects it and never switches to another one.

## Setup

**Quick setup:** run `./setup.sh`. It installs pnpm and dependencies, logs in to Wrangler, lets you pick your Cloudflare account (written to `wrangler.jsonc`), generates `SNOWY_API_KEY`, deploys the Worker with the secret, checks the endpoint, installs Codex if needed, and adds the `cloudflare` provider and `snowy` profile. Your default `codex` setup is not changed. It is safe to re-run. `./setup.sh --help` lists the options. The manual steps follow.

Requirements: Node 22.18 or newer (24 recommended), pnpm (`corepack enable pnpm`), Codex CLI 0.169 or newer, and a Cloudflare account on the Workers Free plan.

```sh
# 1. Install
pnpm install

# 2. Authenticate Wrangler (pick your Free-plan account if you have several)
pnpm exec wrangler login
export CLOUDFLARE_ACCOUNT_ID=<your account id>   # `pnpm exec wrangler whoami` lists them

# 3. The Workers AI binding is already set up in wrangler.jsonc ("ai": {"binding": "AI"}).
#    Nothing to create in the dashboard.

# 4. Generate a random API token (shown once; keep it in your password manager)
SNOWY_API_KEY=$(openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-48)

# 5. Store it as a Worker secret (it is never written to tracked files)
printf %s "$SNOWY_API_KEY" | pnpm exec wrangler secret put SNOWY_API_KEY

# 6. Local development (inference still uses the remote AI binding, so it spends Neurons)
umask 077; printf 'SNOWY_API_KEY=%s\n' "$SNOWY_API_KEY" > .dev.vars   # gitignored
pnpm dev                                # http://localhost:8787

# 7. Automated tests (mocked AI binding, no Neurons, no login)
pnpm typecheck && pnpm test
#    Live tests against a running SNOWy (spend roughly 300 Neurons for all models):
SNOWY_URL=http://127.0.0.1:8787 SNOWY_API_KEY=$SNOWY_API_KEY pnpm test:live

# 8. Deploy
pnpm exec wrangler deploy
```

### 9. Test the deployed Worker

```sh
URL=https://snowy-worker.YOUR-SUBDOMAIN.workers.dev
curl -s $URL/health                                                 # {"status":"ok"}
curl -s $URL/v1/models -H "Authorization: Bearer $SNOWY_API_KEY"
curl -sN $URL/v1/responses -H "Authorization: Bearer $SNOWY_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"@cf/openai/gpt-oss-20b","stream":true,"reasoning":{"effort":"low"},"input":"Say hi"}'
curl -s $URL/v1/responses -H 'Content-Type: application/json' -d '{}'   # 401 missing_api_key
```

### 10–12. Configure Codex (your existing config stays as it is)

```sh
# 10. Make the key available to Codex, e.g. in ~/.zshrc (or use a secret manager)
export SNOWY_API_KEY='...'

# 11. Add the provider definition to the end of ~/.codex/config.toml (it only defines the provider)
cat codex/config.toml.snippet >> ~/.codex/config.toml   # then fix YOUR-SUBDOMAIN in base_url

#     Add the profile overlay, which is loaded only by `codex --profile snowy`
cp codex/snowy.config.toml ~/.codex/snowy.config.toml

#     Optional but recommended: list Cloudflare models in /model and give Codex a native apply_patch tool
pnpm codex:catalog --out ~/.codex/snowy-models.json
echo "model_catalog_json = \"$HOME/.codex/snowy-models.json\"" >> ~/.codex/snowy.config.toml

# 12. Start Codex on Cloudflare
codex --profile snowy
```

Optional shell function, which picks each model's default effort for you:

```sh
echo "source $PWD/codex/snowy.sh" >> ~/.zshrc && source ~/.zshrc
snowy                                   # GLM-4.7 Flash
snowy @cf/openai/gpt-oss-120b high      # model + effort
snowy @cf/google/gemma-4-26b-a4b-it exec "summarize README.md"
```

### 13–14. Switching models and going back

```sh
codex --profile snowy -m @cf/openai/gpt-oss-20b  -c model_reasoning_effort=low
codex --profile snowy -m @cf/openai/gpt-oss-120b -c model_reasoning_effort=high
codex --profile snowy -m @cf/google/gemma-4-26b-a4b-it -c model_reasoning_effort=high
codex                                   # your normal OpenAI model and login, unchanged
```

Without the profile, a single command line also works: `codex -c model_provider=cloudflare -c web_search=disabled -c model_reasoning_effort=high -m @cf/zai-org/glm-4.7-flash`.

**`/model` and `/status`.**

- **`/model`:** Codex does not ask custom providers for a model list. Without a catalog, `/model` shows OpenAI's built-in list. Codex also warns "Model metadata … not found", assumes a 272k context window, and gives the model no `apply_patch` tool, so edits go through shell commands.
- **With the catalog:** `model_catalog_json` (generated from the registry by `pnpm codex:catalog`) makes `/model` list the Cloudflare models with their real effort levels. It also sets the correct context windows and auto-compaction thresholds, and adds the `apply_patch` tool.
  - The catalog entries reuse Codex's own prompt for unknown models, downloaded from the openai/codex tag that matches your `codex --version`.
  - Re-run the command after upgrading Codex.
  - The catalog applies only to `--profile snowy` sessions.
- **`/status`:** shows the provider `cloudflare`, the model, the effort, token usage and the context window from the catalog. ChatGPT usage limits are not shown for custom providers.

## Behavior reference

**Authentication**

- Every route except `/health` needs `Authorization: Bearer <SNOWY_API_KEY>`.
- A missing or malformed header, or a wrong token, gets **401**.
- If the secret is missing, empty or shorter than 16 characters, **every** request gets **500 `server_misconfigured`**. There is no way to get in with an empty token.
- Tokens are compared as SHA-256 digests with `crypto.subtle.timingSafeEqual`, which is constant-time and doesn't reveal the length.
- The secret is never logged or returned.

**Routes and limits**

- `GET /health`, `GET /v1/models` and `POST /v1/responses` are the only routes. Other paths get **404**; other methods get **405** with an `Allow` header.
- Request bodies are limited by `MAX_BODY_BYTES` (4 MB, checked while streaming) → **413**.
- Compressed bodies or non-JSON content types → **415**. Codex sends neither to custom providers.
- After authentication, a rate limit of 60 requests per minute per client IP → **429** with `Retry-After`.

**Cost guards**

- Only registered model IDs are forwarded. Anything else gets **400** before Workers AI is called.
- `max_tokens` is always set explicitly. This matters because older Workers AI models default to 256, and SNOWy also lowers it so prompt plus output fits the context window.
- Models past their retirement date get **410**.

**Reasoning effort**

- `reasoning.effort` is checked against the model's documented levels. An unsupported level gets **400 `unsupported_reasoning_effort`** listing the valid ones; SNOWy never quietly switches to a different level.
- If effort is omitted, nothing is sent and the model's own default applies.
- GLM and Gemma only have thinking on or off: `none` turns it off (`enable_thinking:false`), and `high` means on, which is their default. This follows the convention Cloudflare documents for on/off models.
- For models with no reasoning at all, an effort value doesn't apply. It is not sent upstream and is reported in the `X-Snowy-Reasoning-Ignored` response header.

**Error mapping (Workers AI → HTTP)**

| Workers AI code | Meaning | Returned |
|---|---|---|
| 3036 | daily Neurons used up | 429 `insufficient_quota`; Codex stops instead of retrying |
| 3040 | out of capacity | 503 `server_is_overloaded`; Codex retries |
| 5035 | paid plan required | 403 |
| 5028 | model retired | 410 |
| 5006 / 8001 | invalid input | 400 |
| — | context window exceeded | 400 `context_length_exceeded` |
| — | error after streaming has started | `response.failed` event |

## Responses API compatibility

Facts confirmed against the Codex 0.169 source and live captures:

- **What Codex sends.** Codex uses `POST {base_url}/responses` with SSE over HTTP, with no websockets and no compression for custom providers.
  - Every request resends the full conversation (`store:false`), and `previous_response_id` is never used.
  - The system prompt arrives as a leading `developer` message, not as `instructions`.
- **What Codex reads back.** Codex builds its history only from `response.output_item.done` events and needs a final `response.completed` that carries an `id`.
  - Missing or bad `usage` sub-fields would break parsing, so SNOWy always sends complete usage details or none at all.
- **The Workers AI side.** Its Responses API exists only for GPT-OSS and only without streaming. Requests in that format with `stream:true` returned an empty or aborted stream on the binding.
  - Chat Completions streaming works for every model above, with real token deltas, `reasoning_content` and `tool_calls`. SNOWy therefore streams Chat Completions and translates each chunk as it arrives. This is real token streaming, not simulated.

How each kind of item is translated:

| Responses item | Workers AI chat |
|---|---|
| Leading `developer`/`system` messages and `instructions` | one `system` message |
| `developer` messages later in the conversation | a `user` turn wrapped in `<developer_message>`, because many chat templates reject a `system` message that isn't first |
| `user` / `assistant` messages | `user` / `assistant`; images only for vision models, otherwise an explicit placeholder |
| `reasoning` (`reasoning_text` content) | `reasoning_content` on the next assistant message, only for reasoning models; `encrypted_content` is OpenAI-only and dropped |
| `function_call` / `function_call_output` | assistant `tool_calls` / `tool` messages; call IDs are kept |
| `namespace` tools (e.g. `multi_agent_v1`) | flattened to `namespace__name`; calls come back with `name` and `namespace` |
| `custom` tools (freeform `apply_patch`) | a function with one string argument `{input}`; calls come back as `custom_tool_call` |
| `web_search` and other OpenAI-hosted tools | removed and listed in the `X-Snowy-Dropped-Tools` header; set `web_search = "disabled"` |
| Tool calls with no recorded result (e.g. after an interrupt) | an explicit placeholder result, because chat templates require one |

SSE events SNOWy emits:

- At the start: `response.created` and `response.in_progress`.
- For each output item: `output_item.added`, `content_part.added`, `*.delta`, `*.done`, `content_part.done`, `output_item.done`. Reasoning uses `reasoning_text.*`, messages use `output_text.*`, function calls use `function_call_arguments.*`, and custom calls use `custom_tool_call_input.*`.
- At the end, one of: `response.completed`; `response.incomplete` (when `finish_reason` is `length` or `content_filter`); or `response.failed`.

`sequence_number` increases by one per event, and item IDs and output indexes stay consistent across all of an item's events. If the client disconnects, the upstream read is cancelled.

**The one simulated stream:** requests that use `text.format` (structured JSON output, which Codex's TUI uses for thread titles) run without streaming, because Workers AI's JSON mode can't stream. The finished result is then replayed as SSE and marked with the `X-Snowy-Streaming: simulated` header. How strictly the JSON schema is followed depends on the model; GPT-OSS doesn't always follow it.

## Security: controls that need the Cloudflare dashboard

The Worker enforces authentication, size limits, routes, the model allowlist and the per-IP rate limit itself. Four more controls are set up in Cloudflare instead:

- **Neuron cap:** on Workers Free, Cloudflare stops Workers AI at 10,000 Neurons per day (error 3036), so there can be no surprise bill. Watch usage under *AI → Workers AI*.
- **WAF and rate-limiting rules:** these can't be attached to `*.workers.dev`. To use them, add a custom domain on a zone you own (Workers → snowy-worker → Settings → Domains & Routes), turn off the `workers.dev` route, and add a rate-limiting rule (Security → WAF).
- **Optional extra layer:** put Cloudflare Access with a service token in front of the custom domain. Codex can send the two headers through `env_http_headers = { "CF-Access-Client-Id" = "CF_ID", "CF-Access-Client-Secret" = "CF_SECRET" }` in the provider block.
- **Logs:** Workers Logs are turned on (`observability`). Each request logs one line with the model, effort and message/tool counts. Prompts, outputs and secrets are never logged. Run `pnpm exec wrangler tail` to watch them.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing environment variable: SNOWY_API_KEY` | Export it in the shell that runs Codex. |
| `401 Unauthorized: Incorrect API key provided` | The local key doesn't match the Worker secret. Run `wrangler secret put SNOWY_API_KEY` again. |
| `500 … Server authentication is not configured` | The secret isn't set, or is shorter than 16 characters. |
| `400 unsupported_reasoning_effort` | Your global `model_reasoning_effort` doesn't fit this model. Pass `-c model_reasoning_effort=<level>` or use `snowy`. |
| `400 model_not_supported` | Use an ID from `GET /v1/models`. |
| `429 insufficient_quota` | The daily 10k Neurons are used up. They reset at 00:00 UTC. |
| `Model metadata … not found` warning | Generate and configure `snowy-models.json` (see step 11). |
| `stream disconnected before completion` | A network or upstream problem; Codex retries by itself. Check `wrangler tail`. |
| Model describes a command instead of running it | A model limitation (see GPT-OSS 20B / Granite above). Switch to GLM-4.7 Flash, Gemma 4 or GPT-OSS 120B. |
| `ran out of room in the model's context window` | Start a new thread or use `/compact`. With the catalog, Codex compacts automatically at 80% of the context window. |

## Known limitations

- **No server-side state.** `previous_response_id` and `background` get a 400. Codex doesn't use either over HTTP.
- **OpenAI-only features:**
  - Hosted tools are not available: web search, image generation, file search and tool search.
  - Encrypted reasoning and remote compaction are not available either. Codex compacts locally for custom providers.
- **Reasoning summaries:** none are produced. The real reasoning text streams as `reasoning_text`, and nothing is invented.
- **Token counts:**
  - `reasoning_tokens` is always 0, because Workers AI doesn't report it.
  - `cached_tokens` is non-zero only when Workers AI reports prefix-cache hits. SNOWy routes requests by Codex's `prompt_cache_key` using `x-session-affinity`.
- **`text.format` requests** use simulated streaming (see above).
- **Gaps in model testing:**
  - Real Codex sessions were run on GLM-4.7 Flash, Gemma 4, GPT-OSS 120B/20B and Granite.
  - The other models were checked at the API level only.
  - Nemotron 3 disappears on 2026-11-20. After that date SNOWy returns 410 for it and leaves it out of `/v1/models`.
