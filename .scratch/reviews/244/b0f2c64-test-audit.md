# #244 round 3 — test audit (edge / coverage / quality)

Reviewed code: **`9219369`** (the round-3 head when the lenses ran). Fixes and
their fixtures are committed in **`b0f2c64`**. All three auditors were read-only
with no shell; every claim is a `path:line` citation or a hand-trace.

## Edge case hunter

| Risk | Location | Finding | Disposition |
|------|----------|---------|-------------|
| red | `blankness-gates.ts:284` | A nested `{...}` inside `${}` popped the code region on the first `}`, so a gate after an object literal / arrow body was read as template TEXT — its comment survived and hid the gate. The round-3 fixtures only covered a nested brace-free `${}`, so they were green while this stood. | **Fixed**: region carries its own `${` index; fixture `keeps the code region open across an inner brace inside \`${}\`` (red on 92f40d0). |
| orange | `blankness-gates.ts:347` (via `:106`) | `breaksStatement` re-scanned the stripped text with no string awareness, so `d["}"].trim()` read as a statement break and the declaration (and its gate) was lost. | **Fixed**: `breaksStatement` skips `'` / `"` / `` ` `` regions; fixture `does not read a brace inside a string subscript as a statement break`. |
| orange | `tests/e2e/blankness-mark-only.spec.ts:41-49` | After reload the spec finds the row by name without resetting the pager; a new item on a later page would fail the lookup. | **Deferred (stated)** — the pre-existing assertion had the same property and the spec passes against the shared DB; a filter step that resets `offset` is the candidate hardening. |

Uncovered but hand-traced correct, and why that is acceptable: nested template,
escaped backtick, normaliser in a nested subscript, member chain ending in a
subscript, more than one `${}` per template, unterminated template. The two-step
`.length` form with a normalised key shares `claimTwoStep` + `withoutSubscripts`
with the equality form that **is** pinned, and `gate-set-diff` shows the real gate
set unchanged (32/32, `ADDED []` / `REMOVED []` against six refs).

## Coverage analyst

| Finding | Disposition |
|---------|-------------|
| All three original round-3 tests share one shape (`findBlanknessGates` over a synthetic string); nothing exercised the rewrite through a real file scan. | **Partly addressed**: three further fixture shapes were added (nested brace, brace in a string subscript, argument-only normaliser), which are exactly the escapes the lenses found. |
| The brief's "template TEXT stays verbatim" invariant had no artifact pinning it. | **Documented, deliberately not pinned**: the change is about the expression half and the TEXT is unchanged. Pinning "TEXT is scanned as code" would lock in a false positive that is now removable — blanking the TEXT is safe once `${}` is code. Stated in the scanner doc as a deferred follow-up. |
| `ratchet-first-red.log` showed only "these tests failed", not that the positive controls passed inside a red test. | **Fixed evidence**: the regenerated log lists the exact failing set (5 failed / 24 passed), so the controls are visible as passing. |
| Benign duplicate coverage (the precision asserts duplicate round-2 pins; the plain inner-block control duplicates the round-2 scope test). | **Accepted** — they are positive controls, not fix proofs. |

## Quality reviewer

Grades: ratchet tests **A−**, e2e spec **B+**, mutation proof **A−**, branch-pin
**B+**, `gate-set-diff.sh` **C+**.

| Finding | Disposition |
|---------|-------------|
| `gate-set-diff.sh` printed `ADDED`/`REMOVED` but inherited bun's exit code — a reference scanner that produced nothing would print a non-empty `REMOVED` and still exit 0. The one script that could pass vacuously. | **Fixed**: it now refuses a zero-gate reference and exits 1 unless `ADDED` **and** `REMOVED` are both `[]` (verified in `b0f2c64-gate-set-diff.log`, exit 0). |
| Some round-3 control fixtures and precision asserts also pass against the unfixed scanner. | **Accepted and labelled**: they are anti-over-correction guards. The load-bearing assertions are the 5 in `b0f2c64-ratchet-first-red.log`. |
| `branch-pin-proof.sh` enumerates only matcher call sites, so the new `scanSource` / `withoutSubscripts` internals have no deletion case. | **Documented ceiling** in the script header: those internals are pinned by the fixture tests, not by a deletion. |
| The e2e reads the list payload, not a fresh single-item GET, so a list-level default would still pass. | **Stated ceiling** — the list payload is the server's stored value after reload. |
| No assertion that the edit row opened beyond the threshold input existing. | **Accepted** — `edit-threshold` existing *is* the row's edit state (`items.tsx:927`). |
