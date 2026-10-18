# #249 test audit (3 lenses) — independent sub-agent at `353089e`

Raw artifact: `.pi/.../subagent-artifacts/8e1e76ec-..._reviewer_output.md`.
Verdict: **A- / ship-ready**, no blockers. Fix commit: `53ed964`.

## Edge case hunter

| Finding | Risk | Decision |
|---|---|---|
| `draftBlank` normaliser name never exercised (only `normalizeArabicIndicDigits`) | orange | **Pinned** — `draftBlank(draft).trim() === ""` → `[]`; `draftBlankish(draft)` → gate |
| CRLF line number unpinned | orange | **Pinned** — `\r\n` source asserts `line === 2` |
| Empty input / comment-only never called | yellow | **Pinned** — both `[]` |
| Lexical-shadowing ceiling unnamed by a pin | yellow | **Pinned** — parameter shadow still attributes to the outer raw local |
| `''` operand canonicalisation unpinned | yellow | **Pinned** — `=== ''` → `=== ""` |
| `0.0` / `0x0` not zero-operands | yellow | Left as-is (`isZero` is exact `"0"`; unrealistic for `.length`), stated |

Green already: optional chaining (`?.trim()`, `?.length`, `drafts?.[id]`), nested
scopes/masking, `??` receivers incl. non-literal fallback, non-ASCII (`dé`).

## Coverage analyst

All six brief "comes free" shapes have a fixture (comments, regex
quote/`/*`/`//`, string-vs-`${}` + nested template, non-ASCII, appended
normaliser, inner-scope mask). Fail-closed refusals covered, with positive
controls. gate-set-diff, mutation proof, branch-pin proof, typecheck/lint logs
present. Acceptance criteria met. Four `#249` tests deliberately re-pin `#244`
shapes (low cost, regression pins).

## Quality reviewer

**A-.** Names cite issue + round + finding; isolation clean (pure `signatures`
helper, per-test literals); assertions are exact signature strings + lines.
Soft spots noted: refusal tests assert the message by regex, not the full string;
empty-result `toEqual([])` is weak alone but paired with positive twins; no
explicit offset-sort or `.tsx` ScriptKind assert (exercised implicitly by
`scanNumericDraftReaders`). Not fixed — the message regex is intentional so the
tests do not couple to the error text; `.tsx` parsing is covered by the 19-file
scope scan.

## Fixes applied at `53ed964`

The audited rev also carried the debate/code-review blocker (`.length`
truthiness). The red-first `.length` truthiness fixture and two-step variant were
added alongside the six pins above. Suite: **52 pass / 0 fail**.
