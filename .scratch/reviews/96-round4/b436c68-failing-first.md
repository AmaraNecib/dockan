# Failing-first evidence — issue #96 round 4

Base: `origin/issue-96-empty-states` (`5144100`). Reviewed HEAD: `b436c68`.
Pre-fix page files, as the brief defines them:

| Page | "Pre-fix" file | Why that version |
| --- | --- | --- |
| `apps/web/src/pages/expenses.tsx` | `5144100:…` (the branch head) | the clear handler had no focus hand-off at all |
| `apps/web/src/pages/invoices.tsx` | `5144100^:…` | the invoice page is **not** touched by this lane; the "pre-fix" rule is `kind !== "" ? kind : status` |

Method: copy the working file to `.scratch/tmp/<name>.safe.tsx`, write the
pre-fix version with `git show`, run, restore with `cp`, then confirm the restore
with `git status --porcelain`. **Never `git stash`** (`.agents/wisdom/2026-10-14-git-stash-pathspec-pops-unrelated-stash.md`).

## Red — the five new tests against the pre-fix page files

```
$ git show 5144100:apps/web/src/pages/expenses.tsx  > apps/web/src/pages/expenses.tsx
$ git show 5144100^:apps/web/src/pages/invoices.tsx > apps/web/src/pages/invoices.tsx
$ cd apps/web
$ bun test src/pages/expenses.test.tsx \
    -t "emptied the filtered view|window emptied the view|all-categories pill|recorded pill is gone"
$ bun test src/pages/invoices.test.tsx -t "status changed last"
```

Raw output: `raw-prefix-expenses.txt`, `raw-prefix-invoices.txt`.

```
Expected: "expense-filter-cat-2"    Received: null
(fail) …> keeps focus on the category that emptied the filtered view when clearing
Expected: "expense-range-preset"    Received: null
(fail) …> falls back to the range preset when the window emptied the view
Expected: "expense-filter-all"      Received: null
(fail) …> returns focus to the all-categories pill when the owner last touched it
Expected: "expense-range-preset"    Received: null
(fail) …> falls back to the range preset when the recorded pill is gone
 0 pass  4 fail   Ran 4 tests across 1 file. [3.26s]
```

```
Expected: "invoices-status-filter"  Received: "invoices-kind-filter"
(fail) …> focuses the status filter, not the kind filter, when status changed last
 0 pass  1 fail   Ran 1 test across 1 file. [1.74s]
```

`Received: null` is the defect itself: the clicked button is replaced and focus
falls to `document.body`, so `focusedTestId()` returns nothing. The invoice
failure is the **old rule in the act** — with kind still `SALE`, the pre-fix
handler focused the kind control, which is precisely the both-set case Greptile
reported and the previous round could not pin.

## Green — the same tests against the fixed files

Raw output: `raw-green-expenses.txt`, `raw-green-invoices.txt`.

```
(pass) …> keeps focus on the category that emptied the filtered view when clearing
(pass) …> falls back to the range preset when the window emptied the view
(pass) …> returns focus to the all-categories pill when the owner last touched it
(pass) …> falls back to the range preset when the recorded pill is gone
 4 pass  0 fail   Ran 4 tests across 1 file. [3.12s]
(pass) …> focuses the status filter, not the kind filter, when status changed last
 1 pass  0 fail   Ran 1 test across 1 file. [2.06s]
```

## Restore discipline — a mistake worth recording

The first attempt at this evidence run left the pre-fix `invoices.tsx` in the
working tree because a later command dropped its restore step. Four full
`apps/web` suite runs then tested pre-fix code, and the invoice test's failure
was misread as harness flake for three of them (diagnostics were added to
`invoices.test.tsx`, run, then removed). The lesson is in the `crew_report`:

- the restore belongs in the *same* command as the mutation, and `git status
  --porcelain` must be the last line of it;
- a new test that fails only when the whole suite runs is pre-fix behaviour or a
  real shared-state bug — but check the *tree* before believing either.

The final evidence run above ends with `git status --porcelain` and lists only
the four files this lane changes; `invoices.tsx` is not among them.
