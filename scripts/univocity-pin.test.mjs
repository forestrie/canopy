import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main, parsePinsJsonc, resolveRange } from "./univocity-pin.mjs";

const rel = (tag, extra = {}) => ({
  tag_name: tag,
  prerelease: false,
  draft: false,
  ...extra,
});

test("highest matching release wins regardless of listing order", () => {
  const releases = [
    rel("v0.8.3"),
    rel("v0.8.10"),
    rel("v0.8.7"),
    rel("v0.9.0"),
  ];
  assert.equal(resolveRange(">=0.8.3 <0.9.0", releases), "v0.8.10");
});

test("a range matching no release fails loudly", () => {
  assert.throws(
    () => resolveRange(">=0.5.0 <0.6.0", [rel("v0.4.0"), rel("v0.8.7")]),
    /no release matches ">=0.5.0 <0.6.0"/,
  );
  assert.throws(() => resolveRange(">=0.5.0 <0.6.0", []), /no release/);
});

test("pre-releases and drafts are ignored", () => {
  const releases = [
    rel("v0.4.0"),
    rel("v0.4.2", { prerelease: true }),
    rel("v0.4.3-rc.1"),
    rel("v0.4.4", { draft: true }),
  ];
  assert.equal(resolveRange(">=0.4.0 <0.5.0", releases), "v0.4.0");
});

test("the upper bound is exclusive and the lower bound inclusive", () => {
  const releases = [rel("v0.4.0"), rel("v0.5.0")];
  assert.equal(resolveRange(">=0.4.0 <0.5.0", releases), "v0.4.0");
  assert.equal(resolveRange(">=0.5.0 <0.6.0", releases), "v0.5.0");
  assert.throws(() => resolveRange(">0.5.0 <0.6.0", releases), /no release/);
});

test("non-semver tags are skipped, unsupported ranges are rejected", () => {
  assert.equal(
    resolveRange(">=0.4.0 <0.5.0", [rel("nightly"), rel("v0.4.1")]),
    "v0.4.1",
  );
  assert.throws(() => resolveRange("^0.4.0", [rel("v0.4.1")]), /unsupported/);
  assert.throws(() => resolveRange("", [rel("v0.4.1")]), /unsupported/);
});

test("pins file parses with comments and requires a non-empty range", () => {
  const text = `{ // c "q"\n "schemaVersion": 1, "tools": ">=0.8.3 <0.9.0", }`;
  assert.equal(parsePinsJsonc(text, "tools"), ">=0.8.3 <0.9.0");
  assert.throws(() => parsePinsJsonc(text, "contracts"), /no non-empty/);
});

test("only a lower bound plus an exclusive upper bound within one minor", () => {
  const releases = [rel("v0.4.1")];
  for (const bad of [
    ">=0.4.0",
    "<0.5.0",
    ">=0.4.0 <0.6.0",
    ">=0.4.0 <=0.4.9",
    "0.4.1",
  ]) {
    assert.throws(() => resolveRange(bad, releases), /unsupported/, bad);
  }
  assert.equal(resolveRange(">=0.4.0 <0.4.5", releases), "v0.4.1");
});

test("a bad range fails before any release is listed", async () => {
  let listed = false;
  await assert.rejects(
    main(
      ["tools"],
      {},
      {
        readPins: () => `{"tools": ">=0.8.3"}`,
        listReleases: async () => ((listed = true), []),
        log: () => {},
      },
    ),
    /unsupported/,
  );
  assert.equal(listed, false);
});

test("the script runs as a CLI, directly and through a symlink", () => {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    "univocity-pin.mjs",
  );
  const link = join(mkdtempSync(join(tmpdir(), "pin-")), "pin.mjs");
  symlinkSync(script, link);
  for (const path of [script, link]) {
    const r = spawnSync("node", [path, "nonsense"], { encoding: "utf8" });
    assert.equal(r.status, 1, path);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^univocity-pin: usage: .*\n$/, path);
  }
});
