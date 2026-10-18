# Issue #63 — two-axis code review evidence

- Base: `a9d2bca` (`origin/develop` merge-base)
- Reviewed head: `75c001c` (implementation commit)
- Diff: `git diff a9d2bca...75c001c`
- Axes: Standards + Spec, run as two parallel `reviewer` sub-agents.

## Standards axis

Hard violations: none (no documented rule in AGENTS.md / CONTEXT.md /
docs/engineering-workflow.md is engaged).

Findings and disposition:

1. **Copy regression — purchase with no counterparty lost "من مورد".**
   (hard violation of the spec's "no copy regression" intent.)
   **Fixed.** `activityPurchaseCreatedNoParty` removed; the parser now
   defaults the party to the new `activitySupplierDefault: "مورد"` key, so the
   rendered sentence is byte-identical to before.
2. Shotgun surgery / primitive obsession: token strings duplicated between
   emitter and parser; `1|0` stringified boolean.
   **Partially fixed.** The expense flag is now `WITHDRAWAL`/`OPERATING`
   (self-describing, no stringified boolean). Sharing the tag constants in
   `packages/contracts` is a larger refactor across the whole activity surface
   and is out of scope for this lane (noted as a possible follow-up).
3. Parser had a partly-dead `type` parameter (`if (type === … && tag === …)`).
   **Fixed.** The parser is now `(t, summary)` and dispatches on the tag alone;
   call site updated. Returns branches no longer carry the redundant guard.
4. Guard hole: `locale-neutral.test.ts` does not scan `rpc/router.ts` (it keeps
   the legacy Arabic constant) or files with Arabic doc comments.
   **Mitigated.** The guard now also covers `main.ts`, `admin.ts`,
   `activity.tsx`, `stock.tsx`, `invoice.tsx`, `expenses.tsx`,
   `receipt-view.tsx`; the activity wire test additionally asserts the emitted
   summary tags are ASCII tokens.

## Spec axis

Findings and disposition:

1. **`drizzle-store.ts` seed category names left Arabic** (`عام` + 7 expense
   defaults, lines 44–50 and 662). The spec lists the file in scope.
   **Deferred with a decision request** (see crew report). These are persisted
   *data* names, not assembled copy; localizing seeded defaults is a data-model
   decision plus a migration for existing DBs. A rename-only change would leave
   fresh installs in a token while existing DBs stay Arabic — the half-migrate
   the spec warns against. Not silently whitelisted: the guard doc names it.
2. `stock.tsx` / `activity.tsx` are beyond the spec's web list but are required
   to render the new tokens — justified, not scope creep.
3. `receipt-print.tsx` was listed in scope but correctly untouched (only Arabic
   is a doc comment), consistent with the out-of-scope clause.
4. `admin.ts` `name: ""`: removes copy by blanking stored identity data and
   relying on the sidebar's existing `t("shellUser")` fallback.
   **Accepted.** Verified the only `user.name` consumers are
   `app-shell.tsx` → `app-sidebar.tsx`, both of which fall back on falsy
   (`displayName(user) || t("shellUser")`), and `avatarText()` already handles a
   missing name via phone digits. `admin.test.ts` passes (13/13).
5. Correction-prefix dual-match is correct and complete: the only write site is
   `router.ts` `INVOICE_CORRECTION`, the only read site uses
   `isCorrectionReason()` covering both prefixes, and the new regression test
   proves a pre-token Arabic row still reverses the right quantity.

## Verification run

- `bun run --filter @dokan/api typecheck` — exit 0
- `bun run --filter @dokan/web typecheck` — exit 0
- `bun run lint` — exit 0
- `bun run --filter @dokan/api test` — 445 pass / 0 fail
- `bun run --filter @dokan/web test` — 196 pass / 0 fail
- Hardcoded Arabic in production code lines (tests/i18n.ts/comments excluded):
  **49 → 9** (remaining 1 = intentional legacy prefix constant; 8 = deferred
  seed names).
