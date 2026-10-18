# Coverage audit — ef32177 (#244 round 4, Greptile findings 1–5)

Scope: `git diff 1af565f...HEAD`. Read: diff, brief `fix-244-round4.md`,
design `244-round4-design.md`, logs `.scratch/reviews/244/ef32177-*.log`.
Did not run the suite (per instruction); evidence is the saved logs.

## Per-finding verdict

| # | Pin (test/demo) | Discriminates? | Design table ↔ logs |
| --- | --- | --- | --- |
| 1 appended call | `blankness-ratchet.test.ts:551` | Yes — old scanner returns `[]` in `ef32177-ratchet-first-red.log` (assertion at :561) | match |
| 2 comment separator | `:584` | Yes — first-red log, assertion at :595 | match |
| 3 nested template | `:637` | Yes — first-red log, assertion at :648 | match |
| 4 runner error | `scope-shrink-guard-demo.sh` → `ef32177-scope-shrink-guard-demo.log` | Yes — CASE A old script exit **0** / "PASSED" with no scope assertion; CASE B new exit **1** | match |
| 5 probe collision | `concurrent-probe-demo.sh` → `ef32177-concurrent-probe-demo.log` | **Partial** — see below | **diverges** |

Findings 1–3 each have a real failing-first: the first-red log runs the
round-3 scanner against the round-4 tests and fails exactly those three
(`29 pass / 3 fail`), and `round4-before.log` shows the three shapes escaping
(`[] (ESCAPES)`). The green log (`ef32177-ratchet-green.log`, 32 pass) and the
observed table (`ef32177-scanner-shapes.log`: appended / block-comment /
comment-inside-chain / nested-template all now caught) agree.

## Finding 5 — failing-first verification (requested)

CASE A is a genuine reproduction of the **delete** half: the old fixed path
`apps/web/src/tests/__scanner-shapes.ts` is written over and then removed by its
`EXIT` trap, destroying the saved probe (log: "old script exit code: 0 …
DELETED the saved probe"). CASE B runs the **new** `scanner-shapes.sh` twice
concurrently and asserts both exit 0, saved probe byte-identical, no leftovers.

Gap: CASE B never runs the **old** script concurrently, so the
"two concurrent runs clobber each other" half is asserted-but-not-failing-first.
It is only shown for the fixed script. The delete reproduction does discriminate
the fix (unique path fixes both halves), so this is a coverage note, not a
blocker.

## Coverage gaps / divergences

- **Design table names a missing log.** `244-round4-design.md` evidence plan lists
  `<sha>-guard-phase2.log`; no `ef32177-guard-phase2.log` exists (only
  `b0f2c64-` and `c143fa8-`). Phase 2 (e2e) is unpinned at this SHA.
- **Design §5 overstates the demo.** Prose says the demo "runs `scanner-shapes.sh`
  and `gate-set-diff.sh` CONCURRENTLY". `concurrent-probe-demo.sh` CASE B runs
  `scanner-shapes.sh` twice — `gate-set-diff.sh` is never run concurrently. Its
  unique-path/`sed` logic is exercised only by the single `ef32177-gate-set-diff.log`
  run, so the gate-set-diff half of finding 5 has no concurrency pin.
- **`round4-before.log` is not reproducible.** Its probe
  `apps/web/src/tests/__round4-probe.ts` is "removed after" and not kept, so the
  failing-first shape log cannot be regenerated from the repo.
- **Finding-4 demo is script-local.** `scope-shrink-guard-demo.sh` must force a
  runner error; the standard path (`ef32177-scope-shrink-proof.log`) still shows
  the scope assertion `(fail) … names only files inside the scanned scope`, so the
  real proof is intact.

## Duplicated coverage (intentional, not a defect)

The three round-4 shapes appear in three layers: the ratchet tests (`:551`,`:584`,
`:637`), `scanner-shapes.sh` cases (`appended normalised prefix`,
`block comment joins tokens`, `comment inside a chain`, `nested template`), and
`round4-before.log`. That is deliberate — tests assert, `scanner-shapes` observes.
No true duplication.

## Missing coverage (round-4 changes)

- The `#draft` / `isWordCharacter` branch (`blankness-gates.ts:126-135`) is pinned
  only by `privateField` inside the `:584` test; no failing-first (old scanner also
  passes it — it is a regression guard for the always-a-space variant).
- `insideChain` (`:606`) likewise passes on the old scanner — regression guard only.
- No negative test that `gate-set-diff.sh` refuses when the unique probe path
  already exists (the `REFUSING:` branch at `gate-set-diff.sh:26-31`).

## Bottom line

Findings 1–4: pinned and discriminating. Finding 5: delete-half discriminating,
concurrency-half asserted only. Two doc/log divergences (missing `guard-phase2`
log; §5 mis-describing the demo) should be corrected or the phase-2 log produced.
