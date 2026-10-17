# #257 review round 4 — the in-flight invoice save can be made to stock a replaced product

**Tier:** standard.
**Justification:** the diff is one page's render/handler code plus its unit tests.
It moves no money arithmetic, no stock arithmetic, no debt direction, no
auth/RBAC and no backup/restore path — the invoice payload is untouched, only the
window in which the draft can change under it is closed. Standard gates apply:
guard 1 → quality check → test-audit → code-review → guard 2.

**Base:** `feat-257-inline-product` (PR #266), head `dc6c8cb` = `origin/feat-257-inline-product`.
This lane's worktree was cut from the stale local `feat-257-inline-product`
(`5723f91`, 8 behind) instead of the PR head, so the lane reset its own branch to
`dc6c8cb` before any edit (no lane commits existed yet); without that the lane's
commit would have reverted rounds 2 and 3.

## The defect (Greptile 4/5 at `dc6c8cb`, Issue 1)

`apps/web/src/pages/purchase.tsx:754` is the line create form's submit:

```tsx
<Button type="submit" disabled={createItem.isPending} data-testid="line-product-save">
```

`createItem.isPending` covers only the item write. The *invoice* write is a
different mutation, and every control that changes `lines` stays live while it is
out: the line's create form and its trigger, the line's catalog picker, the row's
quantity/cost inputs and remove button, the append picker, and the quick-add
submit. `submit()` (`purchase.tsx:340`) maps `lines` into the request body, so
from that moment the request carries a snapshot the screen can still edit:

- the owner starts a slow save of a line holding product A;
- while it is out he creates product B from that line (or picks B);
- the create lands, `landOnLine` re-points the line at B;
- the invoice stocks **A**;
- `createInvoice.onSuccess` runs `draft.reset()`, so the screen B was placed on
  is wiped and the divergence never surfaces.

This is the mirror of round 2 (`893ab0e`): there the save was blocked while a
**line create** was in flight (`lineCreatePending`); here the **line form stays
operable while the save** is in flight. Round 2 fixed one direction of the same
ordering.

## The fix — one predicate, at the source

```tsx
const savePending = createInvoice.isPending;
```

While `savePending`, every control that mutates the draft the request already
serialised is disabled, and the line-create handler refuses a submit before it
starts a write. The invariant is stated once: **the invoice draft is read-only
from the moment the save goes out until it answers.** Two consequences:

- disabled: the line's create trigger, the line create form's submit, the line's
  catalog picker button, the row's quantity input, unit-cost input and remove
  button, the notes field (it rides in the same request), both append-picker
  buttons (`purchase-open-picker`), and the quick-add submit;
- still enabled on purpose: the line create form's fields (typing is a local
  draft, harmless, and throwing away half-typed text would be the round-2 "dead
  end" complaint), its **Cancel** (round 2: *"Cancel is never disabled — a hung
  write must not trap the owner"*), and the quick-add disclosure toggle (a
  control that must be able to collapse what it opened).

A `role="status"` line (`purchase-lines-frozen`) states why the table is dead —
the same reason round 2 gives for `purchase-save-pending`: a disabled control
with no stated reason is a dead end for a keyboard or screen-reader user.

### Which mechanism, and the reachable path

Round 2's precedent is `disabled={... || lineCreatePending !== null}` on the save
button. The **disabled control is the block** here too, and I say so rather than
selling the handler guard as the fix:

| re-point path | block | reachable while saving? |
|---|---|---|
| line create form (`purchase-line-product-form`) | submit `disabled`, trigger `disabled` | no; the guard in `submitLineCreate` is the belt for a submit no disabled button produced (dispatched in the test) |
| line catalog picker | `purchase-line-pick-*` `disabled`, plus a `pickItem` guard | no mouse path: the dialog is `aria-modal` with a full-viewport backdrop, so a dialog opened *before* the save also swallows the Save click. The guard is the belt for a Save click the backdrop does not block (a scripted one); the test drives that on a dialog already open and shows the line keeps its product |
| row quantity / cost / remove, notes, append picker, quick-add submit, supplier picker, payment | `disabled` | no |

The two guards (`submitLineCreate`, `pickItem`) exist for the same reason: they are
the seam a caller reaches when the control is not actually disabled — round 2's
exact warning. Both are proved, not asserted: one test dispatches a `submit` event
on the open form, the other picks from a dialog that is already open.

## Out of scope, named

Round 2's own message already defers the opposite window: *"A quick-add in flight
does not block the invoice save either … Follow-up candidate: one
pending-placement gate covering both create paths."* This round does not touch
it: the quick-add's landing (`onCreated`) is not gated by `lineCreatePending`, and
freezing it here would silently drop a line the owner asked for and contradict
the deferral the parent already recorded. The window needs the pending-placement
gate, not a bigger `disabled` term.

## Tests

New, in `apps/web/src/pages/purchase.test.tsx` (the `#257` describe block):

1. `refuses to re-point a line while the invoice save is in flight (round 4, F1)`
   — a gated `invoicesCreate` holds the save pending; the line's create trigger
   and picker are disabled, the form does not open, the request payload still
   names the product the owner chose, nothing was created; after release the save
   the owner chose is the one that landed.
2. `refuses a line-create submit that no disabled button produced (round 4, F1 belt)`
   — the form is opened and typed *before* the save; the submit is disabled and a
   dispatched `submit` event starts no create.
3. `refuses a catalog pick that would re-point a line under the in-flight save (round 4, F1 belt)`
   — the line's picker dialog is open *before* the save; a pick from it does not
   re-point the line and the payload is untouched.
4. `freezes the rest of the invoice draft while the save is in flight (round 4, F1)`
   — quantity, unit cost, remove, notes, append picker and quick-add submit are all
   disabled, and the frozen table states the reason.

Also new, in `tests/e2e/purchase-inline-product.spec.ts`:

5. `the invoice draft is frozen while the save is in flight (#257 round 4)` — the
   real browser flow with the `invoicesCreate` response held open by `page.route`
   (the state lasts one local round-trip, so the delay is the only way to observe
   it). Asserts the controls are enabled before the save, disabled and explained
   during it, and that the save books the product at the quantity and cost the
   frozen controls showed. Against the pre-fix tree it is the round-4 e2e red:
   `getByTestId('purchase-lines-frozen')` is not found.

New harness: `invoiceCreateGate` / `releaseInvoiceCreate` (the same shape as the
existing `itemsCreateGate`), `saveInFlight()`, `releaseSaved()`.

## Risks

1. Freezing the row inputs is the widest visible change. Cost: on a slow save the
   owner cannot fix a typo for the duration. Benefit: the quantity and unit price
   the server books are the ones on screen; without it the same divergence
   (typed value lost, draft reset) survives on the quantity path. The save is a
   single local request; round 2 already accepted the same trade on the save
   button and on the supplier/payment inputs.
2. Existing tests that touch the lines during a save would now hit disabled
   controls. Measured: none do; the full suite is the evidence.
3. `savePending` is derived from `createInvoice.isPending`, so it ends when the
   request answers, success or error — the abort path (network error) unfreezes
   through the same React Query state change, tested by an ablation that removes
   the predicate (controls come back enabled).

## Evidence plan (issue #259 — non-visual change → measurements)

- failing-first: run 1–3 above with the fix reverted (`git stash`-free: a patch of
  `savePending`), naming the failing assertion per test;
- ablation `A1..A4` (`.scratch/ablation/run-257-round4.ts`): remove each guard,
  show its test go red, restore;
- round-2 regression named: `blocks the invoice save while a line create is in
  flight (round 2, F2)` and its four siblings;
- gates: `bun run typecheck`, `bun run lint`, the purchase + invoice-draft unit
  suites, and `tests/e2e/purchase-inline-product.spec.ts` on an `e2e-slot.sh`
  slot, all with exit codes and counts;
- screenshots of the frozen state and of the same screen on the pre-fix tree
  (a real user only sees this state while the request is out — sub-second locally
  — so the pending window is held open with a delayed response and that is stated
  in the evidence). No video: `playwright.config.ts` states the repo's decision
  ("No video: it adds per-test encoding cost on a sequential suite without
  answering anything the trace leaves open"), and a state that exists for one
  round-trip cannot be recorded at real user pace without the same artificial
  delay the screenshots already document.
