#!/usr/bin/env bash
# T3 CI: resolve pinned Univocity contracts from GitHub Environment (no provision).
# Writes GitHub Actions outputs when GITHUB_OUTPUT is set.
set -euo pipefail

trim_ws() { printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; }

log_id_from_addr() {
  local addr="$1"
  local h
  h=$(echo "$addr" | tr 'A-Z' 'a-z' | sed 's/^0x//')
  echo "${h:0:8}-${h:8:4}-${h:12:4}-${h:16:4}-${h:20:12}"
}

github_out() {
  local key="$1"
  local value="$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "${key}=${value}" >> "$GITHUB_OUTPUT"
  fi
}

if [ "${PLAYWRIGHT_PROJECT:-system}" = "prod" ]; then
  echo "prod project — skipping Univocity pin resolve"
  for key in es256_address ks256_address es256_log_id ks256_log_id \
    es256_bootstrap_pem_b64 ks256_bootstrap_signer ks256_bootstrap_key_b64 \
    es256_fresh ks256_fresh; do
    case "$key" in
      es256_fresh|ks256_fresh) github_out "$key" "false" ;;
      *) github_out "$key" "" ;;
    esac
  done
  exit 0
fi

ES256_ADDR="$(trim_ws "${INPUT_ES256_ADDRESS:-}")"
KS256_ADDR="$(trim_ws "${INPUT_KS256_ADDRESS:-}")"
ES256_PEM_B64="$(trim_ws "${INPUT_ES256_PEM_B64:-}")"
KS256_KEY_B64="$(trim_ws "${INPUT_KS256_KEY_B64:-}")"
ES256_LOG="$(trim_ws "${INPUT_ES256_LOG_ID:-}")"
KS256_LOG="$(trim_ws "${INPUT_KS256_LOG_ID:-}")"

if [ -z "$ES256_ADDR" ]; then
  ES256_ADDR="$(trim_ws "${E2E_UNIVOCITY_ADDRESS_ES256_BOOTSTRAP:-}")"
fi
if [ -z "$ES256_ADDR" ]; then
  ES256_ADDR="$(trim_ws "${UNIVOCITY_CONTRACT_ADDRESS:-}")"
fi
if [ -z "$KS256_ADDR" ]; then
  KS256_ADDR="$(trim_ws "${E2E_UNIVOCITY_ADDRESS_KS256_BOOTSTRAP:-}")"
fi
if [ -z "$KS256_ADDR" ]; then
  KS256_ADDR="0x0000000000000000000000000000000000000002"
fi

if [ -z "$ES256_ADDR" ]; then
  echo "::error::T3 requires ES256 Univocity pin (E2E_UNIVOCITY_ADDRESS_ES256_BOOTSTRAP or UNIVOCITY_CONTRACT_ADDRESS)."
  exit 1
fi

if [ -z "$ES256_LOG" ]; then
  ES256_LOG=$(log_id_from_addr "$ES256_ADDR")
fi
if [ -z "$KS256_LOG" ]; then
  KS256_LOG=$(log_id_from_addr "$KS256_ADDR")
fi

KS256_SIGNER=""
if [ -n "$KS256_KEY_B64" ]; then
  KS256_KEY_FILE="${RUNNER_TEMP:-/tmp}/e2e-ks256-bootstrap.key"
  echo "$KS256_KEY_B64" | base64 -d > "$KS256_KEY_FILE"
  if command -v cast >/dev/null 2>&1; then
    KS256_SIGNER=$(cast wallet address --private-key "$(tr -d '\n' < "$KS256_KEY_FILE")")
  fi
fi

github_out es256_address "$ES256_ADDR"
github_out ks256_address "$KS256_ADDR"
github_out es256_log_id "$ES256_LOG"
github_out ks256_log_id "$KS256_LOG"
github_out es256_bootstrap_pem_b64 "$ES256_PEM_B64"
github_out ks256_bootstrap_signer "$KS256_SIGNER"
github_out ks256_bootstrap_key_b64 "$KS256_KEY_B64"
github_out es256_fresh "false"
github_out ks256_fresh "false"

echo "T3 Univocity pins resolved (no ephemeral provision)."
