#!/usr/bin/env bash
# T2 CI — ephemeral Imutable bootstrap provision (tests-system.yml e2e_tier=t2).
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
  echo "prod project — skipping Univocity prepare"
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
RPC="$(trim_ws "${E2E_UNIVOCITY_RPC_URL:-}")"

if [ -z "$RPC" ]; then
  echo "::error::E2E_UNIVOCITY_RPC_URL is required in GitHub Environment."
  exit 1
fi
export RPC_URL="$RPC"

NEED_PROVISION=false
if [ -z "$ES256_ADDR" ]; then NEED_PROVISION=true; fi
if [ -z "$KS256_ADDR" ]; then NEED_PROVISION=true; fi

ROOT_DIR="${ROOT_DIR:-$(pwd)}"
export ROOT_DIR
PROPOSAL_DIR="${ROOT_DIR}/.work/univocity-e2e/proposals"
ES256_PEM="${ROOT_DIR}/.work/e2e-univocity-es256-bootstrap.pem"
KS256_KEY="${ROOT_DIR}/.work/e2e-univocity-ks256-bootstrap.key"
RELEASE_ROOT="${ROOT_DIR}/.work/univocity-release"
DEPLOYER="${ROOT_DIR}/.cache/univocity-tools/deployer"
RUN_ID="${GITHUB_RUN_ID:-$(date +%s)}"
export E2E_PROVISION_RUN_ID="$RUN_ID"

if [ "$NEED_PROVISION" = true ]; then
  if [ -z "$(trim_ws "${DEPLOY_KEY:-}")" ]; then
    echo "::error::DEPLOY_KEY is required to provision Univocity contracts."
    exit 1
  fi
  if [ -f "${ROOT_DIR}/../univocity-tools/Taskfile.dist.yml" ]; then
    task install:dev REFRESH_TOOLS=1
  else
    task install:release UNIVOCITY_TOOLS_VERSION="${UNIVOCITY_TOOLS_VERSION:-v0.6.0}" REFRESH_TOOLS=1
  fi
  if [ ! -x "$DEPLOYER" ]; then
    echo "::error::deployer binary missing at ${DEPLOYER}" >&2
    exit 1
  fi
  mkdir -p "${ROOT_DIR}/.work" "$PROPOSAL_DIR" "$RELEASE_ROOT"
  export RELEASE_ROOT
  GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" task e2e-univocity:extract
fi

deploy_fresh_alg() {
  local alg="$1"
  "$DEPLOYER" deploy provision e2e \
    --source-root "$ROOT_DIR" \
    --work-dir "${ROOT_DIR}/.work" \
    --release-root "$RELEASE_ROOT" \
    --rpc-url "$RPC" \
    --deploy-key "$DEPLOY_KEY" \
    --run-id "$RUN_ID" \
    --alg "$alg" \
    --skip-fetch \
    --proposal-dir "$PROPOSAL_DIR" \
    --bootstrap-es256-pem-out "$ES256_PEM" \
    --bootstrap-ks256-key-out "$KS256_KEY" \
    --fetch-auth-kind env
  local manifest
  manifest=$(cat "${PROPOSAL_DIR}/provision-${RUN_ID}-${alg}.manifest")
  local addr
  addr=$(jq -r '.imutableUnivocity' "$manifest")
  local log_id
  log_id=$(task e2e-univocity:genesis-log-id ADDR="$addr" | tail -1)
  if [ "$alg" = "es256" ]; then
    ES256_ADDR="$addr"
    ES256_LOG="$log_id"
    if [ -f "$ES256_PEM" ]; then
      ES256_PEM_B64=$(base64 -w0 "$ES256_PEM" 2>/dev/null || base64 < "$ES256_PEM" | tr -d '\n')
    fi
  else
    KS256_ADDR="$addr"
    KS256_LOG="$log_id"
    if [ -f "$KS256_KEY" ]; then
      KS256_KEY_B64=$(base64 -w0 "$KS256_KEY" 2>/dev/null || base64 < "$KS256_KEY" | tr -d '\n')
      KS256_SIGNER=$(cast wallet address --private-key "$(tr -d '\n' < "$KS256_KEY")")
    fi
  fi
}

ES256_FRESH=false
KS256_FRESH=false
KS256_SIGNER=""

if [ -z "$ES256_ADDR" ]; then
  deploy_fresh_alg es256
  ES256_FRESH=true
else
  if [ -z "$ES256_PEM_B64" ]; then
    echo "::error::es256_address supplied but es256_bootstrap_pem_b64 is missing."
    exit 1
  fi
  if [ -z "$ES256_LOG" ]; then
    ES256_LOG=$(log_id_from_addr "$ES256_ADDR")
  fi
fi

if [ -z "$KS256_ADDR" ]; then
  deploy_fresh_alg ks256
  KS256_FRESH=true
else
  if [ -z "$KS256_KEY_B64" ]; then
    echo "::error::ks256_address supplied but ks256_bootstrap_key_b64 is missing."
    exit 1
  fi
  if [ -z "$KS256_LOG" ]; then
    KS256_LOG=$(log_id_from_addr "$KS256_ADDR")
  fi
  KS256_KEY_FILE="${RUNNER_TEMP:-/tmp}/e2e-ks256-bootstrap.key"
  echo "$KS256_KEY_B64" | base64 -d > "$KS256_KEY_FILE"
  KS256_SIGNER=$(cast wallet address --private-key "$(tr -d '\n' < "$KS256_KEY_FILE")")
fi

if [ "$(echo "$ES256_ADDR" | tr 'A-Z' 'a-z')" = "$(echo "$KS256_ADDR" | tr 'A-Z' 'a-z')" ]; then
  echo "::error::es256 and ks256 must use different addresses (both ${ES256_ADDR})"
  exit 1
fi

github_out es256_address "$ES256_ADDR"
github_out ks256_address "$KS256_ADDR"
github_out es256_log_id "$ES256_LOG"
github_out ks256_log_id "$KS256_LOG"
github_out es256_bootstrap_pem_b64 "$ES256_PEM_B64"
github_out ks256_bootstrap_signer "$KS256_SIGNER"
github_out ks256_bootstrap_key_b64 "$KS256_KEY_B64"
github_out es256_fresh "$ES256_FRESH"
github_out ks256_fresh "$KS256_FRESH"
