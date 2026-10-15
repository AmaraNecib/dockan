# Test audit — chore-workflow-docs / PR #199 round 1

- HEAD: `e7a859044ee5cab742ee7e874657a1a47780eede`
- Delta: `d74519d..e7a8590` (17 markdown files, zero non-.md)
- Agent: independent `reviewer` sub-agent (test-audit), run 4dc6bf78

## Review

**Scope.** Delta `d74519d..e7a8590` = 17 markdown files, all docs/skill content: vendored TanStack skill examples (byte-identical pairs under `.agents/skills` and `.claude/skills`), `AGENTS.md`, `docs/engineering-workflow.md`, `.agents/skills/guard/SKILL.md`. `git diff --name-only` confirms zero non-`.md` files — no application or test code.

### Q1 — Does this change require new unit/e2e tests or a test update?
**Verdict: No (not applicable).** The delta touches no executable code, and nothing in the repo's suites imports or compiles these markdown blocks — they are illustrative skill examples. There is no behavior to pin. The correct verification for this lane is a manual spot-check of the examples' claims, not a test run. Adding a test here would be noise.

### Q2 — Is the claimed verification adequate?
**Verdict: Adequate for the one checkable claim; the e2e angle is correctly irrelevant.**
- **Base64 UTF-8 Arabic round-trip — reproduced, PASS.** I recreated the doc's exact `stringifySearch`/`parseSearch` (`search-custom-serializer.md`, `.agents/...` diff hunk at "Good Example: Base64 Encoding") in Node and round-tripped: ASCII `{"category":"electronics"}` ✅, Arabic `{"q":"مطعم"}` ✅, `{"name":"متجر الأمانة"}` ✅, mixed `{"q":"مطعم 🍽 café"}` ✅, empty `{}` ✅. The UTF-8-before-`btoa` fix is genuinely correct; the old ASCII-only `btoa(json)` would have thrown on Arabic. The claim holds.
- **e2e suite is not exercised by a docs change — and should not be cited as verification.** A docs-only delta runs no app path; `playwright` results are meaningless as evidence here. The lane must not use "e2e green" as proof of this delta's correctness.

### Q3 — Fabricated / unsupported evidence risk
**Verdict: Low for the internally-checkable claim; two provenance risks.**
- The commit message cites "Greptile #199 findings 1-8 and 11-16" as the source of the fixes. That provenance cannot be confirmed from the repo; if a lane asserts "Greptile confirmed," it needs the fetched comment, else it is unsupported.
- Most examples assert upstream library behavior (`beforeLoad` serial → loaders parallel; `ensureQueryData` returns stale; `stringifySearch` includes leading `?`; `scrollRestoration` at router level). These read as correct against upstream docs but are unverifiable in-repo and untested — acceptable for vendored docs, but a wrong one ships silently.
- **Cross-file consistency verified:** the "schema-version bump = High-assurance" rule now agrees in all three tier tables — `guard/SKILL.md:80`, `docs/engineering-workflow.md:84`, `feature-implement/SKILL.md:24`. Good.
- **Byte-identity verified:** `diff -rq .agents/skills .claude/skills` reports no differing files (`.claude` is a strict subset). The "kept byte-identical" claim holds.

### Gaps
- **Cosmetic sample mismatch (Note).** The displayed URL `?eyJjYXRlZ29yeSI6ImVsZWN0cm9uaWNzIn0` omits the base64 padding the code actually emits (`...In0=`). `atob` tolerates the missing pad on decode, so not a functional bug, but the sample is not literally what the serializer produces.
- **No test enforces any doc claim** — fine for docs, but the Arabic round-trip rests entirely on manual reasoning (which I independently reproduced).

### Confidence score: 4 / 5
The three audit questions are answered with reproduced evidence. One point withheld because the upstream-behavior claims and the Greptile #199 provenance are not independently verifiable from this repo.

## Lane notes
- The Greptile provenance is in-repo: the lane fetched the comment with `gh pr view 199 ...` and used it (see the debate evidence). Not a gap for this lane.
- The `=`-padding sample nit is a comment-only cosmetic; `atob` tolerates the missing pad. Left as-is rather than churn the docs commit.
- The lane did run the full Playwright suite as a Guard Phase 2 gate (56 passed), and reports it as a gate result, not as proof of the doc examples' correctness.
