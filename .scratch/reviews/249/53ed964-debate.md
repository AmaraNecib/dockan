# #249 debate — critic + defender (independent sub-agents at `353089e`)

Raw artifacts:
`.pi/.../subagent-artifacts/e7cba74d-..._reviewer_output.md` (critic),
`.../677997a7-..._reviewer_output.md` (defender).
Fix commit: `53ed964`.

## Critic (harness)

- **Blocker (8) — `blankness-gates.ts` `classifyTrimUse`.** `if (isLengthAccess(parent)) return;`
  treated every `.length` as owned by the comparison walk, but that walk only
  fires on a `BinaryExpression`. `if (draft.trim().length) return;`,
  `!draft.trim().length`, `draft.trim().length && x` and the two-step
  `if (t.length)` returned `[]` with **no `BlanknessScanError`** — the identical
  blankness decision the relational form was refused for. The exact silent blind
  spot the ticket exists to end, and it contradicted the file's own fail-closed
  claim. *Fixed: every raw `.trim().length` now routes through
  `refuseIfTestPosition`; red-first fixtures for all four forms.*
- **Note (5) — refusal blast radius.** `&&`/`||`/relational refusals throw across
  all 19 scoped files, so one legitimate `x.trim() || "—"` hard-fails the whole
  ratchet. *Kept: that is the loud direction; stated in the ceiling.*
- **Note (4) — `var` hoisting.** `nearestScope` returned the nearest `Block`, so
  `{ var t = draft.trim(); } if (t === "")` missed the gate. *Fixed: a `var` now
  scopes to `nearestFunctionScope`.*
- **Note (4) — `Boolean(draft.trim())`** falls through to silence. *Stated
  ceiling: an explicit call's argument is a value use.*
- **Note (2) — private-field fixture** `this.#/* gap */draft` is invalid TS; the
  rewrite tests the same trivia path with valid syntax and the same signature.
  *Accepted and documented in the design doc.*
- **Q1 (miss vs regex): none material.** Only `.trim().length === 0n` regresses
  caught→missed (`isZero` needs exact `"0"`), unrealistic for `.length`.
  *`switch(draft.trim())` remains a documented ceiling.*
- **Q5 (signature drift): none** — gate-set-diff `ADDED []/REMOVED []` at 32
  gates; the external diff script is the guard.

## Defender

- **Seam is real, not claimed (9/10).** The only new export is
  `BlanknessScanError`; `numericReaderFiles()` and `scanNumericDraftReaders()` are
  unchanged; `CLASSIFIED` is byte-identical, so every published signature still
  resolves.
- **Parser rules replace hand-rolled lexing (8/10).** `nearestScope` walks real
  scopes; `visibleDeclaration` picks the innermost preceding declaration whose
  scope contains the comparison — one AST rule subsumes `normalisesWholeValue` +
  `withoutSubscripts`.
- **Receiver rule is exact, not heuristic (9/10).** `isNormalisedReceiver` checks
  the receiver *is* the normaliser call, so `normalizeArabicIndicDigits(prefix).concat(draft)`
  and `drafts[normalizeArabicIndicDigits(id)]` are raw (rounds 3-4 escapes), now caught.
- **Fail-closed is the right trade (8/10).** Refusing loudly converts an invisible
  miss into a red suite; the 19 scoped files are walked by `scanNumericDraftReaders`.
- **Ceilings are honest (7/10).** Assignment bindings, destructuring, computed
  `.trim`, post-trim `switch`, lexical shadowing.
- **Complexity is justified (8/10).** All 13 (now 14) detection branches redden
  when deleted; none is dead code.

## Synthesis

| Finding | Severity | Decision |
|---|---|---|
| `.length` truthiness silently dropped | Blocker | **Fixed** in `53ed964` |
| `var` block scope hides a hoisted binding | Major | **Fixed** in `53ed964` |
| refusal blast radius | Minor | **Kept** — stated ceiling, loud direction |
| `Boolean(x.trim())` | Minor | **Stated ceiling** |
| private-field fixture source | Minor | **Accepted**, documented |
| Standards readability (dup loops, long fn, dispatch chain) | Minor | **Deferred**, no behaviour change |

Defender's "ship it" on the seam was confirmed by the gate-set diff.
