# #244 round 2 — debate (critic + defender), synthesised at `c143fa8`

Seven read-only lens children ran at `ad884d1`, `f30581c`, `f827d28`, `ba5a0b0`
and `c143fa8` (critic + defender, test-audit edge/coverage/quality, code-review
standards + spec each round — 35 child runs; this lane ran the fanout itself and
wrote this file from the results). Each finding was verified against the code
before acting; several were false and are recorded as such in the design doc.

## Critic

The four findings are closed with real failing-first evidence, and no
raw-`.trim()` blankness gate on a numeric draft in an in-scope file escapes
unclassified and unnamed. The critic's rounds produced, in order:

- the scanner's own escapes: reversed `.length`, a receiver named `draftBlankish`,
  a property read attributed to a local, a formatter-broken chain, a bracketed
  right-hand side, the two-step `.length` gate, `?.length`, the reversed
  parenthesised gate, a type-annotated declaration, `?.`/`?.[`/`#` receivers;
- two claims that did not survive verification: "the inline normaliser guard is
  dead code" (it was reachable and wrongly skipped substring-named receivers) and
  "a duplicate `CLASSIFIED` key silently drops a classification" (46 keys, 46
  verdict lines; the 47th `verdict:` match was the interface field).

Attack table (the shapes the critic used, final observed results in
`c143fa8-scanner-shapes.log`):

| attack | escape mechanism (before) | closing construct |
| --- | --- | --- |
| line layout | line-by-line match + `if (inline) continue` | whole-source `matchAll` + span claim (`claimed`/`overlaps`), inline matchers first |
| inner scope masks outer | last same-name declaration anywhere in the file | `visibleDeclaration`: the declaration's brace pairs must also enclose the comparison |
| mutation proof eats edits | `git diff "$BASE"` + `git checkout --` (index) | dirty refusal + `mktemp` backup + `EXIT` restore, `git apply -R` checked |
| reversed two-step untested | canonical collapsed onto the forward branch | `USE_REV` keeps operand order: `"" === t [draft.trim()]` |
| reversed `.length` | asymmetry with the reversed `=== ""` form | `INLINE_LEN_REV` |
| normaliser as substring | `NORMALISED` was a substring test | matched as a CALL `\b(?:…)\(`; the impossible inline check deleted |
| property read | `other.trimmed === ""` attributed to `const trimmed` | `(?<![\w$.])` fwd, `(?!\s*\.)` rev |
| formatter-broken chain | no whitespace inside `.trim()` / `.length` | `\s*` inside the chain; canonical still collapses |
| bracketed right-hand side | `STATEMENT_BREAK` regex rejected any `}` | `breaksStatement` bracket-depth scan |
| two-step `.length` | not matched at all | `USE_LEN_FWD`/`USE_LEN_REV`, keyed on `.length` |
| `?.length` | `?.` allowed before `.trim()` but not `.length` | `\??` before `.length` in all four `.length` matchers |
| reversed parenthesised gate | `PAREN_FWD` had no twin | `PAREN_REV`; the fallback operand accepts a non-literal |
| typed declaration | `DECL` required `name =` | `(?::\s*[^=;]+)?` before the `=` |
| `?.`/`?.[`/`#` receivers | `CHAIN` allowed neither, and truncated `box?.value` to `value` | `CHAIN` allows `\??\.`, `\??\.?\[` and `#` names |

## Defender

All four findings are fixed with failing-first evidence; the ceiling is stated
with a reason per deliberate omission; and the classification set is provably
unchanged (32 detected gates and 0 changed `CLASSIFIED` lines across the whole
delta). Conceded weaknesses, all stated rather than hidden:

- **Regex literals are not parsed.** A regex holding a quote or a `/*` can
  mis-scope the file or hide every later gate in it — the **unsafe** direction.
  Stated as a deferred follow-up, with the reason a half-lexer is worse (a
  division mis-read as a regex creates a new false negative).
- **`var` is not seen at all**, and a `var`/parameter/`catch` binding can be
  attributed to a same-named visible declaration (both directions stated).
- **A receiver that is not a plain member chain** (a call, an `as` cast, a
  doubly-nested parenthesised expression, `!`, `trimStart()`, a space inside
  `.trim ()`, a newline inside a subscript) is outside the matched forms. Each is
  named in the design doc's ceiling list with the single reason they share:
  enumerating grammar productions is not a boundary.
- **A string/template literal whose text looks like a gate** is scanned as code
  (false positive). Blanking string bodies was rejected because it would hide a
  real gate inside a template `${}` expression.
- **Finding 4's first red run discriminates the canonical text**, not the
  branch's necessity; the branch's necessity is now pinned by
  `branch-pin-proof.sh` (deleting any of the 10 matcher branches reddens the
  suite).
- **A deliberately pruned `raw` verdict** (convert the site *and* delete its
  verdict) is not detected; the pinned behaviour lives in each site's own tests.
  Stated in the test docstring.
