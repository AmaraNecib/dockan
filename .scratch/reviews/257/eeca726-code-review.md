# eeca726 — final verification (Standards + Spec)

**Scope + no-tests disclosure.** Read-only; **I ran nothing** — no test, typecheck, lint, Playwright, no git write, no write but this file. Read: `git diff dc6c8cb...eeca726` (4 files, +297/−9), `git diff bcfc0b7 eeca726` (second-pass delta), `git show -s eeca726`, `git merge-base`, `git check-ignore`, the brief, `.scratch/implementation/257-round4-design.md` (grep), every listed log as text, `bcfc0b7-{standards,spec,test-audit}.md`, `ls` of the screenshot dir (PNG bytes not opened). Every number below is a log's number, not re-measured.

## (A) Standards

- Rule located: `docs/engineering-workflow.md:121-122` — "Review evidence lives in `.scratch/reviews/<issue-id>/<head-sha>-<gate>.md`. Evidence filenames must contain the exact reviewed HEAD SHA; any later reviewable-file change makes evidence stale." **Satisfied on this head**: logs are `eeca726-*.log`, the PNGs are SHA-prefixed (`eeca726-*`, `dc6c8cb-draft-live-during-save.png` for the pre-fix run). No rule-cited breach in the four changed source files. (The earlier pass cited this rule at `:145`; the text is at `:121-122`.)
- **Second-pass items observable?**
  - F1's two vacuous `createdItems` assertions: **removed** — `git diff bcfc0b7 eeca726` deletes both `-expect(createdItems).toHaveLength(0)` lines from the F1 test (one replaced by the pick-label check, `purchase.test.tsx:1682`). The final F1 test contains none; `createdItems` survives only at `:1712`/`:1717` in the belt test, and those bite (red log: length **1**; ablation A1 red).
  - supplier/payment in the freeze test: **yes** — `purchase.test.tsx:1772-1773` assert `purchase-supplier` and `purchase-paid` `disabled === true`; both lines are added by the delta.
  - screenshots: **moved** — `purchase-inline-product.spec.ts:254,267` write `test-results/round4-evidence/*.png`; `git check-ignore -v test-results` → `.gitignore:31`. SHA-prefixed copies live in `.scratch/reviews/257/screenshots/round4/`.
  - exit codes: **yes** for typecheck (`exit=0`, turbo 4 successful/4) and lint (`$ oxlint` then `exit=0`, 16 bytes). Nits: `eeca726-purchase-suite.log` / `eeca726-invoice-draft-suite.log` carry counts but no `exit=` line; the ablation log does carry explicit exit lines.
- Smells, not breaches (all pre-disclosed): 12 `disabled` sites + 2 `if (savePending) return` guards for one invariant; the F1 rationale restated ~8×; `pickItem` reads `savePending` at `:182` while the const is declared at `:313` — safe only because `pickItem` is never called from render (a render-path call would be a TDZ `ReferenceError`).

## (B) Spec / commit-message claims

| claim | evidence | holds |
|---|---|---|
| brief "done": the in-flight save cannot carry a product other than the one chosen when Save was pressed | payload built once (`purchase.tsx:356-366`); every identity-changing control dead while `savePending` (`:645,658,784`, row qty/cost/remove, notes `:506`, both pickers, quick-add submit, supplier `:500`, payment `:517`), plus guards `:182`/`:405` | holds |
| red first: exit 1, 0 pass / 4 fail, `-t "round 4"` | `dc6c8cb-pre-fix-red.log` header "Exit: **1** — 0 pass, 4 fail, 46 filtered out"; tail "0 pass / 46 filtered out / 4 fail"; log states tree = dc6c8cb code + round-4 tests with `savePending = false` | holds |
| assertions at `:1674`/`:1712`/`:1742`/`:1767` | red log table + traces `:1674:115`, `:1742:87`, `:1767:57`; committed file: `1674` = create-trigger `disabled`, `1712` = `createdItems` (belt) | holds |
| purchase suite exit 0, 50 pass / 0 fail, **267** expect | log: `50 pass` / `0 fail` / **268** `expect() calls` | **does-not-hold** |
| invoice-draft suites exit 0, 90 pass / 0 fail | `90 pass`, `0 fail`, 330 expect, 2 files | holds |
| typecheck exit 0; lint exit 0 | `eeca726-typecheck.log` ends `exit=0`; `eeca726-lint.log` = `$ oxlint` + `exit=0` | holds |
| e2e exit 0, 3 passed | `eeca726-e2e-spec.log`: `ok 1/2/3 … 3 passed (29.0s)`, incl. the `:210` frozen test | holds |
| pre-fix e2e red on `purchase-lines-frozen` | `dc6c8cb-r4-e2e-frozen-prefix-red.log`: `:272` not found, "exited with code 1" | holds |
| ablation 10/10 red + green control | `eeca726-ablation.log`: "10/10 guards bite (red when deleted)"; "control — restored tree, 'round 4': exit 0 (green)"; A1–A7 as named | holds |
| round 2 not regressed | purchase log: round-2 F1 and all four F2 siblings `(pass)` | holds |
| "ten `disabled` sites" | final tree: I count 12 `disabled` + 2 guards | nit (paraphrase, not a gate) |
| brief: before/after images + video if user-visible | 3 PNGs (pre/post); no video — design doc `:156-157` records the repo's "No video" decision in `playwright.config.ts` | holds |
| the lane reset its branch to `dc6c8cb` | `git merge-base bcfc0b7 eeca726` = `dc6c8cb`: `bcfc0b7` is a parallel/replaced commit, delta = 2 files +11/−8 | holds |

## Must change before push

1. **The commit message's "267 expect calls" is false.** `eeca726-purchase-suite.log` measured **268** (the second pass added the supplier/paid asserts and removed one `createdItems`). Write 268 or drop the count. A message-only amend rewrites the SHA, so the `eeca726-*` evidence names would need re-prefixing (tree unchanged); otherwise accept the off-by-one knowingly. This is the only false number I found — **no code blocker**.

## Nits

- purchase/invoice-draft logs lack an explicit `exit=` line (typecheck/lint/ablation have one).
- The pre-fix red log is named for the base (`dc6c8cb-…`) though the test file measured is the eeca726 one (stated inside); the e2e prefix-red log already names it as round-4.
- `savePending` is read at `:182` but declared at `:313`; move the const above `pickItem` or note the render-order invariant.
- The freeze test's bare `expect(...disabled).toBe(true)` failures name no control (`expect(x, "…")` would).
- The create-trigger path stays attribute-only (`openCreate` on a disabled button is a jsdom no-op) — disclosed, and A3 ablates it.
