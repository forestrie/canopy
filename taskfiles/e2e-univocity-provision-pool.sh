#!/usr/bin/env bash
# Provision a POOL of fresh univocity contracts for the bootstrap suite
# (tests-system.yml's system-tests job; locally via
# `task e2e-univocity:provision-pool` or `task test:e2e:preflight`).
#
# A univocity contract accepts exactly one root forest (the first to publish a
# checkpoint), so the suite needs one contract per forest it creates. This
# script deploys them serially (the deployer has no nonce manager) and writes
# one JSON pool file for the e2e kit:
#   {"chainId":"84532","contracts":[{"alg":"es256"|"ks256","address":"0x..","bootstrapPrivateKey":".."}]}
# chainId is the chain every contract was deployed to (from the manifests).
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
  local alg manifest keyfile addr key chain chain_id=""
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
    chain=$(jq -r '.chainId // empty' "$manifest")
    [ -n "$chain_id" ] || chain_id="$chain"
    [ "$chain" = "$chain_id" ] || { rm -f "$tmp"; fail "contracts on two chains: ${chain_id} and ${chain} (${manifest})"; }
    if [ "$alg" = "es256" ]; then
      key=$(cat "$keyfile")
    else
      key=$(tr -d '[:space:]' < "$keyfile")
    fi
    acc=$(jq -c --arg alg "$alg" --arg a "$addr" --arg k "$key" \
      '.contracts += [{alg: $alg, address: $a, bootstrapPrivateKey: $k}]' <<<"$acc")
    echo "pool contract: alg=${alg} address=${addr}"
  done < "$entries"
  jq -c --arg c "$chain_id" '{chainId: $c} + .' <<<"$acc" > "$tmp"
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

# Pool sizes per run. Inventory of forests the suite creates: 13 ES256 and
# 9 KS256. Per alg: grants-bootstrap 5; bootstrap-child-auth-grant,
# auth-data-log-chain, bootstrap-log-first-entry and
# passkey-endorsed-session-seal 1 each. ES256 only: register-grant-payment,
# byok-checkpoint-seal, byok-uint64-delegation-range and
# late-delegation-seal-hint 1 each.
# Spares: CI retries a failed test (or the serial group around it) twice,
# and no retried unit creates more than one forest, so each flaky test costs
# at most 2 contracts. 6-7 spares per alg absorb three flaky tests per alg.
POOL_ES256="${E2E_UNIVOCITY_POOL_ES256:-20}"
POOL_KS256="${E2E_UNIVOCITY_POOL_KS256:-15}"
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

# Resolve the pinned ranges (univocity-last-good.jsonc) to release tags once,
# so every task below uses the same tags; a tag already in the environment
# wins for a one-off run, and a range matching no release stops the run here.
resolve_pin() { # KEY ENV_VAR_NAME
  [ -n "$(trim_ws "${!2:-}")" ] && return 0
  local tag
  tag="$(node "${ROOT_DIR}/scripts/univocity-pin.mjs" "$1")" ||
    fail "could not resolve the univocity $1 range"
  [ -n "$(trim_ws "$tag")" ] || fail "empty univocity $1 release tag"
  export "$2=$tag"
}
resolve_pin contracts UNIVOCITY_CONTRACTS_VERSION

# On linux-x64 (CI included), resolve the tools range and install that
# release, replacing any cached copy. Release binaries are linux-x64 only, so
# elsewhere the tools range is not resolved: an installed deployer is used as
# is and a missing one is built from the sibling univocity-tools checkout.
# REFRESH_TOOLS is read from the environment by univocity-tools.yml, not as a
# task var. E2E_UNIVOCITY_SKIP_INSTALL=1 keeps whatever deployer is installed.
if [ "${E2E_UNIVOCITY_SKIP_INSTALL:-}" = "1" ]; then
  echo "using installed deployer at ${DEPLOYER} (E2E_UNIVOCITY_SKIP_INSTALL=1)"
elif [ "$(uname -s)" = "Linux" ] && [ "$(uname -m)" = "x86_64" ]; then
  resolve_pin tools UNIVOCITY_TOOLS_VERSION
  REFRESH_TOOLS=1 task install:release
elif [ -x "$DEPLOYER" ]; then
  echo "using installed deployer at ${DEPLOYER} (release binaries are linux-x64 only)"
else
  task install:dev
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

# deployed_key_matches MANIFEST PROPOSAL: 0 when the contract MANIFEST names
# carries on chain the bootstrap key PROPOSAL generated (ES256 x||y, KS256
# address; bootstrapConfig() returns the same bytes), 1 when it carries another
# key, 2 when the key cannot be read. Another run sending with the same
# DEPLOY_KEY nonce can replace this attempt's transaction: the deployer then
# reports the other run's contract, at the same address, as its own. The read
# is retried because a load-balanced RPC can lag the deployer's own code wait.
deployed_key_matches() {
  local addr want got n err="${KEY_DIR}/cast.err"
  addr=$(jq -r '.imutableUnivocity' "$1")
  want=$(jq -r '.bootstrapKey // empty' "$2" | tr 'A-F' 'a-f')
  if [ -z "$want" ]; then
    echo "::warning::proposal $2 has no bootstrapKey to check ${addr} against" >&2
    return 2
  fi
  for n in 1 2 3 4 5 6; do
    got=$(cast call "$addr" "bootstrapConfig()(int64,bytes)" --rpc-url "$RPC" 2>"$err" \
      | sed -n 2p | tr 'A-F' 'a-f') || got=""
    if [ -n "$got" ]; then
      [ "$got" = "$want" ] && return 0
      return 1
    fi
    sleep $((n * 2))
  done
  # The RPC URL can carry a provider key; keep it out of the log.
  got=$(tail -c 300 "$err")
  echo "::warning::could not read bootstrapConfig() at ${addr}: ${got//"$RPC"/<rpc>}" >&2
  return 2
}

# deploy_one ALG INDEX: deploy one contract and record it in ENTRIES.
# A failed attempt is retried with a fresh run id and key: another run using
# the same DEPLOY_KEY (deploy-workers and release can overlap) may take the
# nonce this deployer read, so its transaction is refused, or replace it (see
# deployed_key_matches); the next attempt reads the nonce again. The backoff is
# jittered so two overlapping runs fall out of step. Provisioning holds the
# key for minutes, not seconds.
deploy_one() {
  local alg="$1" i="$2" attempt run_id pem key pointer manifest proposal keyfile rc
  for attempt in 1 2 3 4 5; do
    run_id="${RUN_ID}-${alg}-${i}-${attempt}"
    pem="${KEY_DIR}/${alg}-${i}-${attempt}.pem"
    key="${KEY_DIR}/${alg}-${i}-${attempt}.key"
    if "$DEPLOYER" deploy provision e2e \
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
      --fetch-auth-kind env; then
      pointer="${PROPOSAL_DIR}/provision-${run_id}-${alg}.manifest"
      [ -f "$pointer" ] || fail "manifest pointer missing: ${pointer}"
      manifest=$(cat "$pointer")
      proposal="${PROPOSAL_DIR}/proposal-${alg}-${run_id}.json"
      rc=0
      deployed_key_matches "$manifest" "$proposal" || rc=$?
      case "$rc" in
        0)
          if [ "$alg" = "es256" ]; then keyfile="$pem"; else keyfile="$key"; fi
          printf '%s\t%s\t%s\n' "$alg" "$manifest" "$keyfile" >> "$ENTRIES"
          return 0
          ;;
        1) echo "::warning::${alg} contract ${i}, attempt ${attempt}: the contract on chain carries another run's bootstrap key (its transaction replaced this one)" >&2 ;;
        *) echo "::warning::${alg} contract ${i}, attempt ${attempt}: could not verify the deployed bootstrap key" >&2 ;;
      esac
    else
      echo "::warning::deploy of ${alg} contract ${i}, attempt ${attempt}, failed" >&2
    fi
    [ "$attempt" -lt 5 ] && sleep $((attempt * 5 + RANDOM % 10))
  done
  fail "deploy of ${alg} contract ${i} failed after 5 attempts"
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
