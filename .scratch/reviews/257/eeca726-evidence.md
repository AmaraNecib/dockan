# #257 round 4 — evidence

**Tier:** standard (recorded with justification in
`.scratch/implementation/257-round4-design.md`).
**Base:** `feat-257-inline-product` (PR #266), `dc6c8cb` = `origin/feat-257-inline-product`.
**Final head:** `0fcbbcc`.

Evidence is anchored at `eeca726`: the fix commit was message-amended after the
final verification pass ran, and `git diff --name-only eeca726 0fcbbcc` is empty,
so every log and report named `eeca726-*` measures the final head's tree verbatim
(the same construction round 3 used for `e3094de` → `ae9d4b5`). The amend fixed
one number in the commit message: the purchase suite's expect count, 267 → the
measured 268.

**Lane base correction:** this worktree was cut from the stale local
`feat-257-inline-product` (`5723f91`, 8 behind) instead of the brief's stated base
`dc6c8cb`. With no lane commits yet, the lane reset its own branch to `dc6c8cb`
before any edit; otherwise the round-4 commit would have reverted rounds 2 and 3.

## The defect (Greptile 4/5 at dc6c8cb, Issue 1 — the only issue this lane owns)

`apps/web/src/pages/purchase.tsx:754` was
`disabled={createItem.isPending}` on the line create form's submit. `createItem`
is the item write; the **invoice** write is a different mutation, and every
control that changes `lines` stayed live while it was out. `submit()` maps
`lines` into the request body, so the request carried a snapshot the screen could
still edit: a slow save of product A, a product B created from that line while it
was out, the line re-pointed at B, the invoice stocking **A**, and
`createInvoice.onSuccess`'s `draft.reset()` wiping B off the screen. The mirror of
round 2 (`893ab0e`), which blocked the save during a line create.

## Failing-first — `dc6c8cb-pre-fix-red.log`

`cd apps/web && bun test src/pages/purchase.test.tsx -t "round 4"` on the
`dc6c8cb` product code with the committed tests and `savePending = false`:
**exit 1, 0 pass / 4 fail**. The named assertions:

| line | assertion | received |
|---|---|---|
| `purchase.test.tsx:1674` | the line's create trigger `.disabled === true` | `false` — the control stayed usable |
| `purchase.test.tsx:1712` | `expect(createdItems).toHaveLength(0)` | length **1** — a real `itemsCreate` started behind the in-flight save |
| `purchase.test.tsx:1742` | the line keeps the product the request carries | an element: the line **was** re-pointed at the picked product |
| `purchase.test.tsx:1767` | the row quantity input `.disabled === true` | `false` |

Green on the final head: `eeca726-purchase-suite.log` — **50 pass / 0 fail**,
268 expect calls, `exit=0`.

## e2e — real browser, real delayed response

- `dc6c8cb-r4-e2e-frozen-prefix-red.log`: with the fix reverted,
  `tests/e2e/purchase-inline-product.spec.ts` fails at `:272`,
  `Locator: getByTestId('purchase-lines-frozen')`, `Error: element(s) not found` —
  1 failed, exit 1.
- `eeca726-e2e-spec.log`: final head, **3 passed**, exit 0 (the two specs the PR
  already had, plus the new frozen-draft spec whose `invoicesCreate` response is
  held open by `page.route` for 2500 ms).
- Screenshots (`screenshots/round4/`): `eeca726-draft-live-before-save.png`
  (controls live before the save), `eeca726-draft-frozen-during-save.png` (frozen
  + the stated reason during it), and `dc6c8cb-draft-live-during-save.png` (the
  same moment on the pre-fix tree: no frozen status, controls live).
  **No video:** `playwright.config.ts` records the repo's decision ("No video: it
  adds per-test encoding cost on a sequential suite without answering anything the
  trace leaves open"), and a state that exists for one round-trip cannot be
  recorded at real user pace without the same artificial delay these images
  already document.

## Ablation — `eeca726-ablation.log`, `.scratch/ablation/run-257-round4.ts`

**10/10 red when deleted**, control green (`exit=0`). No `git stash` anywhere
(wisdom `2026-10-14-git-stash-pathspec-pops-unrelated-stash`).

| id | guard deleted | named test that goes red |
|---|---|---|
| A1 | `submitLineCreate`'s `if (savePending) return;` | belt test |
| A2 | the line form submit's `\|\| savePending` | belt test |
| A3 | the create trigger's `disabled={savePending}` | F1 re-point test |
| A4 | `pickItem`'s `if (savePending) return;` | picker belt test |
| A5 | the quantity input's `disabled={savePending}` | freeze test |
| A6 | the frozen-draft status line | freeze test |
| A7 | the whole predicate (`savePending = false`) | all four |

A4 has no captured `(fail)` line: its DOM dump overflows the 8 MB buffer and Node
kills the run (status null), which the harness counts as red — the same mechanism
round 2 documented.

## Gates (all on the final tree)

| command | exit | result |
|---|---|---|
| `bun run typecheck` | 0 | `eeca726-typecheck.log` (cached turbo tasks) |
| `bun run lint` | 0 | `eeca726-lint.log` (oxlint, no findings) |
| `bun test src/pages/purchase.test.tsx` | 0 | 50 pass / 0 fail, 268 expect calls |
| `bun test src/lib/invoice-draft.test.ts src/lib/use-invoice-draft.test.tsx` | 0 | 90 pass / 0 fail |
| `bun run test:e2e -- tests/e2e/purchase-inline-product.spec.ts` | 0 | 3 passed (slot 1, `e2e-slot.sh`) |

The full `bun run test` was refused by the heavy-run gate (a sibling lane held the
other slot); the narrowed suites above are what the brief asks for. Round 2's
guard is **not regressed**, by name, in the same run: `does not let a create in
flight re-point the line that re-adds its deleted item (round 2, F1)`,
`blocks the invoice save while a line create is in flight (round 2, F2)`,
`frees the invoice save when the owner cancels the create in flight (round 2, F2)`,
`lets only one create be in flight, so the save gate holds a single slot (round 2, F2)`,
`frees the save when the create fails while the form is still on its line (round 2, F2)`.

## Decisions

- **The disabled control is the block; the two guards are the belt.** Round 2's
  warning ("a guard in `submit()` alone is only reachable if the control is NOT
  actually disabled") is why the controls carry `disabled={savePending}`, and each
  guard is separately ablated. The belts are proved, not asserted: one test
  dispatches a `submit` event on the open form, the other picks from a dialog that
  was already open.
- **One predicate.** `savePending = createInvoice.isPending`; the supplier picker
  and the payment pair were moved onto the same value so the whole request is
  frozen by one thing instead of two spellings of it (a second-pass reviewer read
  the two spellings as an unfrozen path; the change removes the ambiguity).
- **Frozen with the lines:** the notes field (same request), the row's quantity,
  unit cost, remove, both append pickers, the quick-add submit.
- **Deliberately still enabled:** the line form's fields (typing is a local draft;
  discarding half-typed text is round 2's "dead end"), its **Cancel** ("Cancel is
  never disabled — a hung write must not trap the owner"), and the quick-add
  disclosure toggle (a control must be able to collapse what it opened).
- **Reachable-path honesty:** a real mouse cannot open the line picker during the
  save (the button is disabled) and cannot click Save behind an already-open
  `aria-modal` dialog; the picker guard therefore exists for a click the backdrop
  does not stop, and its test drives that click.
- **No `pickItem`-style guard was added to the row inputs:** disabling a native
  input is the whole block; a handler guard there would be unprovable belt.

## Deferred, named

Round 2's own commit message defers the opposite window: *"A quick-add in flight
does not block the invoice save either … Follow-up candidate: one
pending-placement gate covering both create paths."* Still open, and this round
does not touch it: the quick-add landing (`onCreated`) is not gated by
`lineCreatePending`, and freezing it here would silently drop a line the owner
asked for. The fix is the pending-placement gate, not a bigger `disabled` term.
Verified not to break the brief's bar: that path only **adds** a line with a fresh
item id, so the invoice still cannot stock a product other than the one chosen.

## Review

Three read-only lens passes, all disclosing that they ran nothing; every gate
claim was re-run in-lane and is in the logs above.

- `.scratch/reviews/257/bcfc0b7-standards.md`, `bcfc0b7-spec.md`,
  `bcfc0b7-test-audit.md` — second pass on the pre-disposition head.
- `.scratch/reviews/257/eeca726-code-review.md` — final verification on the
  pushed head's tree (no rule-cited breach, no blocker).

Dispositions (also in the commit message body): kept the explicit `disabled`
sites over a `<fieldset>` because a fieldset would disable Cancel; did **not**
back the gate with a ref (wisdom
`2026-10-15-live-write-gates-not-captured-render-values` — both guards read
`savePending` synchronously at handler entry, before any `await`, so no
continuation can read a stale gate); closed the "unfrozen supplier/payment"
finding with line evidence and the one-value change; removed the tautological
post-release payload assertions; tightened the e2e delay to 2500 ms; moved the
e2e screenshots to the gitignored `test-results/round4-evidence/` so a run cannot
dirty the tree, and copied the three images into the SHA-named evidence directory;
added `exit=` lines to every log; corrected the design doc's reachable-path table
to match the shipped `pickItem` guard.

Remaining nits, accepted: 12 `disabled` sites for one invariant (each separately
ablatable, and a fieldset cannot keep Cancel enabled); `pickItem` reads
`savePending` at `:182` while the const is declared at `:313` (fine for a handler,
a TDZ if a render-time caller were ever added); the freeze test asserts the
supplier/payment disables without a dedicated mutant (A7 removes the predicate and
takes that test red).

## Wisdom read, and what was applied

- Applied: `2026-10-14-git-stash-pathspec-pops-unrelated-stash` (the ablation
  harness patches and restores files, no stash);
  `2026-10-15-concurrent-lane-e2e-ports` (every e2e run took an `e2e-slot.sh`
  slot); `2026-10-15-test-helper-vacuous-guard-and-inherited-mutation-proof`
  ("an unstated gate is an unrun gate": every log carries its command and exit
  code, and the red e2e was re-run rather than inherited);
  `2026-10-16-latent-shape-mutation-proof` (guards proved by mutation, and the
  evidence says which mutants fail which test rather than claiming minimality);
  `2026-10-16-refusal-guard-must-record-the-ask` (the refusal is visible — the
  frozen table states the reason — and the owner re-asks by re-clicking once the
  save settles, so no retry bit is needed);
  `2026-10-14-readonly-reviewer-can-fabricate-shell-output` (the lens reports
  disclose that they ran nothing, and every number was re-measured in-lane).
- Read and deliberately not applied:
  `2026-10-15-live-write-gates-not-captured-render-values` — its condition is a
  gate read **after an `await`**; both guards here decide synchronously from the
  newest render's closure, before any await, so a ref would add a second source of
  truth with no interleaving to defend against (recorded in the dispositions).

## Candidate lesson (parent owns `.agents/wisdom/`)

A **mirrored ordering guard** is not the same guard: round 2 froze the write while
its precondition's source was in flight (`lineCreatePending` → save disabled) and
that left the other direction open (save in flight → source still mutable),
because the two directions live in different predicates. When a round fixes one
direction of a "request serialised a snapshot" race, the same commit should ask
what the mirror predicate is; a per-direction fix reads as complete and is not.
Second candidate, narrower: a worktree created from a *stale local branch* rather
than the PR head silently bases the lane several commits behind; the tell is
`git merge-base HEAD <base>` returning HEAD while `git log HEAD..origin/<pr-branch>`
is non-empty.
