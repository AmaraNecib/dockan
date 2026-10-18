# #244 round 4 — harsh-critic review of `1af565f...ef32177`

Verdict: **no blocker, no security/ratchet escape found in the unsafe direction.**
Every round-4 fix is present, pinned by a failing-first fixture, and behaves as
claimed. Seven prior-round notes re-verified (below). Severity ≥4 findings: none.

## Prior-round items — re-verified (not re-reported)

- (a) Separator only at a fuse boundary — `fusesTokens` (`blankness-gates.ts:132-141`)
  emits a space only when both sides are word chars; the `insideChain` fixture
  (`draft./* gap */trim()`) stays `draft.trim()` and is caught. Confirmed by probe.
- (b) `#` is not a word char — `isWordCharacter` uses `/[\w$]/ || code>127`; the
  `this.#/* gap */draft.trim()` fixture yields `this.#draft.trim() === ""`. Confirmed.
- (c) Scope-shrink proof requires the assertion `names only files inside the scanned
  scope`; that exact string exists (`blankness-ratchet.test.ts:398`) and the grep
  matches on one bun `(fail) …` line (log tail confirms).
- (d) `withoutSubscripts` docstring now cites `normalisesWholeValue`, not the deleted
  `NORMALISED_VALUE` (`:265-271`).
- (e) KNOWN CEILING states both false positives (nested-template arg, string subscript)
  and that `breaksStatement`/`normalisesWholeValue` inherit the regex-literal ceiling.
- (f) Design doc finding-4 bullet describes the green baseline + expected assertion.
- (g) `concurrent-probe-demo.sh`: CASE A (old fixed path) deletes the saved probe,
  CASE B (new, two concurrent runs) green + byte-identical + no leftover; trap installed
  before any mutation. Log confirms.

## Adversarial escape attempts (all failed / safe-direction only)

- Appended call `normalizeArabicIndicDigits(prefix).concat(draft).trim()` → reported raw;
  the depth walk ends at the normaliser's own `)` and the non-empty `.concat(draft)`
  tail makes it raw (`normalisesWholeValue:243-266`). Probe confirms.
- Nested template `` `${flag ? `;` : draft}`.trim() `` → caught. `breaksStatement` frame
  stack correctly pushes/pops template and `${}` code frames; every change only
  *removes* false breaks (safer), never adds one.
- Unterminated quote / regex-quote mismatch inside the normaliser argument makes
  `normalisesWholeValue` return false (over-report) — safe, not an escape.
- Considered `withoutSubscripts` on `normalizeArabicIndicDigits(draft)[0]`: strips the
  subscript to the whole call and suppresses. The trimmed value is a subscript of the
  normaliser's result, i.e. already normalised, so suppression is correct.

## Notes (severity <4, not blockers)

- Note (`blankness-gates.ts:263-268`): `withoutSubscripts` silently drops a `]` seen at
  depth 0 (`else if (char === "]") { if (depth > 0) depth -= 1; }` — it is never
  re-emitted). No valid TS counterexample found where this alone converts a raw receiver
  into a whole-normaliser match, but it is an unguarded character deletion; a comment
  would help the next reader.
- Note (`concurrent-probe-demo.sh:20,46`): CASE A/B write/delete the *fixed* path
  `apps/web/src/tests/__scanner-shapes.ts`; if a developer had a real probe there, the
  demo's cleanup deletes it — the very collision finding 5 fixes. Low impact (demo-only).
- Note: `gate-set-diff.sh` default `REF=f30581c` is not validated against `origin/develop`;
  a stale/missing ref fails loudly via the existing `git rev-parse` guard, so acceptable.

## Residual risk

The regex-literal ceiling (a `/…/ ` holding a quote, backtick or `/*` can mis-scope and
HIDE later gates — the unsafe direction) is real and acknowledged in KNOWN CEILING, not
newly introduced. It is the strongest argument for the author's "the approach is the
problem" conclusion; the brief says do not re-report it, so it is recorded only as the
open residual risk the AST migration would close by construction.
