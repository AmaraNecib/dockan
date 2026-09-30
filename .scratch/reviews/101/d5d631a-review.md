# PR #111 / issue #101 — adversarial review synthesis

Reviewed head `d5d631a`, merge-base `0b4d5a1`. Four independent fresh-context
reviewers (`standards.md`, `spec.md`, `critic.md`, `defender.md`).

| # | Finding | Score | Decision |
|---|---|---|---|
| 1 | The new badge contrast test was a tautology: it hand-composed tokens and asserted the failure of a design no longer in the code, while the pairing that ships (body text on a `warning/10` row) went untested | 6 | **Fixed** — the guard now asserts `--foreground` on the tinted row, and the solid pairs must keep a 5:1 margin, not merely clear 4.5:1 |
| 2 | `bg-destructive text-destructive-foreground` measured 4.56:1 — 0.06 above the threshold, down from the `bg-red-700 text-white` it replaced | 5 | **Fixed** — light `--destructive` darkened to `oklch(0.505 0.213 27.518)`; the margin assertion is what forced it |
| 3 | Nothing proved the three shadcn rules can fail, and the override used literal paths rather than globs | 4 | **Fixed** — the override is gone entirely (the two files are tokenised), and a raw colour planted in `reports.tsx` was verified to fail lint with `shadcn(no-raw-colors)` |
| 4 | Raw palette survived in `items.tsx:85`, `stock.tsx:120`, `stock.tsx:202` behind the lane's own disable | 3 | **Fixed** — `bg-success/10 text-success` / `text-success`; this closes #112 |
| 5 | The quick-add category Select stayed enabled with no options while the list loaded | 2 | **Fixed** — disabled with a loading placeholder, and the comment no longer claims the trigger can never be empty |
| 6 | The `font-display` → `font-heading` rename was absent from the PR body | standards | **Fixed** — named in the commit and PR body |
| 7 | `101-design.md` claimed `--warning` needs no foreground companion | standards | **Fixed** — doc updated, including why the light `--destructive` moved |
| 8 | `findOption` matched by substring, so a label contained in another could commit the wrong option | 1 | **Fixed** — exact trimmed match |
| 9 | `router.test.tsx` waited only for *some* label to render | 2 | **Fixed** — it waits for the expected category name |
| 10 | "keeps a typed override value when the same type is re-selected" was suspected vacuous | 5 | **Dismissed with evidence** — removing the `if (next === line.overrideType) return;` guard makes that test fail, so the guard is load-bearing and the test pins it |
| 11 | Each migrated Select states its options twice (`items` and `SelectItem` children) | judgement | **Kept** — it mirrors 28 pre-existing usages; one source for both is an app-wide change |
| 12 | The e2e preset test passes against a handler that only relabels | 3 | **Deferred** — issue filed |
| 13 | `reports.test.tsx` asserts a class string, which passes even if the token were never registered | 3 | **Fixed** — the token is registered in `index.css` and the contrast test now covers the pair |
| 14 | Evidence filenames must name the reviewed HEAD | standards | **Fixed** — evidence committed as `d5d631a-*.md`, stale `8dbc7b2-*` removed |
