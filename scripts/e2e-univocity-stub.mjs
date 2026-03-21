#!/usr/bin/env node
/**
 * Minimal HTTP stub for canopy-api bootstrap branch (isLogInitialized → false).
 * Serves GET /api/logs/{logId}/config → 404 (log not initialized on chain).
 * Serves GET /api/root → { exists: false }.
 *
 * Used by scripts/start-e2e-local-stack.mjs; not a real Univocity service.
 */

import http from "node:http";

const port = Number(process.env.E2E_UNIVOCITY_STUB_PORT ?? "8792");

const server = http.createServer((req, res) => {
  const url = req.url ?? "";
  if (req.method === "GET" && /^\/api\/logs\/[^/]+\/config$/.test(url.split("?")[0])) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{}");
    return;
  }
  if (req.method === "GET" && url.split("?")[0] === "/api/root") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ exists: false, rootLogId: null }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "e2e stub: not found" }));
});

server.listen(port, "127.0.0.1", () => {
  console.error(`[e2e-univocity-stub] listening on http://127.0.0.1:${port}`);
});

function shutdown() {
  try {
    server.close();
  } catch (_) {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
