# Issue 174 — Round 1 code-review evidence

Base: `8bf2a81`. Round-1 delta: `e84d592..d8d21f4`. Evidence anchor:
`8e12e3d`.

Two read-only `reviewer` sub-agents reviewed the delta on opposite axes.
Standards sources: `AGENTS.md`, `CONTEXT.md`, `docs/engineering-workflow.md`,
`.agents/skills/` (plus the Fowler smell baseline). Spec: the round-1 brief and
issue #174.

## Standards axis

| Finding | Disposition |
|---|---|
| Design doc said `onWriteFailed` is optional; the code makes it required on `CustomerSettlePanel`. | **Fixed**: the design doc now states required for the settle panel and optional-but-wired for the supplier panels. |
| Duplicated payment arithmetic between the `invoicesPay` and `suppliersPay` test mocks. | **Fixed** in `d8d21f4`: shared `applyPayment(invoiceId, amount)` helper. |
| The 11-field inline supplier `entry` literal lacked a builder. | **Fixed**: `supplierEntry(over?)` factory beside `invoice(...)`. |
| Duplicated rationale prose (docblock + inline comment + design doc). | **Accepted** — one-line comments at the two call sites aid locality; not worth churning. |
| `renderCustomer`/`renderSupplier` one-line pass-throughs. | **Accepted** — read better than duplicating `renderParty`. |

## Spec axis

| Finding | Disposition |
|---|---|
| Brief: refresh the paged tab keys on partial settle failure. | **Verified** — `onWriteFailed` fires unconditionally in the settle catch; the page wires it. |
| Brief: a test that fails without the fix (first write succeeds, second fails → paid invoice shows paid, payment appears). | **Verified** — `refreshes the paged tabs after a partly failed settle`; confirmed it fails with the callback unwired. |
| Brief: cover the all-success path. | **Verified** — the success test now also asserts the payments tab re-reads. |
| Brief: probe the same stale-refresh class across all three tabs. | **Fixed**: invoices + payments via the settle loop; supplier entries via `onWriteFailed` on the four atomic supplier panels (their failure catch previously refreshed only `suppliersGet`). The supplier-pay failure test fails without the wiring. |
| Brief: no push. | **Verified** — the remote branch is unchanged; all work is local commits. |
| Brief: regenerate evidence at the new SHA; supersede the old. | **Done** — this file set is anchored to `d8d21f4`; the `830679a-*` / `f9bcaf3-*` files were removed. |
| Scope creep. | None material. |

No blocker remained on either axis after `d8d21f4`. The money path
(`partyDetail` full set, `distributePayment`, `deleteParty`) is untouched by the
round-1 delta.
