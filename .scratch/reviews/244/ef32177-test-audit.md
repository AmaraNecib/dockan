# #244 round 4 — test audit at `ef32177`

Base `1af565f` → head `ef32177`. Raw agent reports:
`.scratch/reviews/244/ef32177-test-audit-edge.md`,
`ef32177-test-audit-coverage.md`, `ef32177-test-audit-quality.md`.

## Edge case hunter

- Both questioned fixtures discriminate, mutation-tested: `privateField` fails
  when `#` is a word character (yields the invented `draft` receiver);
  `insideChain` fails on the always-a-space separator (`[]`).
- `ef32177-ratchet-first-red.log` shows all three round-4 fixtures red on the
  pre-fix scanner, green on this head. No vacuous new test.
- Missing edge (pre-existing, not introduced): a non-ASCII identifier binding
  (`const dé = draft.trim(); if (dé === "")`) is not seen at all — recorded as a
  deferred leak in the design doc and the KNOWN CEILING boundary.
- No gap found for two-in-a-row comments, `$`, digits.

## Coverage analyst

- Findings 1-3: pinned by `blankness-ratchet.test.ts` round-4 fixtures
  (`privateField`, `insideChain`, `joined`, `nested`, `appended`) and
  failing-first in `ef32177-ratchet-first-red.log` + `ef32177-round4-before.log`.
- Finding 4: `ef32177-scope-shrink-guard-demo.log` CASE A = old script exits 0
  with "PASSED" on a crash; CASE B = new script exits 1 "without the expected
  failing assertion". Discriminating.
- Finding 5: `ef32177-concurrent-probe-demo.log` CASE A = the old fixed path
  DELETES a saved probe (failing-first); CASE B = the new script run twice at once
  is green, the saved probe byte-identical, no leftover path.
- Divergences found and fixed: the design doc's finding-5 text said the demo ran
  `gate-set-diff.sh` concurrently (it runs `scanner-shapes.sh` twice); the
  failing-first probe was not persisted — now
  `.scratch/reviews/244/round4-before-probe.ts` with a run instruction.

## Quality reviewer

Grades: tests **A-**, `scope-shrink-proof.sh`/`scope-shrink-guard-demo.sh`/
`gate-set-diff.sh` **A-**, `scanner-shapes.sh` **A**.

- One Major: `concurrent-probe-demo.sh` used the fixed path as its fake saved
  probe and `rm -f`'d it, so it could destroy a developer's real probe — the exact
  hazard it demonstrates. **Fixed**: the demo refuses before installing the EXIT
  trap, and the refusal path was verified to leave a real saved file
  byte-identical.
- `scanner-shapes.sh` prints a diagnostic table and always exits 0; that is its
  stated purpose (it is not a gate). Noted, not changed.

## Verdict

No blocker. One major (fixed) and one divergence set (fixed). Discrimination is
shown, not asserted, for findings 1-5.
