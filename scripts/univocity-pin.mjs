#!/usr/bin/env node
// Resolve a univocity pin range to a release tag.
//
// Usage: node scripts/univocity-pin.mjs tools|contracts
//
// Reads the range for the key from univocity-last-good.jsonc, lists the
// matching GitHub repo's releases, and prints the highest matching
// non-prerelease tag on stdout (the tag is also logged on stderr). Fails
// loudly, printing nothing on stdout, when the range matches no release: an
// empty version would silently become "latest" in `cart fetch-release`.
//
// Ranges are space-separated comparators (>=, >, <=, <, =) over X.Y.Z, all of
// which must hold, e.g. ">=0.4.0 <0.5.0". Anything else is rejected rather
// than guessed at.
//
// GitHub auth: GH_TOKEN / GITHUB_TOKEN when set (CI), else an authenticated
// `gh` (local runs), else unauthenticated with a warning.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPOS = {
  tools: "forestrie/univocity-tools",
  contracts: "forestrie/univocity",
};

export function main(argv, env, io) {
  const key = argv[0];
  if (!(key in REPOS)) {
    throw new Error("usage: univocity-pin.mjs tools|contracts");
  }
  return io.listReleases(REPOS[key], env).then((releases) => {
    const range = parsePinsJsonc(io.readPins(), key);
    const tag = resolveRange(range, releases);
    io.log(`univocity ${key}: range "${range}" resolved to ${tag}`);
    return tag;
  });
}

export function resolveRange(range, releases) {
  const comparators = parseRange(range);
  let best;
  for (const release of releases) {
    if (release.prerelease || release.draft) continue;
    const version = parseVersion(release.tag_name);
    if (!version || !comparators.every((ok) => ok(version))) continue;
    if (!best || compareVersions(version, best.version) > 0) {
      best = { version, tag: release.tag_name };
    }
  }
  if (!best) {
    throw new Error(
      `no release matches "${range}" (non-prerelease, semver tags only)`,
    );
  }
  return best.tag;
}

export function parsePinsJsonc(text, key) {
  const withoutComments = text.replace(
    /("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (_, str) => str ?? "",
  );
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, "$1");
  const pins = JSON.parse(withoutTrailingCommas);
  const value = pins[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`pins file has no non-empty '${key}' range`);
  }
  return value.trim();
}

function parseRange(range) {
  const parts = range.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error(`unsupported range "${range}"`);
  return parts.map((part) => {
    const m = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(part);
    if (!m) throw new Error(`unsupported range "${range}" (at "${part}")`);
    const bound = parseVersion(m[2]);
    const test = {
      ">=": (c) => c >= 0,
      ">": (c) => c > 0,
      "<=": (c) => c <= 0,
      "<": (c) => c < 0,
      "=": (c) => c === 0,
    }[m[1] ?? "="];
    return (v) => test(compareVersions(v, bound));
  });
}

// Strict X.Y.Z with an optional leading "v"; a pre-release or build suffix
// makes the tag unparseable and so ineligible.
function parseVersion(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

async function listReleases(repo, env) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) {
    try {
      const out = execFileSync(
        "gh",
        ["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return JSON.parse(out).flat();
    } catch {
      console.error(
        "warning: no GH_TOKEN/GITHUB_TOKEN and no usable gh login; " +
          "listing releases unauthenticated (rate limited)",
      );
    }
  }
  const releases = [];
  for (let page = 1; ; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
    );
    if (!res.ok) {
      throw new Error(`listing ${repo} releases: HTTP ${res.status}`);
    }
    const batch = await res.json();
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  main(process.argv.slice(2), process.env, {
    listReleases,
    readPins: () =>
      readFileSync(join(here, "..", "univocity-last-good.jsonc"), "utf8"),
    log: (line) => console.error(line),
  }).then(
    (tag) => process.stdout.write(tag),
    (err) => {
      console.error(`univocity-pin: ${err.message}`);
      process.exit(1);
    },
  );
}
