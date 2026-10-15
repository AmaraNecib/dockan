# Code review (Standards + Spec) — chore-workflow-docs / PR #199 round 1

- HEAD: `e7a859044ee5cab742ee7e874657a1a47780eede`
- Delta: `d74519d..e7a8590`; whole PR: `bcc586a..e7a8590`
- Base: `bcc586a7b8a80b9f13135fd510e5fbbac76e0293`
- Agent: independent `reviewer` sub-agent (code-review), run 4853e32f

## Review

### Spec axis — all 16 Greptile findings have a landed fix

I inspected the round-1 delta `d74519d..e7a8590`; every finding maps to a change. No finding is left unaddressed and none was closed without a landed edit.

| # | Finding | Fix location (post-fix) | Verdict |
|---|---------|-------------------------|---------|
| 1 | `search.serialize`/`search.parse` wrong shape | `search-custom-serializer.md:28-42,53-72,81-104,112-137,148-196` — all 5 examples moved to top-level `stringifySearch`/`parseSearch`, each handling the leading `?` | Landed |
| 2 | Scroll options misplaced | `.agents/skills/tanstack-router/SKILL.md:595-605` — `scrollRestoration: true` on `createRouter`, `resetScroll` on `navigate` | Landed |
| 3 | `withResolver` on discarded call | `tanstack-router/SKILL.md:425-455` — `withResolver` now on the call whose `{proceed,reset,status}` is used; simple confirm resolves inside `shouldBlockFn` | Landed |
| 4 / 11 | Lists crash on empty cache | `tanstack-query/SKILL.md:358-384` (`InfiniteList`) and `:452-462` (`PaginatedList`) — `isPending`/`isError` branches before reading `data` | Landed |
| 5 | `placeholderData` defined twice | `tanstack-query/SKILL.md:181-187` — one active key, alternative commented, comment "each key appears once" | Landed |
| 6 | `ensureQueryData` freshness claim | `load-ensure-query-data.md:45-58,144-152` — now "returns cached data immediately, even if stale"; points at `fetchQuery`/`revalidateIfStale` | Landed |
| 7 / 14 | Parallel-loader contradiction | `load-parallel.md:21-33` (bad example no longer a parent/child waterfall), `:158-182` (timeline now serial `beforeLoad` then parallel loaders), `org-route-tree-structure.md:93` | Landed |
| 8 / 13 | Route-mask modal/full-page | `nav-route-masks.md:43-120,154-224` — separate modal route + full-page route, mask to `/posts/$postId` with params, behaviour table rewritten | Landed |
| 9 | Vault ports (ours) | `AGENTS.md:32-35` — states `tests/e2e/vault.spec.ts` hardcodes 4399/5174, "vault-touching e2e runs are one lane at a time", notes configurability as separate change | Landed |
| 10 | Schema-version tier (ours) | `.agents/skills/guard/SKILL.md:80`, `docs/engineering-workflow.md:84`, `.agents/skills/feature-implement/SKILL.md:24` — all three now list "a schema-version bump" | Landed |
| 12 | `previousTodos` undefined | `tanstack-query/SKILL.md:219-228` — captured via `queryClient.getQueryData(['todos'])` | Landed |
| 15 | `btoa` fails on Arabic | `search-custom-serializer.md:112-137` — UTF-8 bytes via `TextEncoder` before `btoa`, reversed on parse | Landed (round-trip verified, see below) |
| 16 | Mutation ignores `res.ok` | `tanstack-query/SKILL.md:213-224` — `if (!res.ok) throw …` before parsing, so HTTP 400 can't run `onSuccess` | Landed |

Finding 15 round-trip, run against the code as written:
```
encoded: eyJxdWVyeSI6ItmF2LHYrdio2KcifQ==
decoded: {"query":"مرحبا"}
roundtrip-ok: true
```
The Arabic string survives encode→decode intact.

### Standards axis

- **Copy parity (correct).** `diff -rq .agents/skills .claude/skills` shows *only* `Only in .agents/skills:` lines for the 19 pre-existing dirs absent from `.claude` (accessibility, agent-browser, … web-design-guidelines) — no `differ` lines. `cmp` on all 7 changed shared files (`tanstack-query/SKILL.md`, `tanstack-router/SKILL.md`, and the 5 rules files) reports `IDENTICAL`. The byte-identical contract holds.
- **Markdown fences (correct).** Fence counts are even in every touched file (`nav-route-masks.md`=10, `search-custom-serializer.md`=12, `load-parallel.md`=12, `tanstack-query/SKILL.md`=58, `tanstack-router/SKILL.md`=58) — no broken/unclosed blocks.
- **Tier docs consistent (correct).** `grep schema-version` returns exactly the three tier definitions and nothing else.
- **Note — prose wrapping.** `nav-route-masks.md:6-12` and `:46-50` (and the new comments in `search-custom-serializer.md`) introduce hard-wrapped multi-line prose, whereas the surrounding vendored rules files use one line per paragraph. `.agents/skills/unslop/SKILL.md` does **not** document a wrapping rule (its patterns cover puffery, -ing phrases, inline-header lists, etc.), and `AGENTS.md` is itself wrapped at ~80 cols — so this is a cosmetic inconsistency, not a documented-standard breach. Low confidence; not a blocker.
- **No AI tells found.** The new prose is plain and specific; no puffery/promotional phrasing in the added lines. (unslop pattern scan on the diff.)

### Residual risks
- Finding 15's base64 output can contain `+`, `/`, `=` (confirmed: `…KcifQ==`), which are not query-safe. Round-trip works once the value is in the search object, but a raw `?...` URL with unescaped base64 could be mangled. This predates the Greptile finding (it flagged only Unicode) and TanStack may URL-encode on emit — worth a one-line callout if the example is meant to be copy-paste-runnable.
- I did not execute typecheck/lint/Playwright or type-check the examples against real `@tanstack/react-router` types; verification here is by reading the corrected APIs against the Greptile-specified shapes, not by compiler. The `stringifySearch`/`parseSearch` signatures and `resetScroll`/`scrollRestoration` options match TanStack's documented router options.

### Confidence
**4.5 / 5** — all 16 findings verified landed with file:line evidence; copy parity and the Arabic round-trip independently confirmed. The half-point is withheld because example correctness is confirmed by inspection, not by a type-checker or runtime against the real libraries.

## Lane close-out
- The `+`/`/`/`=` residual is not a defect in this example: the router applies no extra encoding to the `stringifySearch` output (`router.ts:1471,1493,2113`), and the example's `parseSearch` reads the raw `url.search` and `atob`s it, so the round-trip holds. Users who want percent-encoded output are pointed at `stringifySearchWith`/`parseSearchWith` in the file's Context.
- Prose wrapping is cosmetic; the vendored rules files are inconsistent on this already. Left as-is.
- The lane typechecked/linted/tested/e2e'd the repo at this SHA (see `-guard1.md`, `-guard2.md`); those gates cover the repo, not the markdown samples.
