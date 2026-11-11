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
// A range is exactly a lower bound (>= or >) and an exclusive upper bound (<)
// over X.Y.Z that stays within one major.minor, e.g. ">=0.4.0 <0.5.0". Anything
// else is rejected rather than guessed at: a wider range would let a minor
// release (ABI or signing changes) in without a reviewed change.
//
// GitHub auth: GH_TOKEN / GITHUB_TOKEN when set (CI), else an authenticated
// `gh` (local runs), else unauthenticated with a warning.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPOS = {
  tools: "forestrie/univocity-tools",
  contracts: "forestrie/univocity",
};

export function main(argv, env, io) {
  const key = argv[0];
  if (!Object.hasOwn(REPOS, key ?? "")) {
    return Promise.reject(
      new Error("usage: univocity-pin.mjs tools|contracts"),
    );
  }
  return Promise.resolve()
    .then(() => {
      // Validate the range before spending an API call on the listing.
      const range = parsePinsJsonc(io.readPins(), key);
      parseRange(range);
      return range;
    })
    .then(async (range) => {
      const releases = await io.listReleases(REPOS[key], env);
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
  const bad = (why) => new Error(`unsupported range "${range}" (${why})`);
  const parts = range.trim().split(/\s+/);
  if (parts.length !== 2) throw bad("need a lower and an upper bound");
  const [lo, hi] = parts.map((part) => {
    const m = /^(>=|>|<)(\d+\.\d+\.\d+)$/.exec(part);
    if (!m) throw bad(`at "${part}"`);
    return { op: m[1], v: parseVersion(m[2]) };
  });
  if (lo.op === "<" || hi.op !== "<") {
    throw bad("lower bound first (>= or >), then an exclusive upper (<)");
  }
  const ceiling = [lo.v[0], lo.v[1] + 1, 0];
  if (compareVersions(lo.v, hi.v) >= 0 || compareVersions(hi.v, ceiling) > 0) {
    throw bad(`must stay within ${lo.v[0]}.${lo.v[1]}.x`);
  }
  return [
    (v) =>
      lo.op === ">="
        ? compareVersions(v, lo.v) >= 0
        : compareVersions(v, lo.v) > 0,
    (v) => compareVersions(v, hi.v) < 0,
  ];
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
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60_000,
        },
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
        signal: AbortSignal.timeout(30_000),
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

if (isMainModule()) {
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

// process.argv[1] may be a symlink while import.meta.url is already resolved
// (or the reverse), so compare real paths; a false negative here would exit 0
// with no output, which downstream reads as "no version" and so as latest.
function isMainModule() {
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}
