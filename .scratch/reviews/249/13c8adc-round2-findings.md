# #249 round 2 — Greptile #251 findings, fix evidence at `13c8adc`

Tier: **High-assurance** (money-reader guard, `docs/engineering-workflow.md`).
PR #251 was scored 3/5 with three findings. All three are real; none is stale.

## Findings and verdicts

| # | Finding | Verdict | Evidence |
|---|---------|---------|----------|
| 1 | a loop `let` binding (assigned to the surrounding block) hides an outer raw check | **real** | before: `findBlanknessGates(...) == []`; after: `s.ts::t === "" [draft.trim()]` |
| 2 | a comma condition stops `refuseIfTestPosition`, so a wrapped test returns `[]` without throwing | **real** | before: `[]` (no throw); after: throws `unhandled blankness shape` |
| 3 | the branch proof's `str.replace` deletes every matching call, so 7 refusal positions die together; `do`/`for` fixtures missing | **real** | split proof reports `do`/`for` unpinned before the fixtures exist |

## Failing-first (each new fixture failed before its fix)

`pre-fix-findings-1-2.log` — finding 1 + 2 fixtures, scanner unfixed:

```
bun test src/lib/blankness-ratchet.test.ts   # exit 1
 56 pass
 2 fail   (the loop-shadow and comma-condition fixtures)
```

`per-position-proof-before-dofor.log` — the per-position proof with no `do`/`for` fixtures:

```
bash .scratch/reviews/249/ast-branch-pin-proof.sh   # exit 1
--- delete truthiness refusal (do): exit 0, 0 failing test(s)
--- delete truthiness refusal (for): exit 0, 0 failing test(s)
PROBLEM: branch deletion stayed green for truthiness refusal (do), truthiness refusal (for)
```

The old proof hid this: `original.replace('refuse(node, "truthiness test on a raw .trim()");', ";")`
matched all seven refusal call sites. The split proof uses one unique source site per
position and refuses to run when a site is ambiguous (FATAL on `count > 1`).

## Fixes

- `apps/web/src/tests/blankness-gates.ts`
  - `loopScope(node)`: a `for` / `for-of` / `for-in` statement is the scope for its own
    `let`/`const` bindings, so a loop binding no longer masks an outer raw check after the loop.
  - `testedValue(node)`: parens / assertions pass the value through and a comma expression is
    followed to its right-most operand, so `if ((logDraft(), draft.trim()))` is refused. A
    discarded left operand stays a value use (not refused).
  - Header doc records both rules.
- `apps/web/src/lib/blankness-ratchet.test.ts`: finding 1 + 2 fixtures, and one fixture per
  loop-condition refusal (`while`, `do`, `for`).
- `.scratch/reviews/249/ast-branch-pin-proof.sh`: per-position unique deletions + ambiguity guard.

## Gate-set diff determination (the brief's nuance)

`13c8adc-gate-set-diff.log`:

```
bash .scratch/reviews/244/gate-set-diff.sh b517553   # exit 0
reference b517553 gates: 32
current gates: 32
ADDED []
REMOVED []
```

**Case 1: the gate set did not move (32 -> 32, `ADDED []`).** Neither escape occurs in a
production file, so closing them adds no production gate and no `CLASSIFIED` entry is
needed. The two escapes were **latent**, not a production false negative: a direct probe of
the reference regex scanner on the two fixture shapes also returned `[]` for both, so the
regex did not catch them either. The diff is empty because the shapes are absent from the
scanned surface, not because the list was tuned.

## Commands and exit codes (all at `13c8adc`)

| Command | Exit | Result |
|---|---|---|
| `bun test src/lib/blankness-ratchet.test.ts` | 0 | 58 pass / 0 fail (`13c8adc-ratchet-green.log`) |
| `bash .scratch/reviews/244/gate-set-diff.sh b517553` | 0 | 32 -> 32, `ADDED []` / `REMOVED []` (`13c8adc-gate-set-diff.log`) |
| `bash .scratch/reviews/244/390da2d-mutation-proof.sh b517553^` | 0 | 11/11 converted-file reverts redden the ratchet (`13c8adc-mutation-proof.log`) |
| `bash .scratch/reviews/249/ast-branch-pin-proof.sh` | 0 | 22/22 branches redden; scanner restored byte-identical (`13c8adc-ast-branch-pin-proof.log`) |
| `bun run typecheck` | 0 | `13c8adc-typecheck.log` |
| `bun run lint` | 0 | `13c8adc-lint.log` |

The full package/unit suite was blocked by the harness heavy-run guard ("no slot is free"),
which also failed to locate its own `e2e-slot.sh` (mangled path). The only test that imports
`blankness-gates.ts` is `blankness-ratchet.test.ts`, which is green; the change is otherwise
scanner-internal.
