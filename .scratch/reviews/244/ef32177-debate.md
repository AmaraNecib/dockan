# #244 round 4 — debate (adversarial review + synthesis) at `ef32177`

Base `1af565f` → head `ef32177`. Raw agent reports:
`.scratch/reviews/244/ef32177-debate-critic.md`, `ef32177-debate-defender.md`.

Two earlier review rounds ran on this lane (`d60a0fe`, then `3a1a1ae`); their
findings were applied and the round was re-run on `ef32177`. Dispositions below
include the earlier rounds because they changed the final code.

## Final-round critic (severity ≥ 4)

**No blocker. No input found that lets a raw gate escape.** All seven
prior-round items re-verified. Residual notes below severity 4:

- `withoutSubscripts` drops a depth-0 `]` silently — a malformed-receiver nit, not
  reachable from the matched shapes.
- `concurrent-probe-demo.sh` cleaned the fixed probe path it warns about — **fixed**
  (the demo now refuses before installing its trap; verified the refusal leaves a
  real saved file byte-identical).
- the acknowledged regex-literal ceiling (unsafe, deferred by decision).

## Final-round defender

Defended every fix at 8-9/10 with file:line and log evidence. Named two artifacts
the design doc cited that did not yet exist — `guard-phase2.log` and
`code-review.md` — both produced for this head — and noted the design doc did not
record the private-field correction; it now does. Overall: the risk is the
approach, not this diff.

## Earlier rounds and dispositions

| finding | severity | disposition |
| --- | --- | --- |
| always-a-space comment separator lost `draft./*c*/trim()` (a shape the pre-fix scanner caught) | must-fix (new escape) | **fixed** at `3a1a1ae`; separator now only between two word characters; `insideChain` fixture; verified the fixture fails on the always-a-space variant |
| `isWordCharacter` counted `#`, so `this.#/*c*/draft` became `this.# draft` and the gate was attributed to an invented `draft` receiver | major (wrong attribution) | **fixed** at `ef32177`; `#` is a sigil, not an identifier char; `privateField` fixture |
| docstring still cited the deleted `NORMALISED_VALUE` regex | blocker (doc) | **fixed** at `ef32177` |
| design doc named the raw-verdict assertion instead of the scope assertion the script requires | minor | **fixed** at `ef32177` |
| `concurrent-probe-demo.sh` could destroy a real saved probe (fixed path + unconditional `rm`); its trap also ran on refusal | major | **fixed** at `ef32177`; refusal before the trap, hash-compared |
| `normalisesWholeValue` tracks quotes flat; `withoutSubscripts` is quote-blind | minor (safe direction, over-report only) | **deferred**, stated in KNOWN CEILING; fixed by the AST walk |
| regex literals desync `scanSource`/`breaksStatement`/`normalisesWholeValue` | pre-existing, unsafe | **deferred follow-up** (already carried from round 3), the AST walk removes it |
| duplicated lexers (`scanSource` vs `breaksStatement` vs `normalisesWholeValue`) | judgement call | **accepted**: the AST rewrite is the owner's decision (design doc answer); a fourth hand-rolled lexer would grow the surface |
| non-ASCII identifier binding (`const dé = draft.trim()`) unseen (pre-existing leak) | pre-existing, unsafe | **deferred follow-up**, recorded in the design doc |

## Verdict

No blocker and no raw-gate escape on the final head. The two must-fix items were
new escapes introduced by round-4's own fixes; both are now pinned by fixtures
that fail on the offending variant.
