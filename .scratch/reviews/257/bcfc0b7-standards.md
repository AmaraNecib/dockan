# bcfc0b7 — Standards axis (second pass)

Scope: `git diff dc6c8cb...bcfc0b7` (4 files, +294/−9), `git show -s bcfc0b7`, `git log`, `git status --short`,
`git check-ignore`, `ls .scratch/reviews/257`, `grep -n`. **Nothing was executed by this lane** — no test, typecheck,
lint or playwright; the commit's own `bcfc0b7-*.log` files were read as text, not trusted. Standards sources actually
opened: `AGENTS.md`, `docs/engineering-workflow.md`, `.agents/wisdom/{live-write-gates-not-captured-render-values,
refusal-guard-must-record-the-ask,test-helper-vacuous-guard-and-inherited-mutation-claims}.md`, the round-3 standards
review. **Not opened (budget):** `docs/verification-and-merge-gate.md`, the `.agents/skills/{unslop,accessibility,
web-design-guidelines,code-review}` bodies, the #96 spec, `.scratch/implementation/257-round4-design.md`. Nothing below
is attributed to a skill or doc I did not read.

## (a) Documented-standard breaches

1. **Visual evidence carries no head SHA — `docs/engineering-workflow.md:145`** ("Review evidence lives in
   `.scratch/reviews/<issue-id>/<head-sha>-<gate>.md` … Evidence filenames must contain the exact reviewed HEAD SHA;
   any later reviewable-file change makes evidence stale"). Round 4 fixed the *log* names (`bcfc0b7-typecheck.log`,
   `dc6c8cb-r4-e2e-frozen-prefix-red.log`), but the two images its e2e test writes —
   `tests/e2e/purchase-inline-product.spec.ts:253,266` →
   `.scratch/reviews/257/screenshots/round4/{draft-live-before-save,draft-during-save}.png` — are named by round, and
   `draft-live-during-save-prefix.png` in that same directory is a **dc6c8cb** image (`ls`). Three PNGs, two heads,
   one directory, no SHA: exactly the stale-evidence failure the rule exists to prevent. Minor (the rule's letter
   targets `<sha>-<gate>.md`), and the #96 precedent may share it — I did not open that spec.
2. Nothing else. I cannot cite a rule against any line of the four changed source files.

## (b) Baseline smells (judgement, ranked)

1. **Comments, duplicated rationale** — the F1 argument is restated 8×: `purchase.tsx:301-313` (docblock), `:178-182`
   (`pickItem`), `:399-405` (`submitLineCreate`), `:643-645`, `:818-826`, plus `purchase.test.tsx:1661-1665`,
   `1697-1700` and the e2e docblock `spec:194-207`. The docblock is where a reader starts; the rest could be
   one-line pointers. Highest-volume smell in the diff.
2. **Two mechanisms for one invariant** — `disabled` (the block) plus two handler refusals (the belt) whose only path
   is a scripted click: `pickItem`'s state needs an open `aria-modal` dialog, which the same commit says blocks the
   mouse path to Save. Necessary to *prove* the belt in jsdom, but it is production code no real user can reach.
3. **Shotgun surgery kept** (first-pass disposition 1) — 11 `savePending` reads (`:500,506,517,528,598,612,645,658,
   684,697,704,784`); a `<fieldset disabled>` minus Cancel, or a `Frozen` wrapper, would be one. Their
   counter-argument (Cancel at `:787` must stay live; each site separately ablatable) is sound, so this stays a
   smell, not a finding.
4. **Declaration after first use** — `pickItem` reads `savePending` at `:182`; the const is `:313`. Correct only
   because `pickItem` is not invoked during the render pass before that line executes. Reading order is inverted and
   the invariant "never call `pickItem` during render" is unwritten; a later call from a render-time callback is a
   TDZ `ReferenceError`, not a stale value.
5. **Test boilerplate** — the `invoiceCreateGate = new Promise(…releaseInvoiceCreate = resolve)` pair is repeated at
   `purchase.test.tsx:1663,1700,1734,1761`; a `withSaveInFlight(container, fn)` beside `saveInFlight` (`:1205`) /
   `releaseSaved` (`:1214`) would carry it once.

## (c) First-pass dispositions, verified against the diff

1. Shotgun surgery kept explicit — **holds**: 11 sites; Cancel (`:787`) still enabled, line form fields still enabled.
2. Live-write-gate wisdom deliberately not applied — **holds as stated**: both guards read `savePending` at handler
   entry before any `await` (`:182`, `:405`), so no continuation can read a stale gate; smell (b)4 is the residual.
3. Supplier picker + payment pair already disabled, now spell `savePending` — **holds** (`:500`, `:517`; the diff's `-`
   sides are `createInvoice.isPending`).
4. Tautological post-release `lastPurchaseInput.lines` assertions removed — **holds**: payload asserted while gated
   (`test:1669,1695,1726`); post-release assertions are the saved card and `createdItems`.
5. e2e route delay 4000 → 2500 ms — **holds** (`spec:258-259`, with the 5000 ms timeout rationale).
6. `saveInFlight` 0 → 20 ms — **holds** (`test:1208`); the *premise* is imprecise: this file uses `setTimeout(0)` at
   ~28 sites and `20` at ~20, so the new tests' `0`s (`:1731`) match existing convention too.
7. `openCreate` on a disabled button is a jsdom no-op — **holds and is disclosed**; note the pattern is pre-existing
   (`test:1314,1415,1434,1490,1531`), so `expect(createRow(container)).toBeNull()` at `:1677` is consistent, if weak.
8. Doc's reachable-path table updated — **not verifiable from the diff**: `257-round4-design.md` is untracked
   (`git status --short`), so no commit contains that edit; the claim rests on the commit message.
9. Notes frozen with the lines — **holds** (`:506`, asserted `test:1745`).

Verdict: the four-file diff is clean against the written standards. The one rule-cited item (a)1 is outside the diff
and is a naming/packaging issue, not a code defect. No test, typecheck, lint or playwright was run by this lane, so
every green in the commit message is unverified here.
