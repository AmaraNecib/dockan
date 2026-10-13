# Wisdom — 2026-10-14 · E2E isolated ports must dodge the vault spec's hardcoded 4399/5174 (#123)

## The failure looks like an app bug, not a port clash
Lane briefs say "use isolated ports (`DOKAN_PORT`/`DOKAN_WEB_PORT`) — sibling
lanes share 4317/5173", so `DOKAN_PORT=4399` looks like a safe isolated choice.
It is not. `tests/e2e/vault.spec.ts` hardcodes its own dedicated pair:

```ts
const API_PORT = 4399;
const WEB_PORT = 5174;
```

The vault spec spawns its own API + web in `beforeAll` and waits for
`http://127.0.0.1:4399/api/vault/status`. With `DOKAN_PORT=4399`, the Playwright
`webServer` (or a sibling lane's vault run) already owns that port:

- The vault spec's API fails to bind and exits, but `waitForOk` still sees a
  healthy API on 4399 — the **wrong** one (plaintext `DOKAN_VAULT=disabled`, or a
  sibling's already-initialised vault). `beforeAll` passes.
- The first vault test then fails at
  `getByRole("heading", { name: "إنشاء الخزنة" })` because the page shows
  «فتح الخزنة» (unlock) or the login form instead of first-run setup.

That symptom reads like a vault/bootstrap regression. It is not: the vault spec
passes 3/3 in isolation and in a full run once the port is free.

**Always**: pick E2E ports that avoid `4399` and `5174` as well as `4317`/`5173`
— e.g. `DOKAN_PORT=4387 DOKAN_WEB_PORT=5187`. If a full run fails only in
`vault.spec.ts` on the create-vault heading, check `netstat -ano | grep 4399`
and re-run the spec alone before suspecting app code.

## The failure mode is not a flake — it is a deterministic collision
Unlike a timing flake it reproduces whenever 4399 is held, and it can be caused
by a **concurrent sibling lane** running the same spec. Do not retry blindly:
confirm `curl -s http://127.0.0.1:4399/api/vault/status` returns nothing (port
free) before re-running, then re-run the full suite for a clean Guard 2 line.

## Details worth remembering
- Playwright's `webServer.reuseExistingServer: false` only protects the config's
  own pair; it does not stop `vault.spec.ts` from colliding on its hardcoded
  ports.
- `DOKAN_WEB_PORT` does not move the vault web server either — `WEB_PORT` is a
  literal in the spec.
- The main suite's API is reachable at `/api/vault/status` too, so a
  `waitForOk` on that URL cannot tell which API answered. The spec's isolation
  depends entirely on the port being free.
