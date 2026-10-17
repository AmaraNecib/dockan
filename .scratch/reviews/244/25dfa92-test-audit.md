# #244 round 5 — test audit, HEAD 25dfa92

Fixture under audit: the last `it(...)` in
`apps/web/src/lib/blankness-ratchet.test.ts` ("reads JSX child text inside a
template expression as text, not code (#244 round 5, finding 1)").
Scanner guard: `else if (frames.length === 1) return true;` in `breaksStatement`
in `apps/web/src/tests/blankness-gates.ts`.

## Verdict

PASS. The fixture discriminates the fix. No source edit required.

## Discrimination (verified by importing the old scanners from temp copies)

| fixture | HEAD | round-4 (`ef32177`) | round-3 (`1af565f`) | role |
| --- | --- | --- | --- | --- |
| `<span>)</span>` | gate found | `[]` | gate found | fails on round-4, passes HEAD |
| `<span>]</span>` | gate found | `[]` | gate found | fails on round-4, passes HEAD |
| `<span>}</span>` | gate found | gate found | gate found | non-regression pin |

The `)`/`]` assertions use `.toEqual([signature])` and return `[]` on round-4, so
they are not tautological. The `}` assertion is the same form (a scanner that
dropped the `}` gate would fail it) and is honestly described in the test comment
as a pre-existing result, not part of the proof.

Commands:

```
git show 1af565f:apps/web/src/tests/blankness-gates.ts > .scratch/reviews/244/audit-r3.ts
git show ef32177:apps/web/src/tests/blankness-gates.ts > .scratch/reviews/244/audit-r4.ts
# temp probe importing HEAD + r3 + r4 (deleted after the audit)
cd apps/web && bun test src/lib/blankness-ratchet.test.ts   # 33 pass, 0 fail, 64 expects
```

## Edge cases tried

| case | result |
| --- | --- |
| `)` in a multiline JSX child | HEAD catches, round-4 loses |
| `)` inside a plain string arg (`replace(")", "")`) | all three catch — no regression |
| `)` in a nested template (`` `${`${draft})`}` ``) | HEAD + round-4 catch, round-3 misses |
| unmatched `)` at top level (no template) | all three catch — the fix does not over-suppress |
| `/*` in JSX child text | all three return `[]` — the documented unsafe ceiling |
| `"` in JSX child text | all three catch |

## Notes (non-blocking)

- A reviewer's scratch file `r3-scanner.ts` was not the round-3 scanner (it
  carried round-4-era content). It was deleted; the `git show 1af565f` extraction
  is the true round-3 source used above.
- Two optional additions were suggested and deliberately not taken, to keep the
  round minimal: a multiline `)` variant, and a canary for the `/*` ceiling. The
  canary would codify currently-unsafe behaviour; both are #249's to solve.
