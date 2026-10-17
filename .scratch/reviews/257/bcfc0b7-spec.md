# bcfc0b7 — Spec axis (second pass)

Scope: brief read in full, then `git show -s bcfc0b7`, `git diff dc6c8cb...bcfc0b7`,
`apps/web/src/pages/purchase.tsx` + `purchase.test.tsx` (1665–1800), `tests/e2e/purchase-inline-product.spec.ts:200-282`,
`.scratch/implementation/257-round4-design.md`, `.scratch/ablation/run-257-round4.ts`, and every listed log.
**I ran nothing** — no test/typecheck/lint/playwright, no git write, no edit but this file. Every number below is the log's number, not re-measured.

## Verdict on the brief's 'What done means'

Met, with one named residual. The brief's sentence — the in-flight save cannot be made to carry a product other than the one chosen at the moment of saving — holds for every path I could trace in the committed code: the payload is built once at `purchase.tsx:356-366`, and every control that can change a line's *identity* is dead while `savePending` (`purchase.tsx:313`) is true — create trigger `:658`, form submit `:784`, line picker `:645`, plus the two handler belts `:182` (`pickItem`) and `:405` (`submitLineCreate`); row qty `:684`, cost `:697`, remove `:704`, notes `:506`, append pickers `:528/:612`, supplier `:500`, payment `:517`, quick-add submit `:598`. The only path that still mutates `lines` during a save is the deferred quick-add landing (`:317-329`), and it **adds** a new-item line — a fresh id, so `draft.remove(item.id)` at `:322` is a no-op and no existing line is re-pointed. It cannot put a wrong product into the payload; it leaves a product *out* (and `draft.reset()` at `:291` then drops that line) — the opposite divergence round 2 deferred, not a violation of the brief's wording.

## Commit-message claims verified

| claim | evidence (file) | holds |
|---|---|---|
| red first: exit 1, 0 pass / 4 fail at dc6c8cb | `dc6c8cb-pre-fix-red.log` ("Exit: 1 — 0 pass, 4 fail, 46 filtered out"; tail "0 pass / 46 filtered out / 4 fail") — nuance: tree = dc6c8cb product code + the *new* tests with `savePending = false`, which the log states outright | holds |
| assertions at 1674/1713/1743/1768, and those are the red ones | committed `purchase.test.tsx` 1674/1713/1743/1768 are exactly the four named lines; red log prints each with `at …:1674:115`, `:1713:28`, `:1743:87`, `:1768:57` and received `false`/`1`/element/`false` | holds |
| purchase suite exit 0, 50 pass / 0 fail, 267 expect | `bcfc0b7-purchase-suite.log` ("50 pass 0 fail 267 expect() calls") | holds |
| invoice-draft suites exit 0, 90 pass / 0 fail | `bcfc0b7-invoice-draft-suite.log` ("90 pass 0 fail", 2 files) | holds |
| e2e exit 0, 3 passed | `bcfc0b7-e2e-spec.log` ("ok 1/2/3 … 3 passed (26.3s)"), incl. `:209` frozen test | holds |
| pre-fix e2e red on `purchase-lines-frozen` | `dc6c8cb-r4-e2e-frozen-prefix-red.log` (`:271` not found, `exited with code 1`) | holds |
| ablation 10/10 red when deleted, control green | `bcfc0b7-ablation.log` ("10/10 guards bite"), A1–A7 as described, control exit 0 | holds |
| round-2 siblings pass in the same run | purchase log: round 2 F1 + F2 ("blocks the invoice save while a line create is in flight (round 2, F2)", cancel frees, one-in-flight, failed create frees) all `(pass)` | holds |
| typecheck exit 0 | `bcfc0b7-typecheck.log` — turbo "4 successful, 4 total"; no literal `exit` line | holds (weak form) |
| lint exit 0 | `bcfc0b7-lint.log` is one line: `$ oxlint`, no output, no exit code | does-not-hold as evidence |
| design-doc table agrees with code | doc rows ↔ `purchase.tsx:182/405/500/517/528/598/612/645/658/684/697/704/784`; doc now states the `pickItem` guard (commit item 8) | holds |
| e2e test agrees with code | spec `:244` `purchase-line-pick-<id>`, `:271` `purchase-lines-frozen` (code `:826`), `:262` `purchase-save` (code `:834`), key added `i18n.ts:457` | holds |

## Remaining gaps

1. **Quick-add landing is ungated** — `purchase.tsx:317-329` runs `draft.remove`/`draft.addItem` with no `savePending` check, and `quickSubmit` `:369-392` has no belt (unlike `submitLineCreate` `:405`), so a quick-add started before the save lands *during* it and its line is then wiped by `draft.reset()` (`:291`) — an item created on the server with no invoice line. Close with the pending-placement gate round 2 named, or a `savePending` gate on `onCreated`.
2. **The belt principle is applied asymmetrically** — Enter in an enabled quick-add field still reaches `quickSubmit` while only the submit *button* is disabled (`:598`), the exact "a submit no disabled button produced" case F1 belts for the line form. Close by guarding `quickSubmit` or disabling the quick-add fieldset.
3. **The e2e test asserts state, not the block** — `spec:209-281` only checks `toBeDisabled()`/visibility and the booked stock; it never attempts a re-point during the save in a real browser. Close by clicking the line trigger and the pick during the held-open request and asserting no second `itemsCreate`.
4. **Evidence provenance for the screenshots** — `draft-frozen-during-save.png` is byte-size-identical to `draft-during-save.png` (64667) and `draft-live-during-save-prefix.png` is written by no committed code path; the spec only writes `draft-live-before-save.png` (`:253`) and `draft-during-save.png` (`:266`). Close by stating which run wrote each file.
5. **Lint/typecheck logs carry no exit code** — `bcfc0b7-lint.log` has no output at all, so "exit 0" rests on the commit prose. Close by appending `echo "exit:$?"` (same for typecheck).
