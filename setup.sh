#!/usr/bin/env bash
# =============================================================================
#  SNOWy one-shot setup
#
#  Deploys this Worker to YOUR Cloudflare account and points the Codex CLI at it,
#  so you can use Codex with Cloudflare Workers AI models (no ChatGPT plan needed).
#
#  What it does, in order:
#    1. Checks Node.js (>= 22.18) and installs pnpm if it is missing
#    2. pnpm install
#    3. wrangler whoami -> logs you in if needed -> lists your Cloudflare accounts
#    4. Writes the account you pick into wrangler.jsonc ("account_id")
#    5. Detects Workers Free vs Paid; Paid enables the paid-only models
#       (DeepSeek V4, GLM-5.3, Kimi, Inkling) → wrangler.jsonc "WORKERS_PLAN"
#    6. Generates (or reuses) the SNOWY_API_KEY token, saves it in .dev.vars
#    7. Typechecks + runs the unit tests (mocked, free)
#    8. Deploys the Worker and uploads SNOWY_API_KEY as a Worker secret
#    9. Checks the live endpoint (/health, /v1/models)
#   10. Installs / checks the Codex CLI
#   11. Adds a "cloudflare" provider + "snowy" profile to Codex
#       (your normal `codex` provider/model/login are NOT changed)
#   12. Saves the token for your shell and installs the `snowy` launcher
#
#  Usage:
#    ./setup.sh                 interactive (recommended)
#    ./setup.sh --yes           accept the default answer for every question
#    ./setup.sh --skip-tests    skip typecheck + unit tests
#    ./setup.sh --skip-codex    only deploy the Worker, do not touch Codex
#    ./setup.sh --plan=paid     skip plan detection (auto | free | paid; default auto)
#    ./setup.sh --help
#
#  Env overrides:
#    CLOUDFLARE_ACCOUNT_ID   pre-select the Cloudflare account
#    CLOUDFLARE_API_TOKEN    use an API token instead of `wrangler login` (headless/SSH)
#    SNOWY_API_KEY           use this token instead of generating one
#    CODEX_HOME              Codex config dir (default: ~/.codex)
#    SNOWY_PLAN              same as --plan
#
#  Safe to re-run: every step is idempotent, and files it changes are backed up.
# =============================================================================

set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Paths / constants
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

WRANGLER_CONFIG="$SCRIPT_DIR/wrangler.jsonc"
DEV_VARS="$SCRIPT_DIR/.dev.vars"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
CODEX_CONFIG="$CODEX_DIR/config.toml"
CODEX_PROFILE="$CODEX_DIR/snowy.config.toml"
CODEX_CATALOG="$CODEX_DIR/snowy-models.json"
SNOWY_ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/snowy"
SNOWY_ENV_FILE="$SNOWY_ENV_DIR/snowy.env"
MIN_NODE="22.18.0"
MIN_PNPM_MAJOR=10
MIN_CODEX="0.169.0"
DEFAULT_MODEL="@cf/zai-org/glm-4.7-flash"
MARK_BEGIN="# >>> snowy (managed by setup.sh) >>>"
MARK_END="# <<< snowy (managed by setup.sh) <<<"

ASSUME_YES=0
SKIP_TESTS=0
SKIP_CODEX=0
PLAN_MODE="${SNOWY_PLAN:-auto}"
# Paid-only model used to detect the plan (one call, 1 output token, reasoning off):
# Free accounts get HTTP 403 / Workers AI error 5035 (not billed); Paid accounts get a reply (~$0.00001).
PLAN_PROBE_MODEL="@cf/deepseek-ai/deepseek-v4.1-flash-1017"

TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t snowy)"
chmod 700 "$TMP_DIR"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT
trap 'fail "Setup aborted at line $LINENO (exit $?). Fix the problem above and re-run ./setup.sh — finished steps are skipped or redone safely."' ERR
trap 'echo; fail "Interrupted."' INT

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; N=$'\033[0m'
else
  B=""; DIM=""; R=""; G=""; Y=""; C=""; N=""
fi
STEP_NO=0
step() { STEP_NO=$((STEP_NO + 1)); printf '\n%s━━ [%d] %s%s\n' "$B$C" "$STEP_NO" "$*" "$N"; }
info() { printf '  %s\n' "$*"; }
ok()   { printf '  %s✔%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s⚠ %s%s\n' "$Y" "$*" "$N" >&2; }
fail() { trap - ERR; printf '\n%s✖ %s%s\n' "$R$B" "$*" "$N" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Read from the terminal even if stdin is redirected.
TTY_IN=/dev/stdin
if [ ! -t 0 ] && [ -r /dev/tty ]; then TTY_IN=/dev/tty; fi

# ask "Question" default(y|n)  -> returns 0 for yes
ask() {
  local q="$1" def="${2:-y}" hint ans
  if [ "$def" = y ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  if [ "$ASSUME_YES" = 1 ]; then
    info "$q $hint ${DIM}(auto: $def)${N}"
    [ "$def" = y ]; return
  fi
  while true; do
    printf '  %s?%s %s %s ' "$B" "$N" "$q" "$hint"
    IFS= read -r ans <"$TTY_IN" || ans=""
    ans="$(printf '%s' "$ans" | tr '[:upper:]' '[:lower:]')"
    [ -z "$ans" ] && ans="$def"
    case "$ans" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) info "Please answer y or n." ;;
    esac
  done
}

# prompt "Question" default -> echoes answer
prompt() {
  local q="$1" def="${2:-}" ans
  if [ "$ASSUME_YES" = 1 ]; then printf '%s' "$def"; return; fi
  if [ -n "$def" ]; then printf '  %s?%s %s [%s] ' "$B" "$N" "$q" "$def" >&2
  else printf '  %s?%s %s ' "$B" "$N" "$q" >&2; fi
  IFS= read -r ans <"$TTY_IN" || ans=""
  printf '%s' "${ans:-$def}"
}

# version_ge A B -> true if A >= B (dotted numeric)
version_ge() {
  local IFS=.
  # shellcheck disable=SC2206
  local a=($1) b=($2) i
  for i in 0 1 2; do
    local x="${a[$i]:-0}" y="${b[$i]:-0}"
    x="${x%%[!0-9]*}"; y="${y%%[!0-9]*}"
    x="${x:-0}"; y="${y:-0}"
    if ((10#$x > 10#$y)); then return 0; fi
    if ((10#$x < 10#$y)); then return 1; fi
  done
  return 0
}

backup() { # backup <file>  (only if it exists)
  [ -f "$1" ] || return 0
  local dst
  dst="$1.bak.$(date +%Y%m%d-%H%M%S)"
  cp -p "$1" "$dst"
  info "${DIM}backup: $dst${N}"
}

wrangler() { pnpm exec wrangler "$@"; }

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --skip-codex) SKIP_CODEX=1 ;;
    --plan=*) PLAN_MODE="${arg#--plan=}" ;;
    -h|--help) usage ;;
    *) fail "Unknown option: $arg (see ./setup.sh --help)" ;;
  esac
done

case "$PLAN_MODE" in auto|free|paid) ;; *) fail "--plan / SNOWY_PLAN must be auto, free or paid (got '$PLAN_MODE')." ;; esac

printf '%s\n' "${B}SNOWy setup${N} — Codex CLI on Cloudflare Workers AI"
info "Project: $SCRIPT_DIR"

[ -f "$WRANGLER_CONFIG" ] && [ -f "$SCRIPT_DIR/package.json" ] \
  || fail "wrangler.jsonc / package.json not found. Run this script from the SNOWy repository."

OS="$(uname -s)"
case "$OS" in
  Linux|Darwin) ;;
  MINGW*|MSYS*|CYGWIN*) warn "Windows shell detected. WSL is recommended; continuing anyway." ;;
  *) warn "Untested OS: $OS" ;;
esac
have curl || fail "curl is required. Install it (e.g. 'sudo apt install curl' / 'brew install curl') and re-run."

# ---------------------------------------------------------------------------
# 1. Node.js
# ---------------------------------------------------------------------------
step "Node.js (>= $MIN_NODE)"

load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && return 0
  return 1
}

node_ok() { have node && version_ge "$(node -p 'process.versions.node' 2>/dev/null || echo 0)" "$MIN_NODE"; }

if ! node_ok; then
  if have node; then warn "Node $(node -v) is too old (need >= $MIN_NODE; TypeScript scripts run natively from 22.18)."
  else warn "Node.js is not installed."; fi

  if load_nvm && have nvm; then
    info "nvm found."
  elif ask "Install nvm + Node 24 LTS now (user-local, no sudo)?" y; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE=/dev/null bash
    load_nvm || fail "nvm install failed. Install Node >= $MIN_NODE manually (https://nodejs.org) and re-run."
  else
    fail "Install Node.js >= $MIN_NODE (https://nodejs.org) and re-run."
  fi
  nvm install 24 >/dev/null
  nvm use 24 >/dev/null
  node_ok || fail "Node is still < $MIN_NODE after nvm install."
  warn "Node was installed with nvm. Open a new terminal later (or run 'nvm use 24') so it is on PATH."
fi
ok "node $(node -v)"

# ---------------------------------------------------------------------------
# 2. pnpm + dependencies
# ---------------------------------------------------------------------------
step "pnpm + project dependencies"

pnpm_ok() { have pnpm && [ "$(pnpm --version 2>/dev/null | cut -d. -f1)" -ge "$MIN_PNPM_MAJOR" ] 2>/dev/null; }

install_pnpm() {
  info "Installing pnpm..."
  if have corepack && corepack enable pnpm >/dev/null 2>&1 && corepack prepare pnpm@latest --activate >/dev/null 2>&1 && pnpm_ok; then
    ok "pnpm installed via corepack"; return 0
  fi
  if have npm && npm install -g pnpm@latest >/dev/null 2>&1 && hash -r && pnpm_ok; then
    ok "pnpm installed via npm -g"; return 0
  fi
  info "Falling back to the standalone installer (get.pnpm.io)..."
  curl -fsSL https://get.pnpm.io/install.sh | env SHELL="${SHELL:-/bin/bash}" sh -
  export PNPM_HOME="${PNPM_HOME:-$([ "$OS" = Darwin ] && echo "$HOME/Library/pnpm" || echo "${XDG_DATA_HOME:-$HOME/.local/share}/pnpm")}"
  export PATH="$PNPM_HOME:$PATH"
  hash -r
  pnpm_ok || return 1
  ok "pnpm installed (standalone). Open a new terminal later so it is on PATH."
}

if pnpm_ok; then
  ok "pnpm $(pnpm --version) already installed"
else
  if have pnpm; then warn "pnpm $(pnpm --version) is too old (need >= $MIN_PNPM_MAJOR)."; else warn "pnpm is not installed."; fi
  install_pnpm || fail "Could not install pnpm. Install it manually: https://pnpm.io/installation"
fi

info "Running pnpm install..."
if ! pnpm install --frozen-lockfile; then
  warn "Frozen install failed; retrying with a normal install."
  pnpm install
fi
wrangler --version >/dev/null 2>&1 || fail "wrangler did not install correctly (try: rm -rf node_modules && pnpm install)."
ok "dependencies installed (wrangler $(wrangler --version 2>/dev/null | tail -n1))"

# ---------------------------------------------------------------------------
# 3. Cloudflare login + accounts
# ---------------------------------------------------------------------------
step "Cloudflare authentication (wrangler whoami)"

WHOAMI_JSON="$TMP_DIR/whoami.json"
whoami_json() { wrangler whoami --json >"$WHOAMI_JSON" 2>/dev/null; }

if ! whoami_json; then
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    fail "CLOUDFLARE_API_TOKEN is set but invalid/expired. Fix or unset it, then re-run."
  fi
  warn "Not logged in to Cloudflare."
  if [ -n "${SSH_CONNECTION:-}" ] || { [ "$OS" = Linux ] && [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; }; then
    warn "No local browser detected (SSH/headless). 'wrangler login' needs a browser on THIS machine."
    info "Alternative: create an API token (template 'Edit Cloudflare Workers' + 'Workers AI: Read')"
    info "at https://dash.cloudflare.com/profile/api-tokens, then: export CLOUDFLARE_API_TOKEN=... && ./setup.sh"
    ask "Try 'wrangler login' anyway?" n || fail "Log in first, then re-run."
  fi
  info "A browser window will open — approve the Wrangler access request."
  wrangler login || fail "wrangler login failed."
  whoami_json || fail "Still not authenticated after login."
fi

# Parse accounts: lines "id<TAB>name"
ACCOUNTS_TSV="$TMP_DIR/accounts.tsv"
node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!j.loggedIn) process.exit(2);
  console.error("  Logged in as: " + (j.email || "(API token)") + "  [" + (j.authType || "?") + "]");
  for (const a of j.accounts || []) console.log(a.id + "\t" + (a.name || "").replace(/\s+/g, " "));
' "$WHOAMI_JSON" >"$ACCOUNTS_TSV" || fail "Could not read 'wrangler whoami --json' output."

ACCOUNT_COUNT="$(grep -c . "$ACCOUNTS_TSV" || true)"
[ "$ACCOUNT_COUNT" -gt 0 ] || fail "No Cloudflare accounts visible to this login/token. If you use an API token, give it 'Account: Read' or log in with 'pnpm exec wrangler login'."

printf '\n  %sCloudflare accounts on this login:%s\n' "$B" "$N"
i=0
while IFS="$(printf '\t')" read -r id name; do
  i=$((i + 1))
  printf '    %s%2d)%s %s  %s%s%s\n' "$B" "$i" "$N" "$id" "$DIM" "$name" "$N"
done <"$ACCOUNTS_TSV"

account_by_index() { sed -n "${1}p" "$ACCOUNTS_TSV" | cut -f1; }
account_known() { cut -f1 "$ACCOUNTS_TSV" | grep -qx "$1"; }
current_config_account() {
  node -e '
    const s = require("fs").readFileSync(process.argv[1], "utf8");
    const m = s.match(/^\s*"account_id"\s*:\s*"([^"]*)"/m);
    process.stdout.write(m ? m[1] : "");
  ' "$WRANGLER_CONFIG"
}
write_config_account() {
  node -e '
    const fs = require("fs"), f = process.argv[1], id = process.argv[2];
    let s = fs.readFileSync(f, "utf8");
    if (/^\s*"account_id"\s*:/m.test(s)) {
      s = s.replace(/^(\s*"account_id"\s*:\s*)"[^"]*"/m, `$1"${id}"`);
    } else {
      s = s.replace(/^(\s*"main"\s*:\s*"[^"]*",?[^\n]*\n)/m, (l) => {
        const indent = (l.match(/^\s*/) || [""])[0];
        return l + `${indent}"account_id": "${id}",\n`;
      });
      if (!s.includes(`"account_id": "${id}"`)) { console.error("could not find a place to insert account_id"); process.exit(1); }
    }
    fs.writeFileSync(f, s);
  ' "$WRANGLER_CONFIG" "$1"
}

CURRENT_ACCOUNT="$(current_config_account)"
DEFAULT_PICK=""
if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] && account_known "$CLOUDFLARE_ACCOUNT_ID"; then
  DEFAULT_PICK="$(grep -n "^$CLOUDFLARE_ACCOUNT_ID" "$ACCOUNTS_TSV" | cut -d: -f1)"
elif [ -n "$CURRENT_ACCOUNT" ] && account_known "$CURRENT_ACCOUNT"; then
  DEFAULT_PICK="$(grep -n "^$CURRENT_ACCOUNT" "$ACCOUNTS_TSV" | cut -d: -f1)"
elif [ "$ACCOUNT_COUNT" = 1 ]; then
  DEFAULT_PICK=1
fi

printf '\n'
if [ -n "$CURRENT_ACCOUNT" ]; then
  if account_known "$CURRENT_ACCOUNT"; then info "wrangler.jsonc account_id is currently: ${B}$CURRENT_ACCOUNT${N}"
  else warn "wrangler.jsonc account_id ($CURRENT_ACCOUNT) is NOT one of your accounts — you must change it."; fi
fi
info "The Worker will be deployed to the account set in ${B}wrangler.jsonc → \"account_id\"${N}."
info "Workers ${B}Free${N}: 10 models, capped at 10k Neurons/day (never billed)."
info "Workers ${B}Paid${N}: also DeepSeek V4, GLM-5.3, Kimi K2.7, Inkling 2 — billed per token to that account."

ACCOUNT_ID=""
while [ -z "$ACCOUNT_ID" ]; do
  if [ "$ASSUME_YES" = 1 ] && [ -z "$DEFAULT_PICK" ]; then
    fail "Several accounts found; pass CLOUDFLARE_ACCOUNT_ID=<id> when using --yes."
  fi
  choice="$(prompt "Pick an account number (1-$ACCOUNT_COUNT), or 'm' to edit wrangler.jsonc yourself:" "$DEFAULT_PICK")"
  case "$choice" in
    m|M)
      info "Open ${B}$WRANGLER_CONFIG${N} and set:  \"account_id\": \"<one of the ids above>\""
      until ask "Done editing? Press Y to continue" y; do :; done
      CURRENT_ACCOUNT="$(current_config_account)"
      if [ -n "$CURRENT_ACCOUNT" ] && account_known "$CURRENT_ACCOUNT"; then
        ACCOUNT_ID="$CURRENT_ACCOUNT"
      else
        warn "account_id in wrangler.jsonc ('$CURRENT_ACCOUNT') does not match any listed account. Try again."
      fi
      ;;
    ''|*[!0-9]*) warn "Enter a number between 1 and $ACCOUNT_COUNT, or m." ;;
    *)
      if [ "$choice" -ge 1 ] && [ "$choice" -le "$ACCOUNT_COUNT" ]; then
        ACCOUNT_ID="$(account_by_index "$choice")"
      else
        warn "Out of range."
      fi
      ;;
  esac
done

ACCOUNT_NAME="$(grep "^$ACCOUNT_ID" "$ACCOUNTS_TSV" | cut -f2)"
if [ "$(current_config_account)" != "$ACCOUNT_ID" ]; then
  backup "$WRANGLER_CONFIG"
  write_config_account "$ACCOUNT_ID"
  ok "wrangler.jsonc account_id → $ACCOUNT_ID"
else
  ok "wrangler.jsonc already uses $ACCOUNT_ID"
fi
info "Account: ${B}$ACCOUNT_NAME${N}"
ask "Deploy SNOWy to this account?" y || fail "Cancelled. Re-run and pick another account."
# Wrangler prefers the env var over the config file — keep them identical.
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"


# ---------------------------------------------------------------------------
# 3b. Workers plan (Free / Paid) -> WORKERS_PLAN in wrangler.jsonc
# ---------------------------------------------------------------------------
step "Workers plan (Free / Paid)"

current_config_plan() {
  node -e '
    const s = require("fs").readFileSync(process.argv[1], "utf8");
    const m = s.match(/^\s*"WORKERS_PLAN"\s*:\s*"([^"]*)"/m); process.stdout.write(m ? m[1] : "");
  ' "$WRANGLER_CONFIG"
}
write_config_plan() {
  node -e '
    const fs = require("fs"); const [f, plan] = process.argv.slice(1);
    let s = fs.readFileSync(f, "utf8");
    if (/^\s*"WORKERS_PLAN"\s*:/m.test(s)) {
      s = s.replace(/^(\s*"WORKERS_PLAN"\s*:\s*)"[^"]*"/m, `$1"${plan}"`);
    } else {
      // Insert after DEFAULT_MODEL inside "vars".
      const re = /^(\s*)"DEFAULT_MODEL"\s*:\s*"[^"]*",?[^\n]*\n/m;
      const m = s.match(re);
      if (!m) { console.error("could not find \"vars\" / DEFAULT_MODEL in wrangler.jsonc"); process.exit(1); }
      const line = m[0].includes(",") ? m[0] : m[0].replace(/"\s*\n$/, "\",\n");
      s = s.replace(re, `${line}${m[1]}"WORKERS_PLAN": "${plan}",\n`);
    }
    fs.writeFileSync(f, s);
  ' "$WRANGLER_CONFIG" "$1"
}

# Prints paid | free | unknown. One tiny inference call on the selected account.
detect_plan() {
  local token code
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then token="$CLOUDFLARE_API_TOKEN"
  else token="$(wrangler auth token 2>/dev/null | tail -n1 | tr -d '[:space:]' || true)"; fi
  [ -n "$token" ] || { echo unknown; return; }
  # Header via a 600 file so the token never appears in the process list.
  ( umask 077; printf 'Authorization: Bearer %s\n' "$token" >"$TMP_DIR/auth.hdr" )
  code="$(curl -s -o "$TMP_DIR/plan.json" -w '%{http_code}' --max-time 60 \
    -H @"$TMP_DIR/auth.hdr" -H 'Content-Type: application/json' \
    "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai/run/$PLAN_PROBE_MODEL" \
    -d '{"messages":[{"role":"user","content":"hi"}],"max_completion_tokens":1,"reasoning_effort":"none"}' || true)"
  rm -f "$TMP_DIR/auth.hdr"
  if [ "$code" = 200 ]; then echo paid
  elif grep -q '"code":5035' "$TMP_DIR/plan.json" 2>/dev/null; then echo free
  else echo "unknown:$code"; fi
}

PLAN=""
if [ "$PLAN_MODE" != auto ]; then
  PLAN="$PLAN_MODE"
  ok "Plan set by --plan / SNOWY_PLAN: ${B}$PLAN${N} (detection skipped)"
else
  info "Checking the plan with one 1-token call to a paid-only model ($PLAN_PROBE_MODEL)."
  info "${DIM}Free: rejected with error 5035, nothing billed. Paid: costs a fraction of a cent.${N}"
  DETECTED="$(detect_plan)"
  case "$DETECTED" in
    paid)
      ok "Workers ${B}Paid${N} plan detected"
      if ask "Enable the paid models (listed first in Codex /model; usage is billed to '$ACCOUNT_NAME')?" y; then PLAN=paid
      else PLAN=free; info "Keeping the free models only."; fi ;;
    free)
      ok "Workers ${B}Free${N} plan detected — free models only (upgrade at https://dash.cloudflare.com/$ACCOUNT_ID/workers/plans, then re-run)" ;
      PLAN=free ;;
    *)
      warn "Could not detect the plan (${DETECTED#unknown:}: $(head -c 200 "$TMP_DIR/plan.json" 2>/dev/null || true))."
      if ask "Is '$ACCOUNT_NAME' on the Workers Paid plan?" n; then PLAN=paid; else PLAN=free; fi ;;
  esac
fi

if [ "$(current_config_plan)" != "$PLAN" ]; then
  backup "$WRANGLER_CONFIG"
  write_config_plan "$PLAN"
  ok "wrangler.jsonc WORKERS_PLAN → $PLAN"
else
  ok "wrangler.jsonc already uses WORKERS_PLAN=$PLAN"
fi

WORKER_NAME="$(node -e '
  const s = require("fs").readFileSync(process.argv[1], "utf8");
  const m = s.match(/^\s*"name"\s*:\s*"([^"]+)"/m); process.stdout.write(m ? m[1] : "snowy-worker");
' "$WRANGLER_CONFIG")"

# ---------------------------------------------------------------------------
# 4. API key (SNOWY_API_KEY)
# ---------------------------------------------------------------------------
step "API token (SNOWY_API_KEY)"

gen_key() {
  if have openssl; then openssl rand -base64 64 | tr -d '\n=+/' | cut -c1-48
  else node -e 'process.stdout.write(require("crypto").randomBytes(36).toString("base64url").slice(0,48))'; fi
}
valid_key() { [ "${#1}" -ge 16 ] && [ "$1" != "replace-with-a-long-random-token" ] && ! printf '%s' "$1" | grep -q '[[:space:]]'; }
existing_dev_key() {
  [ -f "$DEV_VARS" ] || return 0
  sed -n 's/^[[:space:]]*SNOWY_API_KEY[[:space:]]*=[[:space:]]*//p' "$DEV_VARS" | tail -n1 | sed 's/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/'
}

KEY=""
if [ -n "${SNOWY_API_KEY:-}" ]; then
  valid_key "$SNOWY_API_KEY" || fail "SNOWY_API_KEY from the environment is shorter than 16 chars or contains spaces."
  KEY="$SNOWY_API_KEY"; ok "Using SNOWY_API_KEY from the environment"
else
  OLD="$(existing_dev_key)"
  if [ -n "$OLD" ] && valid_key "$OLD" && ask "Reuse the existing token from .dev.vars (keeps other machines working)?" y; then
    KEY="$OLD"; ok "Reusing token from .dev.vars"
  fi
fi
if [ -z "$KEY" ]; then
  KEY="$(gen_key)"
  valid_key "$KEY" || fail "Token generation failed."
  ok "Generated a new 48-char token"
  warn "If this Worker was deployed before with another token, old clients will get 401 until updated."
fi

# Save into .dev.vars (gitignored) without clobbering other variables.
(
  umask 077
  if [ -f "$DEV_VARS" ]; then
    grep -v '^[[:space:]]*SNOWY_API_KEY[[:space:]]*=' "$DEV_VARS" >"$TMP_DIR/devvars" || true
  else
    : >"$TMP_DIR/devvars"
  fi
  printf 'SNOWY_API_KEY=%s\n' "$KEY" >>"$TMP_DIR/devvars"
  cat "$TMP_DIR/devvars" >"$DEV_VARS"
  chmod 600 "$DEV_VARS"
)
ok ".dev.vars updated (gitignored, mode 600)"

# ---------------------------------------------------------------------------
# 5. Typecheck + unit tests
# ---------------------------------------------------------------------------
if [ "$SKIP_TESTS" = 0 ]; then
  step "Typecheck + unit tests (mocked, no Neurons used)"
  if pnpm typecheck && pnpm test; then
    ok "all checks passed"
  else
    warn "Typecheck or tests failed."
    ask "Deploy anyway?" n || fail "Fix the failures above (or re-run with --skip-tests)."
  fi
fi

# ---------------------------------------------------------------------------
# 6. Deploy (+ secret in the same upload)
# ---------------------------------------------------------------------------
step "Deploy '$WORKER_NAME' to Cloudflare"
info "If this account has no workers.dev subdomain yet, Wrangler will ask you to register one — answer yes."

SECRETS_FILE="$TMP_DIR/secrets.json"
( umask 077; node -e 'process.stdout.write(JSON.stringify({SNOWY_API_KEY: process.argv[1]}))' "$KEY" >"$SECRETS_FILE" )
DEPLOY_LOG="$TMP_DIR/deploy.log"

deploy_ok=0
if wrangler deploy --secrets-file "$SECRETS_FILE" 2>&1 | tee "$DEPLOY_LOG"; then
  deploy_ok=1
fi
if [ "$deploy_ok" = 0 ]; then
  if grep -qiE 'secrets-file|Unknown argument' "$DEPLOY_LOG"; then
    warn "This Wrangler can't upload secrets during deploy; deploying first, then 'wrangler secret put'."
    wrangler deploy 2>&1 | tee "$DEPLOY_LOG" || fail "Deploy failed (see above)."
    printf '%s' "$KEY" | wrangler secret put SNOWY_API_KEY || fail "Could not store the secret."
  elif grep -qiE 'workers\.dev subdomain|register a workers' "$DEPLOY_LOG"; then
    fail "This account has no workers.dev subdomain. Open https://dash.cloudflare.com/$ACCOUNT_ID/workers/onboarding (or Workers & Pages once), pick a subdomain, then re-run."
  elif grep -qiE 'Authentication error|10000|not authorized|code: 10001' "$DEPLOY_LOG"; then
    fail "Cloudflare rejected the credentials for this account. Run 'pnpm exec wrangler logout && pnpm exec wrangler login' (or fix the API token permissions) and re-run."
  else
    fail "Deploy failed (see output above)."
  fi
fi
ok "Worker deployed and SNOWY_API_KEY secret set"

WORKER_URL="$(grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' "$DEPLOY_LOG" | head -n1 || true)"
if [ -z "$WORKER_URL" ]; then
  warn "Could not find a *.workers.dev URL in the deploy output (custom domain only, or workers.dev disabled)."
  while [ -z "$WORKER_URL" ]; do
    WORKER_URL="$(prompt "Enter the Worker's public base URL (e.g. https://ai.example.com):" "")"
    WORKER_URL="${WORKER_URL%/}"
    case "$WORKER_URL" in https://*) ;; *) warn "Must start with https://"; WORKER_URL="" ;; esac
    [ "$ASSUME_YES" = 1 ] && [ -z "$WORKER_URL" ] && fail "No Worker URL; cannot continue with --yes."
  done
fi
BASE_URL="$WORKER_URL/v1"
ok "Worker URL: ${B}$WORKER_URL${N}"

# ---------------------------------------------------------------------------
# 7. Verify the live endpoint
# ---------------------------------------------------------------------------
step "Verify the live endpoint"
info "New workers.dev hostnames can take ~1 minute to resolve; retrying for up to 2 minutes."
healthy=0
for attempt in $(seq 1 24); do
  body="$(curl -fsS --max-time 10 "$WORKER_URL/health" 2>/dev/null || true)"
  if printf '%s' "$body" | grep -q '"ok"'; then healthy=1; break; fi
  printf '  %s.%s' "$DIM" "$N"; sleep 5
done
printf '\n'
[ "$healthy" = 1 ] && ok "GET /health → $body" || warn "/health did not answer yet. DNS may still be propagating; check later: curl $WORKER_URL/health"

if [ "$healthy" = 1 ]; then
  code="$(curl -s -o "$TMP_DIR/models.json" -w '%{http_code}' --max-time 20 \
    -H "Authorization: Bearer $KEY" "$WORKER_URL/v1/models" || true)"
  case "$code" in
    200) ok "GET /v1/models → 200 ($(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const d=j.data||[];console.log(d.length+" models, "+d.filter(m=>m.requires_workers_paid).length+" paid, plan="+(j.workers_plan||"?"))}catch{console.log("ok")}' "$TMP_DIR/models.json"))" ;;
    401) warn "GET /v1/models → 401: the secret did not match. Re-run ./setup.sh to push it again." ;;
    500) warn "GET /v1/models → 500: secret missing/too short on the Worker. Re-run ./setup.sh." ;;
    *)   warn "GET /v1/models → HTTP $code" ;;
  esac

  if ask "Send one tiny test prompt to Workers AI (uses a few Neurons)?" n; then
    out="$(curl -s --max-time 90 "$WORKER_URL/v1/responses" \
      -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
      -d "{\"model\":\"$DEFAULT_MODEL\",\"stream\":false,\"reasoning\":{\"effort\":\"none\"},\"input\":\"Reply with exactly: SNOWy works\"}" || true)"
    if printf '%s' "$out" | grep -q 'SNOWy works'; then ok "Model answered: SNOWy works"
    else warn "Unexpected reply (first 300 chars): $(printf '%s' "$out" | head -c 300)"; fi
  fi
fi

# ---------------------------------------------------------------------------
# 8. Codex CLI
# ---------------------------------------------------------------------------
if [ "$SKIP_CODEX" = 1 ]; then
  info "--skip-codex: leaving Codex untouched."
else
  step "Codex CLI (>= $MIN_CODEX)"

  codex_version() { codex --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1; }
  install_codex() {
    if npm install -g @openai/codex@latest; then hash -r; return 0; fi
    warn "Global npm install failed (permissions?). Trying a user-local prefix (~/.local)."
    npm install -g --prefix "$HOME/.local" @openai/codex@latest || return 1
    export PATH="$HOME/.local/bin:$PATH"; hash -r
    warn "Codex was installed to ~/.local/bin — make sure that is on your PATH."
  }

  if have codex; then
    CV="$(codex_version)"
    if version_ge "${CV:-0}" "$MIN_CODEX"; then
      ok "codex $CV already installed"
    else
      warn "codex ${CV:-?} is older than $MIN_CODEX (profile overlays need $MIN_CODEX+)."
      if ask "Upgrade Codex CLI now (npm i -g @openai/codex@latest)?" y; then
        install_codex || fail "Codex upgrade failed. Upgrade manually and re-run with --skip-tests."
      else
        warn "Continuing with an old Codex; 'codex --profile snowy' may not work."
      fi
    fi
  else
    warn "Codex CLI is not installed."
    if ask "Install Codex CLI now (npm i -g @openai/codex@latest)?" y; then
      install_codex || fail "Codex install failed. See https://github.com/openai/codex and re-run."
    else
      fail "Codex CLI is required for the remaining steps (or re-run with --skip-codex)."
    fi
  fi
  have codex || fail "codex is not on PATH after install. Open a new terminal and re-run."
  ok "codex $(codex_version)"

  # -------------------------------------------------------------------------
  # 9. Codex provider + profile
  # -------------------------------------------------------------------------
  step "Codex provider 'cloudflare' + profile 'snowy'"
  mkdir -p "$CODEX_DIR"
  info "Your default 'codex' (OpenAI provider, model, login) stays unchanged."

  # Provider block in config.toml: replace our managed block, or an existing
  # [model_providers.cloudflare] table, or append a new one.
  PROVIDER_BLOCK="$MARK_BEGIN
[model_providers.cloudflare]
name = \"Cloudflare Workers AI\"
base_url = \"$BASE_URL\"
env_key = \"SNOWY_API_KEY\"
wire_api = \"responses\"
$MARK_END"

  [ -f "$CODEX_CONFIG" ] || : >"$CODEX_CONFIG"
  NEW_CONFIG="$TMP_DIR/config.toml"
  PROVIDER_BLOCK="$PROVIDER_BLOCK" MB="$MARK_BEGIN" ME="$MARK_END" node -e '
    const fs = require("fs");
    const [src, dst] = process.argv.slice(1);
    const block = process.env.PROVIDER_BLOCK, mb = process.env.MB, me = process.env.ME;
    let s = fs.readFileSync(src, "utf8");
    let lines = s.split("\n");
    const b = lines.indexOf(mb), e = lines.indexOf(me);
    let action;
    if (b !== -1 && e > b) {
      lines.splice(b, e - b + 1, ...block.split("\n"));
      action = "updated";
    } else {
      // An unmanaged [model_providers.cloudflare] table (e.g. from the README) -> replace it.
      const h = lines.findIndex((l) => /^\s*\[\s*model_providers\.cloudflare\s*\]\s*(#.*)?$/.test(l));
      if (h !== -1) {
        let end = h + 1;
        while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
        lines.splice(h, end - h, ...block.split("\n"), "");
        action = "replaced existing [model_providers.cloudflare]";
      } else {
        // Appending a table at EOF never changes top-level keys (model, provider...).
        while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
        if (lines.length) lines.push("");
        lines.push(...block.split("\n"));
        action = "added";
      }
    }
    let out = lines.join("\n");
    if (!out.endsWith("\n")) out += "\n";
    fs.writeFileSync(dst, out);
    process.stdout.write(action);
  ' "$CODEX_CONFIG" "$NEW_CONFIG" >"$TMP_DIR/action"
  if cmp -s "$CODEX_CONFIG" "$NEW_CONFIG"; then
    ok "config.toml already has the provider (base_url = $BASE_URL)"
  else
    backup "$CODEX_CONFIG"
    cat "$NEW_CONFIG" >"$CODEX_CONFIG"
    ok "config.toml: provider 'cloudflare' $(cat "$TMP_DIR/action") → $BASE_URL"
  fi

  # Model catalog: Cloudflare models in /model, real context windows, apply_patch tool.
  CATALOG_LINE="# model_catalog_json = \"$CODEX_CATALOG\"   # run: pnpm codex:catalog --out $CODEX_CATALOG --plan $PLAN"
  info "Generating the Codex model catalog (downloads Codex's base prompt from GitHub)..."
  if pnpm --silent codex:catalog --out "$CODEX_CATALOG" --plan "$PLAN"; then
    CATALOG_LINE="model_catalog_json = \"$CODEX_CATALOG\""
    ok "catalog written: $CODEX_CATALOG"
  else
    warn "Catalog generation failed (offline / GitHub rate limit?). Codex will still work, but /model shows OpenAI's list and there is no apply_patch tool. Re-run later: pnpm codex:catalog --out $CODEX_CATALOG --plan $PLAN"
  fi

  PROFILE_CONTENT="# Managed by SNOWy setup.sh — loaded ONLY by \`codex --profile snowy\`.
# Plain \`codex\` keeps your normal OpenAI provider, model and login.
model_provider = \"cloudflare\"
model = \"$DEFAULT_MODEL\"
# Must be valid for the model. GLM / Gemma: none | high.  GPT-OSS: low | medium | high.  Qwen 3.8: low | medium | xhigh.
# Paid: DeepSeek V4.x: none | low | high | xhigh.  GLM-5.3: low | high | xhigh.  Kimi K2.7: high.  Inkling 2: all levels.
model_reasoning_effort = \"high\"
# OpenAI-hosted web search cannot run on Workers AI.
web_search = \"disabled\"
$CATALOG_LINE
"
  if [ -f "$CODEX_PROFILE" ] && [ "$(cat "$CODEX_PROFILE")" = "$(printf '%s' "$PROFILE_CONTENT")" ]; then
    ok "profile already up to date: $CODEX_PROFILE"
  else
    if [ -f "$CODEX_PROFILE" ] && ! grep -q 'Managed by SNOWy setup.sh' "$CODEX_PROFILE"; then
      warn "$CODEX_PROFILE exists and was not created by this script."
      ask "Overwrite it (a backup is kept)?" y || fail "Keep your file and add the settings manually (see codex/snowy.config.toml)."
    fi
    backup "$CODEX_PROFILE"
    printf '%s' "$PROFILE_CONTENT" >"$CODEX_PROFILE"
    ok "profile written: $CODEX_PROFILE"
  fi

  # -------------------------------------------------------------------------
  # 10. Token for Codex + `snowy` launcher in the shell
  # -------------------------------------------------------------------------
  step "Make SNOWY_API_KEY available to Codex"

  mkdir -p "$SNOWY_ENV_DIR"; chmod 700 "$SNOWY_ENV_DIR"
  (
    umask 077
    {
      echo "# SNOWy (Codex -> Cloudflare Workers AI). Managed by setup.sh. Keep this file private."
      printf "export SNOWY_API_KEY='%s'\n" "$KEY"
      printf "export SNOWY_URL='%s'\n" "$WORKER_URL"
    } >"$SNOWY_ENV_FILE"
  )
  chmod 600 "$SNOWY_ENV_FILE"
  ok "token saved to $SNOWY_ENV_FILE (mode 600)"

  RC_FILE=""
  case "$(basename "${SHELL:-bash}")" in
    zsh)  RC_FILE="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) if [ "$OS" = Darwin ] && [ ! -f "$HOME/.bashrc" ]; then RC_FILE="$HOME/.bash_profile"; else RC_FILE="$HOME/.bashrc"; fi ;;
    fish) RC_FILE="" ;;
    *)    RC_FILE="$HOME/.profile" ;;
  esac

  RC_BLOCK="$MARK_BEGIN
[ -f \"$SNOWY_ENV_FILE\" ] && . \"$SNOWY_ENV_FILE\"
[ -f \"$SCRIPT_DIR/codex/snowy.sh\" ] && . \"$SCRIPT_DIR/codex/snowy.sh\"
$MARK_END"

  if [ -z "$RC_FILE" ]; then
    warn "fish shell detected — add these to ~/.config/fish/config.fish yourself:"
    info "  set -gx SNOWY_API_KEY (string match -r \"'(.*)'\" < $SNOWY_ENV_FILE | sed -n 2p)"
    info "  alias snowy 'codex --profile snowy'"
  elif ask "Add SNOWy (token + 'snowy' command) to $RC_FILE?" y; then
    touch "$RC_FILE"
    RC_BLOCK="$RC_BLOCK" MB="$MARK_BEGIN" ME="$MARK_END" node -e '
      const fs = require("fs"), f = process.argv[1];
      const block = process.env.RC_BLOCK, mb = process.env.MB, me = process.env.ME;
      let lines = fs.readFileSync(f, "utf8").split("\n");
      const b = lines.indexOf(mb), e = lines.indexOf(me);
      if (b !== -1 && e > b) lines.splice(b, e - b + 1, ...block.split("\n"));
      else { while (lines.length && lines[lines.length - 1].trim() === "") lines.pop(); lines.push("", ...block.split("\n")); }
      let out = lines.join("\n"); if (!out.endsWith("\n")) out += "\n";
      fs.writeFileSync(f + ".snowy-new", out);
    ' "$RC_FILE"
    if cmp -s "$RC_FILE" "$RC_FILE.snowy-new"; then
      rm -f "$RC_FILE.snowy-new"; ok "$RC_FILE already set up"
    else
      backup "$RC_FILE"
      cat "$RC_FILE.snowy-new" >"$RC_FILE"; rm -f "$RC_FILE.snowy-new"
      ok "$RC_FILE updated"
    fi
    if grep -qE '^[[:space:]]*export[[:space:]]+SNOWY_API_KEY=' "$RC_FILE"; then
      warn "$RC_FILE also has an older 'export SNOWY_API_KEY=...' line. Remove it so it doesn't override the new token."
    fi
  else
    info "Skipped. Before using Codex run:  . $SNOWY_ENV_FILE"
  fi

  # -------------------------------------------------------------------------
  # 11. Optional end-to-end Codex test
  # -------------------------------------------------------------------------
  if [ "$healthy" = 1 ] && ask "Run one real Codex request through SNOWy now (uses a few hundred Neurons)?" n; then
    step "Codex end-to-end test"
    if (cd "$TMP_DIR" && SNOWY_API_KEY="$KEY" codex exec --profile snowy --skip-git-repo-check \
          "Reply with exactly the text: SNOWy works" </dev/null 2>&1 | tail -n 15); then
      ok "Codex ran through SNOWy (check the reply above)"
    else
      warn "Codex test failed — see output above and the Troubleshooting table in README.md."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
printf '\n%s━━ All set! ━━%s\n' "$B$G" "$N"
cat <<EOF

  ${B}Cloudflare account${N}   $ACCOUNT_NAME ($ACCOUNT_ID)
  ${B}Workers plan${N}         $PLAN$([ "$PLAN" = paid ] && printf ' (paid models enabled, listed first in /model)')
  ${B}Worker endpoint${N}      $WORKER_URL
  ${B}Codex base_url${N}       $BASE_URL
  ${B}Auth header${N}          Authorization: Bearer \$SNOWY_API_KEY
  ${B}Token stored in${N}      $DEV_VARS$([ "$SKIP_CODEX" = 0 ] && printf '\n                       %s' "$SNOWY_ENV_FILE")

EOF
if [ "$SKIP_CODEX" = 0 ]; then
cat <<EOF
  ${B}Start using it${N} (open a NEW terminal first, or run: source ${RC_FILE:-$SNOWY_ENV_FILE}):

    snowy                                   # Codex on GLM-4.7 Flash (default)
    snowy @cf/openai/gpt-oss-120b high      # another model + effort
$([ "$PLAN" = paid ] && printf '    snowy @cf/zai-org/glm-5.3 high          # a paid model\n')
    codex --profile snowy                   # same thing without the helper
    codex                                   # your normal OpenAI setup, unchanged

EOF
fi
cat <<EOF
  ${B}Useful${N}
    curl $WORKER_URL/health
    pnpm exec wrangler tail                 # live logs
    ./setup.sh                              # re-run any time (safe)

  $([ "$PLAN" = paid ] && echo "Paid plan: Workers AI usage is billed per token." || echo "Free plan: 10,000 Neurons/day (resets 00:00 UTC).") Usage: Cloudflare dashboard → AI → Workers AI.
  ${DIM}Keep the token secret. To rotate: delete SNOWY_API_KEY from .dev.vars and re-run ./setup.sh.${N}
EOF
