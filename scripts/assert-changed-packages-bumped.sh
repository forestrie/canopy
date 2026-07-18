#!/usr/bin/env bash
#
# assert-changed-packages-bumped.sh — FOR-401 release-hygiene guard.
#
# For every publishable package whose `src/` changed in this PR, assert its
# package.json version is NOT already published on npm — i.e. the version was
# bumped. Catches the FOR-390 regression class where a shared lib
# (@forestrie/encoding, grant-builder, canopy-e2e-kit) was edited in place
# without a version bump, so npm kept serving a stale build under the same
# version and the deployed stack silently drifted from the pinned kit tree.
#
# The (dir, name) list mirrors the publish-*.yml workflows. Keep it in sync when
# a new publishable package is added.
#
# Usage: assert-changed-packages-bumped.sh <base-ref-or-sha>
#   <base-ref-or-sha>  the PR base commit to diff against (github.event.pull_request.base.sha)

set -euo pipefail

base="${1:?usage: assert-changed-packages-bumped.sh <base-ref-or-sha>}"

# package-dir : each publishable package's directory (mirror publish-*.yml).
packages=(
  "packages/tests/e2e-kit"
  "packages/libs/chain-rpc"
  "packages/libs/delegation-cose"
  "packages/shared/encoding"
  "packages/libs/grant-builder"
  "packages/merklelog"
  "packages/libs/receipt-verify"
  "packages/libs/scrapi-client"
)

fail=0
checked=0
for dir in "${packages[@]}"; do
  if [ ! -f "${dir}/package.json" ]; then
    echo "::error::${dir}/package.json missing — update assert-changed-packages-bumped.sh" >&2
    fail=1
    continue
  fi

  # Only care when the published source changed in this PR.
  if git diff --quiet "${base}" HEAD -- "${dir}/src"; then
    continue
  fi
  checked=$((checked + 1))

  name=$(node -p "require('./${dir}/package.json').name")
  version=$(node -p "require('./${dir}/package.json').version")

  set +e
  out=$(npm view "${name}@${version}" version 2>&1)
  rc=$?
  set -e

  if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
    echo "::error file=${dir}/package.json::${name}@${version} is already published on npm, but ${dir}/src changed in this PR. Bump the version — a changed publishable package must ship a new version, or npm keeps serving a stale build under the same version (the FOR-390 regression; FOR-401)."
    fail=1
  elif [ "$rc" -ne 0 ] && ! grep -qiE "E404|not found|404" <<<"$out"; then
    echo "::error::could not determine whether ${name}@${version} is published (npm view exit ${rc}): ${out}" >&2
    fail=1
  else
    echo "OK: ${dir}/src changed and ${name}@${version} is unpublished (version was bumped)."
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "::error::One or more changed publishable packages were not version-bumped." >&2
  exit 1
fi

if [ "$checked" -eq 0 ]; then
  echo "No publishable package src changed in this PR."
else
  echo "All ${checked} changed publishable package(s) have unpublished (bumped) versions."
fi
