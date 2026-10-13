# #123 — guard evidence

HEAD: `82ee0aeda6680f7a19a088d3609fd5472b8eeb5a` (base `origin/develop` @ `da44b50`).
Tier: **Standard** (web UI). Branch: `feat-123-day-first-datetime`.

## Phase 1 — pre-commit

| Check | Command | Result |
|---|---|---|
| Typecheck | `bun run typecheck` | 3/3 packages pass, exit 0 |
| Lint | `bun run lint` (oxlint) | 0 warnings / 0 errors, exit 0 |
| Unit | `bun run test` (turbo) | 868 pass / 0 fail, exit 0 |

## Phase 2 — pre-push

| Check | Command | Result |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Unit | `bun run test` | 868 pass / 0 fail |
| E2E | `DOKAN_PORT=4387 DOKAN_WEB_PORT=5187 bun run test:e2e` | **55 pass / 0 fail** |
| Working tree | `git status` | clean at review time |

### E2E port note

The brief asks for isolated ports because sibling lanes share 4317/5173. The
vault spec additionally **hardcodes** `API_PORT = 4399` / `WEB_PORT = 5174`, so a
run on `DOKAN_PORT=4399` collides with it: the vault spec attaches to the wrong
API and fails on `getByRole("heading", { name: "إنشاء الخزنة" })`. Use ports that
avoid `4399/5174` (this run used `4387/5187`). The vault spec passed 3/3 both in
isolation and in the final full run.

## Review evidence

- `.scratch/reviews/123/5707a37-debate.md`
- `.scratch/reviews/123/5707a37-test-audit.md`
- `.scratch/reviews/123/5707a37-code-review.md`

All three name the exact reviewed HEAD. A later commit adds only `.scratch/`
files (non-reviewable), so the evidence stays valid.

## Evidence SHA reconciliation

The code under review is `5707a37`; HEAD `82ee0ae` adds only
`.agents/wisdom/2026-10-14-e2e-port-collisions-vault-spec.md`.
`git diff 5707a37..82ee0ae -- apps/ tests/ packages/` is empty, so the reviews
above remain valid for this HEAD. The commit after this one adds only these
`.scratch/reviews/123/` files, which are non-reviewable.

## Phase 3 — pre-report

- Local checks green (above).
- Review evidence current for Standard tier (debate + test-audit + code-review).
- No push and no PR in this lane — the parent owns landing. CI/Greptile are
  therefore not run here; the local Guard 2 run is the gate.
- Deferred items documented in the debate evidence.
