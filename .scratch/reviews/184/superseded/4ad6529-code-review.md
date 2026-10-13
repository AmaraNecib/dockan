# Code-review evidence — #184 (two axes)

- Base: `da44b502d39c79a1368e9848542d9a25fac301fc`
- Reviewed head: `0860f3d`; final code head `a422880`
- Evidence head: `4ad6529` (code head `a422880` + non-reviewable evidence/wisdom commits)
- Tier: **High-assurance**
- Roles: Standards (`reviewer`) + Spec (`oracle`), parallel.

## Standards axis

Sources: `AGENTS.md`, `CONTEXT.md`, `docs/engineering-workflow.md`,
`docs/adr/0009-supplier-account-ledger.md`, `docs/adr/0011-supplier-adjustment-dedup-key.md`,
plus the Fowler smell baseline.

- **Hard violations: none.** The new read is behind `guardedInput`; ADR-0011's
  signature arm is reused unchanged; no lockfile/schema drifts.
- Smell: duplicate conflict rule in render and submit → factored into
  `conflictsWithFilled(destination)` (`a422880`).
- Smell: the typed row re-encoded `forwardsConfirm` → now calls it (`a422880`).
- Smell: the adjustment-signature literal travelled three times → one
  `openingSignature(...)` builder (`a422880`).
- Smell: the structural test is identifier-coupled → regex broadened; documented
  as a heuristic guard (`a422880`).
- `resolveForSubmit` reads as a middle man but is a deliberate error/guard seam.

## Spec axis

| Requirement (brief) | Status |
|---|---|
| Dialog destination comes from the server | ✅ `matchByNormalizedName` deleted; `suppliersResolveName` rendered |
| Tie-break in exactly one place | ✅ `opening-balance-resolver.ts`; write and read call the same function |
| Test asserts dialog == write with two folded names | ✅ api (id + name) and E2E (balance on the named account) |
| Existing tests stay green | ✅ full unit suite + E2E |
| Structural assertion the client no longer re-implements it | ✅ (heuristic; strengthened) |
| Behaviour otherwise unchanged (flow, `confirmExisting`, Arabic copy) | ✅ flow/copy unchanged; a conflict is still prevented before send |
| Do not touch schema / bump version | ✅ no migration |
| Do not weaken #177 signature guard | ✅ same arm, one builder |
| Do not fold in #183 | ✅ one name → one destination, no list |

Spec findings and resolutions:

1. **Scope extension flagged (intended):** `expectedSupplierId` and
   `OPENING_BALANCE_TARGET_CHANGED` are new contract surface. They *strengthen*
   the shown-vs-written property the issue exists for (and close the debate
   critic's F1/F2); not a spec violation. Documented in the design doc.
2. **Stale `typedDestination` snapshot blocked a valid save after cancel.**
   **Fixed** (`a422880`): `closeConfirm()` clears the snapshot on cancel and on
   success; test `drops the dialog destination on cancel so it cannot block a
   later name`.
3. **`expectedSupplierId` accepted on an explicit `supplierId` row and silently
   ignored.** **Fixed**: the row schema's `superRefine` now rejects it; api test
   `rejects expectedSupplierId on an explicit supplierId row at the contract`.
4. **Structural guard narrow.** Addressed as above (broadened; still heuristic).
5. **Doc drift** (`row` param, `ensureQueryData`). **Fixed** in the design doc.

## Summary

- Standards: 0 hard violations; all smells either fixed or dismissed with reasons.
- Spec: all acceptance criteria met; the one medium finding (stale snapshot) and
  the contract looseness were fixed; the `expectedSupplierId` extension is
  deliberate and documented.

## Evidence

- Raw outputs: `.scratch/reviews/184/0860f3d-code-review-raw.{standards,spec}.md`.
- Fix commit: `a422880`.
