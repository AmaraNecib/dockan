# #222 — code review at `7b03343` (Standards + Spec) and Gate evidence

Delta: `git diff 45328fd...HEAD` (`45328fd` = #215 PR head rebased onto current `develop`).

## Standards axis (verbatim)

Standards read: `AGENTS.md`, `docs/engineering-workflow.md`, `docs/development-workflow.md`,
`.agents/skills/code-review/SKILL.md`, wisdom `2026-10-15-display-vs-recording-order.md`,
`2026-10-15-cost-pin-proves-the-call-not-the-query.md`, `.scratch/implementation/222-design.md`.

**Hard violations: none.** The money path is untouched (wisdom *display-vs-recording-order*: "must not
touch the money path"); the fix changes provenance annotation only. The window default keeps the old
whole-list contract, and the router keeps `supersededBySeq` on the wire — no contract, store or schema
edit.

Judgement calls:
1. **Redundant guard — `stock-ledger.ts` (~line 305).** The final
   `if (i >= start && answer !== null)` re-tests `i >= start`, already guaranteed by the
   `if (i < start) continue;` above. Harmless.
2. **Defensive clamp — signature.** `Math.max(0, Math.min(...))` guards inputs the sole caller cannot
   produce. The spec asks for the window, not the clamp; harmless, keeps the pure function total.
3. **Naming — `top`/`nearest`/`answer`/`found`.** `top`/`nearest` are disambiguated by the doc block.
4. **Repeated `correctionSeqs[correctionSeqs.length - 1]`.** `.at(-1)` would read once; cosmetic.

Correct: the router hunk is minimal and page-relative (`superseded[index]` over a page-sliced array),
the i18n edit is page-agnostic and the e2e pairs a positive with the negative assertion, and the
complexity pin counts reads rather than wall-clock (wisdom *cost-pin*).

## Spec axis (verbatim)

**Missing / partial:**
1. **Evidence files** — the brief demands `.scratch/reviews/222/<sha>-{debate,test-audit,code-review}.md`;
   this file and its siblings are that gate's output.
2. **Mutation-check evidence** — recorded below; the guard is discriminating (old read ratio 3.99 vs
   the ≤2.5/≤3 pins).
3. **"Scope it to pages" is partial** — the resolver walks `0..to`, so a deep page still reads
   `offset+limit` rows. It fits the brief's allowed *"index first and then slice"* option and removes
   the O(n²); the cross-page badge (which the same brief requires) inherently needs rows above the
   window.

**Scope creep: none.** Production delta = index + window in `stock-ledger.ts`, page-slice in
`router.ts`, copy in `i18n.ts`. The optional `from/to` default to whole-list, so #215 callers are
untouched. Extra tests are justified by the brief's "prove it is a fix".

**Implemented but wrong: none.** Dominance drop, binary search (nearest position qualifying), window ≡
`full.slice(from,to)` for every `[from,to]`, router alignment, unchanged `isCostCorrection` predicate,
no schema/store change, page-agnostic copy.

## Operation count (finding 1) — measured

Property-read counter over an indexing wrapper (same harness both sides), at `7b03343` vs the unfixed
`45328fd`:

| Workload | Rows | Before (`45328fd`) | After (`7b03343`) |
| --- | --- | --- | --- |
| 10,000 inflows, no corrections (Greptile's case) | 10,000 | **50,015,000** | **30,000** |
| same, doubled | 20,000 | 200,030,000 | 60,000 |
| nearest qualifier buried under smaller corrections | 1,001 | 6,503,500 | 19,999 |
| same, doubled | 2,001 | 26,007,000 | 41,999 |

The 2N/N ratio is **2.0** (no corrections) and **≈2.1** (buried) after the fix, against **≈4.0**
before — the pin bounds are 2.5 and 3.0.

## Mutation (crossword)

With `apps/api/src/lib/stock-ledger.ts` restored from `45328fd`, the issue-222 suite fails **5** cases
— `aligns the answer to the requested page window, using corrections above it`,
`answers each window as the whole-ledger answer sliced`,
`answers a window from a deep index built above it`,
`does about linear work for 2N rows as for N when there are no corrections`,
`stays about linear when the qualifying correction is buried under smaller ones` — while the 53 other
cases (#215 semantics) stay green. The guard is discriminating.

## Parent synthesis

| Finding | Decision |
| --- | --- |
| Redundant `i >= start` | **Dismissed** — cosmetic; another evidence round would cost more than it removes. |
| Defensive clamp | **Dismissed** — keeps the pure function total; `paginationInputSchema` already bounds the caller. |
| `اللاحق` wording | **Dismissed** — order-based and page-agnostic; the misdirection the finding named was the page claim. |
| Router window not black-box pinned | **Documented residual** — output is intentionally identical to the old shape; the misalignment case is caught by `router.test.ts:4516`. |
| Per-page work Θ(offset+limit) | **Documented residual** — `historyWithRemaining` already walks the ledger for cumulative `stockAfter`/`total`; the O(n²) term is gone and page 1 stops the walk at its end. |

## Gates

- Guard Phase 1 (pre-commit): `bun run typecheck` **exit 0**; `bun run lint` **exit 0**;
  `bun run test` **exit 0** (turbo 4/4 tasks). Note: one full-suite run failed only with
  `SQLITE_FULL`/5 s timeouts while C: was 100% full under four sibling lanes; after clearing stale
  test scratch the same suites pass (api 934/934 in isolation, web 1083/1083, full turbo 4/4).
- Targeted: `bun test src/lib/stock-ledger.test.ts` 58 pass; `bun test src/pages/stock.test.tsx` 21
  pass; `bun test src/rpc/router.test.ts -t "item history recording order"` 3 pass.
- E2E: the cross-page spec is run in Guard Phase 2.
