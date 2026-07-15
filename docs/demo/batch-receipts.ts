// Batch demo: register N statements -> ONE checkpoint covers them all ->
// derive ALL N receipts OFFLINE in one pass (no per-receipt operator call).
//
// Amortization: submission is ~instant per statement; the receipt "latency" is
// a SINGLE checkpoint wait shared by the whole batch, after which every receipt
// is derived offline from one massif + one checkpoint.
//
// Ranger nuance (observed on lane-A): a trailing partial massif is committed
// only when the NEXT write arrives, so the batch's last entries would otherwise
// sit unsealed indefinitely. We submit a few extra "flush" statements after the
// batch to push all N real entries into a committed + sealed massif; the flush
// statements themselves become the new (ignored) tail.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const N = Number(process.env.N ?? "20");
const FLUSH = Number(process.env.FLUSH ?? "3");
const BASE = process.env.FORESTRIE_BASE_URL!;
const ROOT = process.env.ROOT_LOG_ID!;
const PEM = process.env.BOOTSTRAP_PEM!;
const GRANT = readFileSync(process.env.GRANT_FILE!, "utf8").trim();
const STORE = process.env.LOG_STORE_URL!;
// Invoke the forestrie CLI. Default: the installed `forestrie` on PATH.
// Set FORESTRIE_CLI_DIR to run the repo copy in dev mode (rehearsal).
const CLI_DIR = process.env.FORESTRIE_CLI_DIR;
const sh = (args: string[]) =>
  CLI_DIR
    ? spawnSync("bun", ["run", "--cwd", CLI_DIR, "dev", ...args], { encoding: "utf8" })
    : spawnSync("forestrie", args, { encoding: "utf8" });
const tmp = "/tmp/batch";

// Submit one signed statement; return its SCRAPI entry-id (idtimestamp||mmrIndex,
// 32 hex) once sequenced. The register 303 -> a status resource; polling it 303s
// to the receipt URL whose /entries/<32hex>/ segment IS the entry-id.
async function submitOne(tag: string, slot: number): Promise<string> {
  const p = `${tmp}.${slot}.json`, c = `${tmp}.${slot}.cose`;
  writeFileSync(p, JSON.stringify({ claim: tag }));
  sh(["sign-statement", "--key", PEM, "--payload", p, "--content-type", "application/json", "--out", c]);
  const post = await fetch(`${BASE}/register/${ROOT}/entries`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/cose", Authorization: `Forestrie-Grant ${GRANT}` },
    body: readFileSync(c),
  });
  const statusUrl = post.headers.get("location");
  if (!statusUrl) throw new Error(`submit ${tag}: no 303 (${post.status})`);
  for (let a = 0; a < 60; a++) {
    const s = await fetch(statusUrl.startsWith("http") ? statusUrl : `${BASE}${statusUrl}`, { redirect: "manual" });
    const loc = s.headers.get("location");
    // the receipt URL carries the sequenced entry-id: /<h>/entries/<32hex>/receipt
    const m = loc?.match(/\/entries\/([0-9a-f]{32})\/receipt/);
    if (s.status === 303 && m) return m[1];
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`entry ${tag} not sequenced`);
}

const t0 = Date.now();
// 1. submit N statements concurrently (the batch we amortize receipts over)
const entryIds = await Promise.all(
  Array.from({ length: N }, (_, i) => submitOne(`batch statement ${i}`, i)),
);
const tSubmit = Date.now();
console.log(`submitted+sequenced ${N} statements in ${((tSubmit - t0) / 1000).toFixed(1)}s`);

// 1b. flush: push the N real entries into a committed+sealed massif
await Promise.all(Array.from({ length: FLUSH }, (_, i) => submitOne(`flush ${i}`, N + i)));

// 2. Wait for ONE checkpoint that COVERS the whole batch. The authoritative
//    coverage signal IS the offline derivation itself: re-fetch massif +
//    checkpoint from public R2 and try to derive the LAST real entry's receipt
//    offline. Success => the single checkpoint covers all N.
const H = "14", IDX = "0000000000000000";
const ckptUrl = `${STORE}/v2/merklelog/checkpoints/${H}/${ROOT}/${IDX}.sth`;
const massifUrl = `${STORE}/v2/merklelog/massifs/${H}/${ROOT}/${IDX}.log`;
// Concurrent submission sequences entries out of order, so probe the entry with
// the HIGHEST mmrIndex (low 8 bytes of the entry-id, big-endian): once IT is
// covered, every entry with a lower index is too.
const mmrIdx = (id: string) => BigInt("0x" + id.slice(16));
const lastId = entryIds.reduce((a, b) => (mmrIdx(b) > mmrIdx(a) ? b : a));
let covered = false;
for (let a = 0; a < 90; a++) {
  const [mResp, cResp] = [await fetch(massifUrl), await fetch(ckptUrl)];
  if (mResp.ok && cResp.ok) {
    writeFileSync(`${tmp}.massif.log`, new Uint8Array(await mResp.arrayBuffer()));
    writeFileSync(`${tmp}.ckpt.sth`, new Uint8Array(await cResp.arrayBuffer()));
    const probe = sh(["create-receipt", "--massif", `${tmp}.massif.log`, "--checkpoint", `${tmp}.ckpt.sth`, "--entry-id", lastId, "--out", `${tmp}.probe.cbor`]);
    if (probe.status === 0) { covered = true; break; }
  }
  await new Promise(r => setTimeout(r, 2000));
}
const tCkpt = Date.now();
console.log(`ONE checkpoint now covers all ${N} ${covered ? "after" : "NOT after"} ${((tCkpt - tSubmit) / 1000).toFixed(1)}s`);
if (!covered) process.exit(1);

// 3. derive ALL N receipts OFFLINE from that ONE massif + checkpoint (zero
//    operator calls). This is the amortization: one seal, N receipts.
const tOff0 = Date.now();
let ok = 0;
for (const id of entryIds) {
  const r = sh(["create-receipt", "--massif", `${tmp}.massif.log`, "--checkpoint", `${tmp}.ckpt.sth`, "--entry-id", id, "--out", `${tmp}.r.${id.slice(0, 12)}.cbor`]);
  if (r.status === 0) ok++;
  else if (ok === 0) console.error(`  derive ${id}: ${(r.stderr || r.stdout || "").trim().slice(0, 160)}`);
}
console.log(`derived ${ok}/${N} receipts OFFLINE (zero operator calls) in ${((Date.now() - tOff0) / 1000).toFixed(1)}s`);
