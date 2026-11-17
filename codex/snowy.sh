# SNOWy launcher for Codex CLI. Source from ~/.zshrc or ~/.bashrc:
#   source /path/to/snowy-worker/codex/snowy.sh
#
#   snowy                                  # TUI, default model (GLM-4.7 Flash), its default effort
#   snowy @cf/openai/gpt-oss-120b          # TUI with GPT-OSS 120B (effort medium)
#   snowy @cf/openai/gpt-oss-120b high     # explicit effort
#   snowy @cf/openai/gpt-oss-20b low exec "explain src/index.ts"   # any codex args after
#
# Plain `codex` is untouched: it keeps your normal OpenAI provider, model and auth.
snowy() {
  local model="${SNOWY_MODEL:-@cf/zai-org/glm-4.7-flash}" effort=""
  case "${1:-}" in @cf/*) model="$1"; shift ;; esac
  case "${1:-}" in none|minimal|low|medium|high|xhigh) effort="$1"; shift ;; esac
  if [ -z "$effort" ]; then
    # Each model's documented default (see GET /v1/models -> reasoning_default_effort).
    case "$model" in
      @cf/openai/gpt-oss-*) effort=medium ;;
      @cf/qwen/qwen3.8-27b) effort=xhigh ;;
      @cf/zai-org/glm-4.7-flash|@cf/google/gemma-4-26b-a4b-it|@cf/nvidia/nemotron-3-120b-a12b) effort=high ;;
      *) effort=none ;; # models without reasoning control: SNOWy ignores the effort
    esac
  fi
  if [ -z "${SNOWY_API_KEY:-}" ]; then
    echo "snowy: set SNOWY_API_KEY first (export SNOWY_API_KEY=...)" >&2
    return 1
  fi
  codex --profile snowy -m "$model" -c model_reasoning_effort="$effort" "$@"
}
