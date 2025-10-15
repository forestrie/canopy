# Canopy

A SvelteKit-based transparency log surface implementing portions of the SCITT SCRAPI draft with CBOR-only responses (except `/api/health`).

## Endpoints (baseline)

- `/.well-known/scitt-configuration` — Transparency configuration (CBOR)
- `/api/v1/keys` — Transparency Service Keys (CBOR; may be empty)
- `/api/v1/logs/{logId}/statements` — Register Signed Statement (POST, CBOR-only). Returns 202 with statement identity.
- `/api/health` — JSON health check (only JSON endpoint)

## Notes

- Statements are stored in Cloudflare R2 under `logs/{logId}/leaves/{fenceIndex}/{md5}` with MD5 used for content addressing (not security).
- `fenceIndex` is currently provided by a mock service (returns 0).
- All SCRAPI endpoints strictly use `application/cbor` for request and response bodies; concise CBOR problem details are returned on errors.
