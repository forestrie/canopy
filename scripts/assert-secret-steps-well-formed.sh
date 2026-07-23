#!/usr/bin/env bash
# FOR-79 regression guard.
#
# The CDP secret step in deploy-workers.yml was structurally incapable of
# working for months and nobody noticed, because it combined two defects:
#
#   1. no `working-directory`, so `wrangler secret put --env <env>` ran at the
#      repo root where there is no wrangler config to resolve; and
#   2. `|| true`, which swallowed the resulting error.
#
# Net effect: CDP credentials never reached any worker, and every deploy was
# green. This script fails CI if either defect reappears in any workflow step
# that pushes a wrangler secret.
#
# Usage: scripts/assert-secret-steps-well-formed.sh [workflow-dir]

set -euo pipefail

WORKFLOW_DIR="${1:-.github/workflows}"
status=0

if [ ! -d "$WORKFLOW_DIR" ]; then
  echo "::error::workflow directory not found: $WORKFLOW_DIR"
  exit 1
fi

# --- Check 1: no `wrangler secret put` may have its failure swallowed. -------
# Matches `|| true`, `|| :` and `|| echo ...` on the same line.
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  echo "::error::wrangler secret put must not swallow failure (found '||' on the same line): ${hit}"
  status=1
done < <(grep -rn 'wrangler secret put' "$WORKFLOW_DIR" | grep '||' || true)

# --- Check 2: every step running `wrangler secret put` declares a -----------
# --- working-directory, so wrangler can resolve that app's config. ----------
#
# Steps are delimited by a line matching `^      - name:` (6-space indent, the
# convention throughout this repo). For each step containing a secret push, we
# require a `working-directory:` line within the same step.
for wf in "$WORKFLOW_DIR"/*.yml "$WORKFLOW_DIR"/*.yaml; do
  [ -e "$wf" ] || continue
  awk -v file="$wf" '
    /^      - name:/ {
      if (in_step && has_put && !has_wd) {
        printf "::error::%s:%d: step %s runs `wrangler secret put` without a working-directory\n", file, start, name
        bad = 1
      }
      in_step = 1; has_put = 0; has_wd = 0; start = NR
      name = $0; sub(/^      - name: */, "", name)
      next
    }
    in_step && /working-directory:/ { has_wd = 1 }
    in_step && /wrangler secret put/ { has_put = 1 }
    END {
      if (in_step && has_put && !has_wd) {
        printf "::error::%s:%d: step %s runs `wrangler secret put` without a working-directory\n", file, start, name
        bad = 1
      }
      exit bad ? 1 : 0
    }
  ' "$wf" || status=1
done

if [ "$status" -ne 0 ]; then
  echo ""
  echo "See scripts/assert-secret-steps-well-formed.sh for why this guard exists (FOR-79)."
  exit 1
fi

echo "OK: all wrangler secret pushes declare a working-directory and fail loudly."
