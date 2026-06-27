#!/usr/bin/env bash
# CI-parity Playwright sequence for dev e2e (integration → system → custodian → coordinator).
# Called from task e2e-shared:run-full. Do not add doppler run here — env must be injected.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

trim_ws() {
  printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

if [ -f "${ROOT_DIR}/.work/e2e-univocity.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${ROOT_DIR}/.work/e2e-univocity.env"
  set +a
fi

BASE="$(trim_ws "${CANOPY_BASE_URL:-}")"
if [ -n "$BASE" ]; then
  export CANOPY_BASE_URL="${BASE%/}"
else
  FQ="$(trim_ws "${CANOPY_FQDN:-}")"
  FQ="${FQ#https://}"
  FQ="${FQ#http://}"
  FQ="${FQ%%/*}"
  FQ="${FQ%/}"
  if [ -z "$FQ" ]; then
    echo "Set CANOPY_BASE_URL or CANOPY_FQDN before running Playwright." >&2
    exit 1
  fi
  export CANOPY_BASE_URL="https://${FQ}"
  export CANOPY_BASE_URL="${CANOPY_BASE_URL%/}"
fi

pnpm --filter @canopy/api-e2e exec playwright test --project=integration

OPS="$(trim_ws "${CANOPY_OPS_ADMIN_TOKEN:-}")"
if [ -z "$OPS" ]; then
  echo "CANOPY_OPS_ADMIN_TOKEN is required for system e2e (Mode C webhook seal)." >&2
  exit 1
fi
COORD_URL="$(trim_ws "${DELEGATION_COORDINATOR_URL:-}")"
COORD_TOKEN="$(trim_ws "${COORDINATOR_APP_TOKEN:-}")"
if [ -z "$COORD_URL" ] || [ -z "$COORD_TOKEN" ]; then
  echo "DELEGATION_COORDINATOR_URL and COORDINATOR_APP_TOKEN are required for system BYOK e2e." >&2
  exit 1
fi

pnpm --filter @canopy/api-e2e exec playwright test --project=system
pnpm --filter @canopy/api-e2e exec playwright test --project=custodian

COORD_URL="$(trim_ws "${DELEGATION_COORDINATOR_URL:-}")"
COORD_TOKEN="$(trim_ws "${COORDINATOR_APP_TOKEN:-}")"
if [ -n "$COORD_URL" ] && [ -n "$COORD_TOKEN" ]; then
  pnpm --filter @canopy/api-e2e exec playwright test --project=coordinator
else
  echo "Skipping coordinator Playwright project (DELEGATION_COORDINATOR_URL or COORDINATOR_APP_TOKEN unset)."
fi
