#!/usr/bin/env bash
# Emit wrangler --domain flags for one or more hostnames/URLs (comma-separated ok).
set -euo pipefail

trim_ws() {
  printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

trim_host() {
  local v
  v="$(trim_ws "$1")"
  v="${v#https://}"
  v="${v#http://}"
  v="${v%%/*}"
  printf '%s' "$v"
}

declare -A seen=()

for arg in "$@"; do
  IFS=',' read -ra parts <<<"${arg}"
  for part in "${parts[@]}"; do
    host="$(trim_host "${part}")"
    if [ -z "${host}" ] || [ -n "${seen[${host}]+x}" ]; then
      continue
    fi
    seen["${host}"]=1
    printf ' --domain %q' "${host}"
  done
done
