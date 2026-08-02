#!/usr/bin/env bash
# check-published-packages.sh — keep the declared package list honest.
#
# `.github/auto-tag-packages.json` is the source of truth for which packages
# this repo publishes and the tag each one is cut at. The auto-tag workflow
# (devdocs plan-2608-06 Phase 2) reads it on every merge to main and pushes
# `<tag_prefix>-v<version>`, which is what fires the matching `publish-*.yml`.
# A wrong list means releases that never publish, and nothing else notices.
#
# Two checks, deliberately separated by whether they need the network:
#
#   config  (offline, runs in CI) the declared list and the `publish-*.yml`
#           tag patterns describe the same package set, in both directions.
#           Catches a package declared with no publish workflow to fire, and a
#           publish workflow the auto-tagger will never feed.
#
#   npm     (network, run by hand) every declared package's package.json
#           version equals its npm `latest` — the plan 2608-05 step-5 backfill.
#           Deliberately NOT wired into CI: plan 2608-05 Q3 locked the frontier
#           resolver's hard-fail on unresolvable `components.jsonc` pins as the
#           single recurring consumer-side check. Run this at adoption, and
#           after any suspected auto-tag outage.
#
# Usage: check-published-packages.sh [config|npm|all]   (default: all)

set -euo pipefail

MODE="${1:-all}"
case "$MODE" in
config | npm | all) ;;
*)
  echo "usage: $(basename "$0") [config|npm|all]" >&2
  exit 2
  ;;
esac

CONFIG="${CONFIG:-.github/auto-tag-packages.json}"
WORKFLOW_DIR="${WORKFLOW_DIR:-.github/workflows}"

[ -f "$CONFIG" ] || {
  echo "::error::${CONFIG} not found — this repo has not adopted auto-tag packages mode" >&2
  exit 1
}

fail=0

# --- declared: tag_prefix -> dir, from the source of truth -------------------

declared_tsv=$(jq -r '.packages[] | [.tag_prefix, .dir] | @tsv' "$CONFIG")
[ -n "$declared_tsv" ] || {
  echo "::error::${CONFIG} declares no packages" >&2
  exit 1
}

# --- observed: tag_prefix -> workflow, from the publish workflows ------------
#
# A `publish-*.yml` with no `push.tags` trigger at all is not a tag-fed
# publisher (a dry-run on pull_request, say) and is skipped. One that HAS a tag
# trigger but no `<prefix>-v*` entry is config rot and fails: the auto-tagger
# could never fire it.
observed_tsv=""
if [ "$MODE" = "config" ] || [ "$MODE" = "all" ]; then
  shopt -s nullglob
  for wf in "${WORKFLOW_DIR}"/publish-*.yml "${WORKFLOW_DIR}"/publish-*.yaml; do
    grep -qE '^[[:space:]]+tags:[[:space:]]*$' "$wf" || continue
    prefix=$(sed -nE 's/^[[:space:]]+-[[:space:]]+"?'"'"'?([A-Za-z0-9._-]+)-v\*"?'"'"'?[[:space:]]*$/\1/p' "$wf" | head -1)
    if [ -z "$prefix" ]; then
      echo "::error file=${wf}::declares a tag trigger but no '<prefix>-v*' pattern, so auto-tag can never fire it" >&2
      fail=1
      continue
    fi
    observed_tsv+="${prefix}	${wf}"$'\n'
  done
  shopt -u nullglob
fi

# --- config check ------------------------------------------------------------

if [ "$MODE" = "config" ] || [ "$MODE" = "all" ]; then
  echo "== config: declared packages vs publish workflows =="

  while IFS=$'\t' read -r prefix dir; do
    [ -n "$prefix" ] || continue
    if [ ! -f "${dir%/}/package.json" ]; then
      echo "::error file=${CONFIG}::declares '${dir}' but ${dir%/}/package.json does not exist" >&2
      fail=1
    fi
    if ! grep -qE "^${prefix}	" <<<"$observed_tsv"; then
      echo "::error file=${CONFIG}::'${prefix}' is declared but no ${WORKFLOW_DIR}/publish-*.yml triggers on '${prefix}-v*' — auto-tag would push a tag that publishes nothing" >&2
      fail=1
    fi
  done <<<"$declared_tsv"

  while IFS=$'\t' read -r prefix wf; do
    [ -n "$prefix" ] || continue
    if ! grep -qE "^${prefix}	" <<<"$declared_tsv"; then
      echo "::error file=${wf}::triggers on '${prefix}-v*' but ${CONFIG} does not declare it — this package will never be auto-tagged and npm will silently trail the repo" >&2
      fail=1
    fi
  done <<<"$observed_tsv"

  if [ "$fail" -eq 0 ]; then
    echo "OK: $(wc -l <<<"$declared_tsv" | tr -d ' ') declared package(s) each have a matching publish workflow, and vice versa."
  fi
fi

# --- npm backfill ------------------------------------------------------------

if [ "$MODE" = "npm" ] || [ "$MODE" = "all" ]; then
  echo
  echo "== npm: repo version vs npm latest =="
  printf '%-34s %-10s %-10s %s\n' PACKAGE REPO NPM STATUS

  while IFS=$'\t' read -r prefix dir; do
    [ -n "$prefix" ] || continue
    manifest="${dir%/}/package.json"
    [ -f "$manifest" ] || {
      echo "::error file=${CONFIG}::declares '${dir}' but ${manifest} does not exist" >&2
      fail=1
      continue
    }
    name=$(jq -r '.name // empty' "$manifest")
    version=$(jq -r '.version // empty' "$manifest")
    if [ -z "$name" ] || [ -z "$version" ]; then
      echo "::error file=${manifest}::missing name or version" >&2
      fail=1
      continue
    fi

    set +e
    out=$(npm view "${name}" version 2>&1)
    rc=$?
    set -e

    if [ "$rc" -ne 0 ]; then
      if grep -qiE 'E404|not found|404' <<<"$out"; then
        printf '%-34s %-10s %-10s %s\n' "$name" "$version" "-" "NEVER PUBLISHED"
        echo "::error file=${manifest}::${name} has never been published; the first auto-tag on merge will publish ${version}" >&2
        fail=1
      else
        # Never guess. An unreadable registry is not evidence of agreement.
        printf '%-34s %-10s %-10s %s\n' "$name" "$version" "?" "LOOKUP FAILED"
        echo "::error file=${manifest}::could not read npm latest for ${name} (npm view exit ${rc}): ${out}" >&2
        fail=1
      fi
      continue
    fi

    if [ "$out" = "$version" ]; then
      printf '%-34s %-10s %-10s %s\n' "$name" "$version" "$out" "ok"
    else
      printf '%-34s %-10s %-10s %s\n' "$name" "$version" "$out" "DRIFT"
      echo "::error file=${manifest}::${name} is ${version} in this repo but ${out} on npm — the tag for ${version} was never pushed, or its publish run failed" >&2
      fail=1
    fi
  done <<<"$declared_tsv"
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "::error::check-published-packages.sh found problems — see the annotations above." >&2
  exit 1
fi

echo
echo "All checks passed."
