#!/usr/bin/env bash
# assert-publish-version.sh — shared publish-workflow version guard (FOR-365 C3).
#
# Two modes, selected by GITHUB_REF:
#
#   Tag build (refs/tags/<tag-prefix>-v*):
#     Assert the version named by the tag equals the package's package.json
#     version, so a tag can never publish a version other than the one it
#     names. Runs before build/publish so a mismatch fails fast.
#
#   Dispatch build (anything else — workflow_dispatch recovery path):
#     Assert the package.json version is NOT already on the registry
#     (`npm view <name>@<version>` must 404), so a recovery dispatch can only
#     publish a version that has never shipped.
#
# Usage: assert-publish-version.sh <package-dir> <tag-prefix>
#   e.g. assert-publish-version.sh packages/shared/encoding encoding
#
# Requires node (to read package.json) and npm (registry lookup) on PATH.

set -euo pipefail

pkg_dir="${1:?usage: assert-publish-version.sh <package-dir> <tag-prefix>}"
tag_prefix="${2:?usage: assert-publish-version.sh <package-dir> <tag-prefix>}"

name=$(node -p "require('./${pkg_dir}/package.json').name")
version=$(node -p "require('./${pkg_dir}/package.json').version")
ref="${GITHUB_REF:-}"

case "$ref" in
  "refs/tags/${tag_prefix}-v"*)
    tag="${ref#refs/tags/}"
    tag_version="${tag#"${tag_prefix}"-v}"
    if [ "$tag_version" != "$version" ]; then
      echo "::error::tag ${tag} names version ${tag_version} but ${pkg_dir}/package.json is ${version}; retag or bump so they agree" >&2
      exit 1
    fi
    echo "OK: tag ${tag} matches ${name}@${version}"
    ;;
  refs/tags/*)
    echo "::error::ref ${ref} is a tag but does not match ${tag_prefix}-v*; refusing to publish ${name} from a foreign tag" >&2
    exit 1
    ;;
  *)
    # workflow_dispatch (recovery only): the version must not already exist.
    set +e
    out=$(npm view "${name}@${version}" version 2>&1)
    rc=$?
    set -e
    if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
      echo "::error::${name}@${version} is already published; bump ${pkg_dir}/package.json before a recovery dispatch" >&2
      exit 1
    fi
    if [ "$rc" -ne 0 ] && ! grep -q "E404" <<<"$out"; then
      echo "::error::could not determine whether ${name}@${version} exists on the registry (npm view exit ${rc})" >&2
      echo "$out" >&2
      exit 1
    fi
    if [ "$rc" -eq 0 ]; then
      # exit 0 with empty output is ambiguous — refuse rather than guess.
      echo "::error::npm view ${name}@${version} returned success with no output; refusing to proceed on ambiguity" >&2
      exit 1
    fi
    echo "OK: ${name}@${version} is not on the registry; dispatch publish may proceed"
    ;;
esac
