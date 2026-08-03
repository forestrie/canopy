#!/usr/bin/env bash
# Read one last-good univocity pin from univocity-last-good.jsonc.
#
# Usage: univocity-last-good.sh tools|contracts
#
# One reader so the pin has one spelling. Fails LOUDLY on a missing file, an
# unparseable file, or a missing/empty key, and prints NOTHING on failure: an
# empty version silently becomes "latest" downstream (`cart fetch-release` with
# no --release), which is precisely the unpinned behaviour these pins remove.
set -euo pipefail

key="${1:-}"
case "$key" in
  tools | contracts) ;;
  *)
    echo "usage: $(basename "$0") tools|contracts" >&2
    exit 2
    ;;
esac

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pins="${here}/../univocity-last-good.jsonc"

if [ ! -f "$pins" ]; then
  echo "univocity-last-good.jsonc not found at ${pins}" >&2
  exit 1
fi

# Comment/trailing-comma stripping is string-aware — the same shape as canopy's
# `parsePinContractJsonc`. A naive `sed` mangles any comment containing a quote,
# and this file's rationale is full of them.
exec python3 - "$pins" "$key" <<'PY'
import json
import re
import sys

path, key = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()

without_comments = re.sub(
    r'("(?:\\.|[^"\\])*")|/\*[\s\S]*?\*/|//[^\n]*',
    lambda m: m.group(1) or "",
    text,
)
without_trailing_commas = re.sub(r",(\s*[}\]])", r"\1", without_comments)

try:
    pins = json.loads(without_trailing_commas)
except json.JSONDecodeError as exc:
    sys.exit(f"{path} is not parseable JSONC: {exc}")

value = pins.get(key)
if not isinstance(value, str) or not value.strip():
    sys.exit(f"{path} has no non-empty '{key}' pin")

sys.stdout.write(value.strip())
PY
