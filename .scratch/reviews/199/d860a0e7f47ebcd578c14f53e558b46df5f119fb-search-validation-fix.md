# PR #199 — Round 3 search-validation fix + class sweep at `d860a0e`

HEAD: `d860a0e7f47ebcd578c14f53e558b46df5f119fb`
Worktree: `D:/projects/mani-worktrees/chore-workflow-docs`
Branch: `chore-workflow-docs-and-tanstack-skills`

Change scope: markdown-only, TanStack skill examples in `.agents/skills/` +
byte-identical `.claude/skills/` mirrors. No app code.

## Greptile round-3 finding (REAL) — fixed

`numberOrDefault` in
`.agents/skills/tanstack-router-best-practices/rules/search-validation.md`
dropped `''` but not whitespace. `Number(' ')` is `0` and passes
`Number.isFinite`, so `?maxPrice=%20` produced an upper bound of `0` instead of
leaving the bound unset.

Before → after (line 33-35, both mirrors):

```diff
-    // Keep a legitimate 0, drop empty values and non-numeric junk (NaN)
+    // Keep a legitimate 0, drop empty/whitespace values and non-numeric junk (NaN)
     const numberOrDefault = (value: unknown) => {
-      if (value === undefined || value === '') return undefined
+      if (value === undefined || (typeof value === 'string' && value.trim() === '')) return undefined
       const parsed = Number(value)
       return Number.isFinite(parsed) ? parsed : undefined
     }
```

The comment now matches the code: it drops empty **and whitespace-only** values.

## Class sweep — same string → `Number(...)` / emptiness defect

Every `Number(...)` / `parseInt(...)` / emptiness check reachable from the
skills changed in this PR:

| Site | Verdict |
|---|---|
| `tanstack-router-best-practices/rules/search-validation.md:41` `page: Number(search.page) \|\| 1` | Safe — `\|\| 1` already catches `''`/whitespace (`0` is not a valid page). |
| `tanstack-router/SKILL.md:112` `page: Number(search.page ?? 1)` | **Same class — fixed.** `?? 1` only catches `undefined`/`null`; `?page=%20` → `Number(' ')=0`. Changed to `Number(search.page) \|\| 1`. |
| `tanstack-router/SKILL.md:105` `Number(params.postId)` | Safe — comes from a required `$postId` path segment, never empty/whitespace. |
| `search-custom-serializer.md:103,199` `parseInt(value, 10)` | Safe — guarded by `/^-?\d+$/`, so whitespace never reaches `parseInt`. |
| `nav-use-navigate.md` `String(form.get(...) ?? '')` | Not this class — no `Number()` conversion. |

## Live proof (tracks the doc text, not a re-typed copy)

The harness extracts the `numberOrDefault` body and the `page:` expression
straight out of the markdown fences, then decodes real query strings with
`URLSearchParams`. Run with `bun`:

```ts
const params = new URLSearchParams('maxPrice=%20&minPrice=0')
const caseOf = (k) => numberOrDefault(params.get(k))
```

```
PASS  ?maxPrice=%20  -> unset                      got undefined
PASS  ?minPrice=0   -> 0 (legit zero survives)     got 0
PASS  numberOrDefault(' ')   -> unset              got undefined
PASS  numberOrDefault("\t\n")-> unset              got undefined
PASS  numberOrDefault('\u00A0')-> unset            got undefined
PASS  numberOrDefault('')    -> unset              got undefined
PASS  numberOrDefault(undefined) -> unset          got undefined
PASS  numberOrDefault('0')   -> 0                  got 0
PASS  numberOrDefault(0)     -> 0                  got 0
PASS  numberOrDefault('12.5')-> 12.5               got 12.5
PASS  numberOrDefault('abc') -> unset              got undefined
PASS  ?page=%20 -> 1                               got 1
PASS  ?page=   -> 1                                got 1
PASS  ?page=3  -> 3                                got 3
PASS  absent   -> 1                                got 1
PASS  OLD numberOrDefault(" ") === 0 (bug)         got 0
PASS  OLD page({page:" "}) === 0 (bug)             got 0

17/17 checks passed
EXPR_FROM_DOC numberOrDefault body: "if (value === undefined || (typeof value === 'string' && value.trim() === '') return undefined\r\n      const parsed = Number(value)\r\n      return Number.isFinite(parsed) ? parsed : undefined"
EXPR_FROM_DOC page: Number(search.page) || 1
```

The last two rows run the **old** expressions and confirm the bug was real
(`' '` → `0`), so the fix is not a phantom.

## Greptile round-3 finding (STALE) — verified at HEAD, not re-fixed

"Empty caches break optimistic updates" (`tanstack-query/SKILL.md`). At
`d860a0e` the fix already exists:

```
314:  // Seed an empty cache: before the first fetch resolves, `old` is undefined
315:  queryClient.setQueryData(['todos'], (old = []) => [...old, newTodo])
```

`(old = [])` seeds the array before the first fetch resolves, and the comment
states why. No change made; close the thread with this line evidence.

## Reviews run this round (judgement: diff is 3 changed lines × 2 mirrors)

| Review | Run? | Why |
|---|---|---|
| Guard 1 (typecheck, lint, unit) | Yes | Always required. See `…-guard1.md`. |
| Guard 2 (full Playwright) | Yes | Brief asked for it in full. See `…-guard2.md`. |
| Live behavioural proof + class sweep | Yes | The finding is a runtime bug; a doc-only diff still needs the table above. |
| test-audit / debate / code-review | No | Diff is a mechanical one-condition guard plus one fallback; the live proof covers the behaviour and there is no design surface to debate. |
| Greptile CLI | No | The PR flow is the hosted Greptile review; this round is a response to it. |

No push (per brief).
