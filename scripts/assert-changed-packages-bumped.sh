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
# The package list is READ FROM `.github/auto-tag-packages.json`, which the
# auto-tag workflow uses to decide what to tag on merge (devdocs plan-2608-06
# Phase 2). It used to be a copy maintained here by hand alongside a "keep it in
# sync" comment; a third copy of the same list is exactly how a package ends up
# unguarded and unpublished. `scripts/check-published-packages.sh config` holds
# that file and the publish-*.yml tag patterns to each other.
#
# Usage: assert-changed-packages-bumped.sh <base-ref-or-sha>
#   <base-ref-or-sha>  the PR base commit to diff against (github.event.pull_request.base.sha)

set -euo pipefail

base="${1:?usage: assert-changed-packages-bumped.sh <base-ref-or-sha>}"

CONFIG="${CONFIG:-.github/auto-tag-packages.json}"
if [ ! -f "$CONFIG" ]; then
  echo "::error::${CONFIG} not found — it is the source of truth for which packages this repo publishes" >&2
  exit 1
fi

# An empty list would make this guard pass vacuously, which is worse than
# failing: every changed package would look unguarded-but-fine.
packages=()
while IFS= read -r pkg_dir; do
  [ -n "$pkg_dir" ] && packages+=("$pkg_dir")
done < <(jq -r '.packages[].dir' "$CONFIG")
if [ "${#packages[@]}" -eq 0 ]; then
  echo "::error::${CONFIG} declares no packages — refusing to pass vacuously" >&2
  exit 1
fi

fail=0
checked=0
for dir in "${packages[@]}"; do
  if [ ! -f "${dir}/package.json" ]; then
    echo "::error file=${CONFIG}::declares '${dir}' but ${dir}/package.json is missing" >&2
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
