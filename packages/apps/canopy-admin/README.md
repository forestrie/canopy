# Canopy onboard admin UI

Static ops console for FOR-172. Open `index.html` in a browser (or serve via
Cloudflare Pages) and configure:

- Canopy API base URL
- `CANOPY_OPS_ADMIN_TOKEN` (sessionStorage only)

Uses JSON admin routes under `/api/onboarding/admin/**` (see ADR-0009).
