#!/usr/bin/env bash
# Provision a POOL of fresh univocity contracts for the bootstrap suite
# (tests-system.yml `bootstrap-univocity`; locally via
# `task e2e-univocity:provision-pool`).
#
# A univocity contract accepts exactly one root forest (the first to publish a
# checkpoint), so the suite needs one contract per forest it creates. This
# script deploys them serially (the deployer has no nonce manager) and writes
# one JSON pool file for the e2e kit:
#   {"contracts":[{"alg":"es256"|"ks256","address":"0x..","bootstrapPrivateKey":".."}]}
# bootstrapPrivateKey is the ES256 PEM text or the KS256 private key hex, as
# written by the deployer. The file holds private keys: mode 600, never logged.
#
# When GITHUB_ENV is set (CI), exports E2E_UNIVOCITY_CONTRACT_POOL_FILE to the
# job's later steps. The pool never leaves the job that provisioned it.
set -euo pipefail

trim_ws() { printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; }

fail() {
  echo "::error::$*" >&2
  exit 1
}

# assemble_pool OUT_FILE ENTRIES_FILE
# ENTRIES_FILE has one line per contract: alg<TAB>manifest-path<TAB>key-path.
# Writes OUT_FILE atomically (tmp then mv) with mode 600 and prints one summary
# line per contract (alg, address; never keys).
assemble_pool() {
  local out="$1" entries="$2"
  local tmp="${out}.tmp.$$"
  local alg manifest keyfile addr key
  : > "$tmp"
  chmod 600 "$tmp"
  local acc='{"contracts":[]}'
  while IFS=$'\t' read -r alg manifest keyfile; do
    [ -n "$alg" ] || continue
    [ -f "$manifest" ] || { rm -f "$tmp"; fail "manifest missing for ${alg}: ${manifest}"; }
    addr=$(jq -r '.imutableUnivocity // empty' "$manifest")
    case "$addr" in
      0x????????????????????????????????????????) ;;
      *) rm -f "$tmp"; fail "bad or missing imutableUnivocity address for ${alg} in ${manifest}" ;;
    esac
    [ -s "$keyfile" ] || { rm -f "$tmp"; fail "bootstrap key file missing or empty for ${alg}: ${keyfile}"; }
    if [ "$alg" = "es256" ]; then
      key=$(cat "$keyfile")
    else
      key=$(tr -d '[:space:]' < "$keyfile")
    fi
    acc=$(jq -c --arg alg "$alg" --arg a "$addr" --arg k "$key" \
      '.contracts += [{alg: $alg, address: $a, bootstrapPrivateKey: $k}]' <<<"$acc")
    echo "pool contract: alg=${alg} address=${addr}"
  done < "$entries"
  printf '%s\n' "$acc" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$out"
}

# Allow sourcing for the assembly function alone (dry checks).
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

ROOT_DIR="${ROOT_DIR:-$(pwd)}"
export ROOT_DIR
POOL_OUT="${E2E_UNIVOCITY_CONTRACT_POOL_OUT:-${ROOT_DIR}/.work/e2e-univocity-pool.json}"

if [ "${PLAYWRIGHT_PROJECT:-system}" = "prod" ]; then
  echo "prod project — skipping Univocity pool provision"
  exit 0
fi

# Pool sizes per run. Inventory of forests the suite creates: 14 ES256 and
# 8 KS256 (grants-bootstrap 5 per alg; bootstrap-child-auth-grant,
# auth-data-log-chain, bootstrap-log-first-entry and passkey-endorsed-session-seal
# 1 per alg each; register-grant-payment 1 ES256; byok-checkpoint-seal,
# byok-uint64-delegation-range and late-delegation-seal-hint 1 ES256 each).
# Playwright retries (2 in CI) re-run a whole serial describe group with fresh
# forests, so the defaults carry spares.
POOL_ES256="${E2E_UNIVOCITY_POOL_ES256:-20}"
POOL_KS256="${E2E_UNIVOCITY_POOL_KS256:-12}"
case "$POOL_ES256$POOL_KS256" in
  *[!0-9]*|"") fail "E2E_UNIVOCITY_POOL_ES256 / E2E_UNIVOCITY_POOL_KS256 must be non-negative integers" ;;
esac

RPC="$(trim_ws "${E2E_UNIVOCITY_RPC_URL:-${RPC_URL:-}}")"
[ -n "$RPC" ] || fail "E2E_UNIVOCITY_RPC_URL is required (GitHub Environment var or Doppler)."
[ -n "$(trim_ws "${DEPLOY_KEY:-}")" ] || fail "DEPLOY_KEY is required to provision Univocity contracts."

PROPOSAL_DIR="${ROOT_DIR}/.work/univocity-e2e/proposals"
KEY_DIR="${ROOT_DIR}/.work/e2e-univocity-pool-keys"
RELEASE_ROOT="${ROOT_DIR}/.work/univocity-release"
DEPLOYER="${ROOT_DIR}/.cache/univocity-tools/deployer"
RUN_ID="${GITHUB_RUN_ID:-$(date +%s)}"
export E2E_PROVISION_RUN_ID="$RUN_ID"
export RPC_URL="$RPC"

# Always install the release at the last-good pin (univocity-last-good.jsonc);
# UNIVOCITY_TOOLS_VERSION in the environment still wins for a one-off run.
# E2E_UNIVOCITY_SKIP_INSTALL=1 keeps an already installed (e.g. dev) deployer.
if [ "${E2E_UNIVOCITY_SKIP_INSTALL:-}" != "1" ]; then
  task install:release REFRESH_TOOLS=1
fi
[ -x "$DEPLOYER" ] || fail "deployer binary missing at ${DEPLOYER}"
mkdir -p "${ROOT_DIR}/.work" "$PROPOSAL_DIR" "$RELEASE_ROOT"
rm -rf "$KEY_DIR"
mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"
export RELEASE_ROOT
GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" task e2e-univocity:extract

ENTRIES="${KEY_DIR}/entries.tsv"
: > "$ENTRIES"

deploy_one() {
  local alg="$1" i="$2"
  local run_id="${RUN_ID}-${alg}-${i}"
  local pem="${KEY_DIR}/${alg}-${i}.pem"
  local key="${KEY_DIR}/${alg}-${i}.key"
  "$DEPLOYER" deploy provision e2e \
    --source-root "$ROOT_DIR" \
    --work-dir "${ROOT_DIR}/.work" \
    --release-root "$RELEASE_ROOT" \
    --rpc-url "$RPC" \
    --deploy-key "$DEPLOY_KEY" \
    --run-id "$run_id" \
    --alg "$alg" \
    --skip-fetch \
    --proposal-dir "$PROPOSAL_DIR" \
    --bootstrap-es256-pem-out "$pem" \
    --bootstrap-ks256-key-out "$key" \
    --fetch-auth-kind env
  local pointer="${PROPOSAL_DIR}/provision-${run_id}-${alg}.manifest"
  [ -f "$pointer" ] || fail "manifest pointer missing: ${pointer}"
  local manifest keyfile
  manifest=$(cat "$pointer")
  if [ "$alg" = "es256" ]; then keyfile="$pem"; else keyfile="$key"; fi
  printf '%s\t%s\t%s\n' "$alg" "$manifest" "$keyfile" >> "$ENTRIES"
}

# Serial: one DEPLOY_KEY, no nonce manager.
for ((i = 0; i < POOL_ES256; i++)); do deploy_one es256 "$i"; done
for ((i = 0; i < POOL_KS256; i++)); do deploy_one ks256 "$i"; done

mkdir -p "$(dirname "$POOL_OUT")"
assemble_pool "$POOL_OUT" "$ENTRIES"
rm -rf "$KEY_DIR"
# Claims of an earlier pool written to this path name its contracts only.
rm -rf "${POOL_OUT}.claims"
echo "wrote ${POOL_OUT} (es256=${POOL_ES256}, ks256=${POOL_KS256})"

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "E2E_UNIVOCITY_CONTRACT_POOL_FILE=${POOL_OUT}" >> "$GITHUB_ENV"
fi
