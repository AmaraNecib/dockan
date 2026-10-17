# Test-quality audit — ef32177 (#244 round 4 / PR #246)

Scope: `apps/web/src/lib/blankness-ratchet.test.ts` additions, `apps/web/src/tests/blankness-gates.ts` scanner, and the changed proof harnesses in `.scratch/reviews/244/`. Base `1af565f`, head `ef32177`. Full suite not run (per instruction).

Independent discrimination check (not just the logs): I copied the pre-fix scanner (`git show 1af565f:.../blankness-gates.ts`) and the head scanner to `/tmp/bt/` and ran the seven new fixtures through both. Results below.

## Grades

### A- — new fixture tests, `blankness-ratchet.test.ts:551-652`
Discriminating: three fixtures flip old → new exactly as claimed.
- `blankness-ratchet.test.ts:563` appended-normaliser → OLD `[]`, NEW one gate. Red pre-fix (matches `ef32177-ratchet-first-red.log`: 29 pass / 3 fail).
- `blankness-ratchet.test.ts:596` joined block comment → OLD `[]`, NEW one gate.
- `blankness-ratchet.test.ts:637` nested template `;` → OLD `[]`, NEW one gate.

Isolation: each `it` is pure `findBlanknessGates(sourceString, "synthetic.ts")` — no fs, no shared state, no ordering dependency. Assertions are exact-signature `toEqual([...])`, not `toContain`/length, so a wrong signature text fails.

No wrong-implementation escape: the precision sub-assertions inside the same `it` (`:572` whole-value `[]`, `:582` `")"`-in-string `[]`, `:601` spaced control, `:614` comment-inside-chain, `:624` private field) pass on the OLD scanner too, so they are regression guards, not discriminators — correctly scoped, but note they are load-bearing: an "always insert a space" fix keeps `:563` green and loses `:614`, so the pair is what pins the fix. `:614`/`:624` are the round-4 regression on a shape the pre-fix scanner already caught; keeping them is right.

Deduction only for: `:637` (finding 3) has no precision control beside it (e.g. a `;` in a nested template that is *not* a break, or the reversed operand order); a fix that over-suppresses templates would still pass this single assertion.

### A- — `scope-shrink-proof.sh`
Guard is complete and correctly ordered: green baseline first (`:38-44`), mutation verified applied (`:49`), expected assertion read from the mutated output (`:62` `grep -qE '\(fail\).*names only files inside the scanned scope'`) *before* the restore run (`:67`), and the mutated output lives in its own `OUT_MUTATED` (`:31`) so the restored run cannot overwrite it (`:68`). SHA-256 equality plus `git status` leftover check at `:72-77`. `ef32177-scope-shrink-proof.log` shows baseline 0 → mutated 1 with the named fail → restored 0, PASSED. No blocker.

### A- — `scope-shrink-guard-demo.sh`
Failing-first is real: both cases run against a throwaway `mktemp` repo (`:28-56`) whose ratchet throws at module scope, so an exit-nonzero-without-`(fail)` shape is exercised. Case A requires the OLD script to report PASSED (`:67`), Case B requires exit 1 + the exact refusal string (`:83`). Log confirms both. The `throw` at module scope is the right shape for "crashed runner", not a failing assertion.

### B (major) — `concurrent-probe-demo.sh`
The demonstration is sound (Case A reproduces the deletion, Case B proves uniqueness/no leftover at `:59-62`), but the demo commits the very bug it argues against: it uses the FIXED path `apps/web/src/tests/__scanner-shapes.ts` as its "developer's saved probe" (`:20`), then `cleanup()` removes `$SAVED` unconditionally (`:25-28`) and `:32` overwrites it before that. Run this on a worktree where a developer has a real saved probe at that path and the demo destroys it — the exact hazard Greptile finding 5 is about. Guard is wrong only in the harness, not in the production scripts; fix is to place the fake saved probe at a per-run path (or a `mktemp` dir) and never `rm -f` a path it did not create.

### A- — `gate-set-diff.sh`
Per-run module names (`:19-23`), refuses an existing path instead of overwriting (`:25-30`), trap only removes its own paths (`:31-32`), and still enforces non-empty reference gate count (`:55-58`) plus empty ADDED/REMOVED (`:59-66`). Log `ef32177-gate-set-diff.log` shows the empty diff with a non-zero reference count.

### A — `scanner-shapes.sh`
Per-run probe path (`:16`), refusal check before the trap is armed (`:20-23`), cleanup only its own file (`:24-25`), and four new cases (`:64-67`) covering the three findings plus the comment-inside-chain regression. Probe is out of the ratchet's scan scope (imports `blankness-gates` only, not a `.test.ts` name), so it cannot inflate the gate set.

## Blockers
None.

## Notes
- `concurrent-probe-demo.sh` Case B asserts the saved probe is byte-identical (`:58-62`) but, because `:32` rewrites it first, the "before" hash is of the demo's own file, not a pre-existing one — same defect as above, same fix.
- `branch-pin-proof.sh:89-92` (unchanged in this diff) only requires *some* `(fail)` line per deletion, not the failing test for that branch. Out of scope here, but it is weaker than the scope-shrink guard this diff tightened.
- `normalisesWholeValue` and `breaksStatement` both still track quotes flat and do not parse regex literals; the KNOWN CEILING block (`blankness-gates.ts:39-95`) states both over-report directions honestly. Not a test defect.
