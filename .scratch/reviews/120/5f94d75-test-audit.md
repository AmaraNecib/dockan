# Issue #120 — Integration-round test-audit evidence (post-rebase)

- **Reviewed integration HEAD:** `5c26a8a473cfab2a38a6b09d7dfbfb25580e539f`
- **Final code HEAD / this file:** `a8f02b9232616d31b3a7bf47286d1e4baef8b1cf`
- **Pre-rebase reviewed code:** `60573aff2bb896aac06ac84683924ec4b8d2e52b`
- **Method:** one read-only reviewer over `git diff 60573af 5c26a8a` and the
  final tree (static), synthesised with the lane's executed gate runs.

## Results

| Check | Result |
|-------|--------|
| #119 quick-add tests survive (blank / `0` / positive stock, invalid, scan focus) | **PASS** — the block at `sale.test.tsx:762-858` is byte-for-byte identical to `a0b9671`; the removed two-button affordance left no dangling assertion anywhere |
| #120 party-picker test survives and asserts `counterpartyId` | **PASS** — `sale.test.tsx:860-892`, asserts id and name; only a defensive `await` was added by the resolution |
| Party-detail date change invalidates no unit/e2e assertion | **PASS** — no test asserted those cells; the change is covered by `lib/dates.test.ts` unit tests |
| Coverage lost during the rebase | **None** — 41 `it(` after vs 36 before (+5 from #119); every pre-rebase #120 test survives |

## Finding and resolution

| Finding | Decision |
|---------|----------|
| **Low** — no cell-level assertion that `party-detail.tsx` actually renders the shared formatter; a revert to raw values would keep the suite green | **Fixed at a8f02b9**: `parties.test.tsx` asserts the invoice date cell (`01/10/2026`), the payment date cell (`01/10/2026 10:05`), and `party-created-at` (`01/10/2026 10:00`) |

## Executed gates at the final integration SHA

- `bun run typecheck` — 3/3 pass
- `bun run lint` — 0 errors
- `bun run test` — 466 web tests + API suites pass
- `bun run test:e2e` — 38/38 pass (full suite)

## Flake note

One full-suite run after the #122 base refresh failed
`learnability.spec.ts:162` (`addStockedLine` scanner loop: the second generated
barcode had not landed when the line was asserted). The spec passed in
isolation (7/7) and the next full-suite run passed 38/38, so it is the known
scan-burst timing flake under load (wisdom 2026-08-24-deterministic-timing-tests),
not a regression from this rebase.

The earlier test-audit rounds remain valid for the pre-rebase code:
`.scratch/reviews/120/a4647f5-test-audit.md` and `4cda79c-test-audit.md`.
