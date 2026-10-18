# #227 round 2 — Test-audit evidence

- Tier: **High-assurance** (stock-movement delta).
- Base for the round's delta: PR #239 head `baa4cfa` (code head `e472d5b`); PR
  merge-base with `origin/develop` is `6708324`.
- Reviewed HEAD: `15d46e8` (final round-2 code; first round-2 commit `a7922f8`).
- Method: three independent `reviewer` sub-agents (edge-case hunter, coverage
  analyst, quality reviewer) as separate read-only sub-agents. The parent
  reproduced every mutation and the live probes. A first audit round at
  `a7922f8` produced the coverage findings actioned in `15d46e8`; this file
  records the audit at the final SHA.

## Grades

| Test file | Grade | Note |
|---|---|---|
| `apps/web/src/lib/numeric-input.test.ts` — ordering pin | A | Name states mechanism + rule; literal anchors; premise assertion shows the mark is interior. |
| `apps/web/src/lib/numeric-input.test.ts` — control pin | B | Correct but a grab-bag (edge, overrides, ASCII, blank, ceiling); some overlap with round-1 pins. |
| `apps/web/src/lib/amount-parse.test.ts` | A | Unchanged this round; round-1 ten-mark loop still covers the shared normaliser. |
| `tests/e2e/sale-checkout.spec.ts` | B+ | Unchanged this round; the paste pin does not exercise the signed stock path. |

## Criterion → test map

1. **Interior mark after `-` refused** — `numeric-input.test.ts`: `-␆5`, `-␆٥`,
   `-␆۵`, `-␆␆5`, `-1␆000` all `null`.
2. **Ordering pin fails on a reorder** — the test first proves
   `normalizeArabicIndicDigits("-\u200f5") === "-\u200f5"` (the mark is interior
   to the signed draft), then requires `null`. Reordering the two steps makes the
   mark leading and the reader return `-5`; the assertion fails (executed proof
   below).
3. **Edge marks still stripped** — `"\u200f٥"` → 5, `-5\u200f` → -5,
   `"\u200f5"` → 5.
4. **ASCII identity** — `123`, `-5`, and the round-1 identity pins unchanged.
5. **One shared normaliser** — `readNormalizedDigits` only tests + converts and
   is never called with a string that still needs normalising (the magnitude is
   read from the whole-draft-normalised string). No test structurally forbids a
   second normaliser; source review enforces it.
6. **Sign-aware judgement** — the whole normalised signed draft is gated
   `/^-\s*\d+$/u` before the sign is sliced; pinned by `- 5` → -5, `-` → null,
   `-\u200f5` → null.

## Mutation evidence (parent-executed at `15d46e8`; source reverted immediately, `git status` clean after)

| Mutation | Result |
|---|---|
| Re-create the round-1 order in `parseSignedWholeNumber` (`parseWholeNumber(trimmed.slice(1))` after `startsWith("-")`) | **1 fail / 12 pass** — `judges the whole signed draft before dropping the sign…`: `expect(received).toBeNull()`, `Received: -5`. Raw probe: `parseSignedWholeNumber("-\u200f5")` = `-5`. |

The parent then restored the file (`cp` backup), re-ran the suite (13 pass / 0
fail), and confirmed `git status` clean and `HEAD = 15d46e8`.

## Findings actioned since the first audit round (`a7922f8` → `15d46e8`)

1. The judgement was made after slicing the sign (spec/standards note) — now the
   whole normalised signed draft is judged sign-aware before the slice.
2. `"- 5"` was unpinned — now pinned.
3. No combined-edge, override, blank or safe-integer boundary controls — added.
4. The test used raw `\u0665`/`\u06F5` escapes where the file imports
   `toArabicIndic`/`toExtendedArabicIndic` — switched to the helpers.

## Remaining gaps (accepted / deferred, all disclosed)

| Gap | Severity | Disposition |
|---|---|---|
| No *consumer* pin: neither `stock.tsx` nor a stock e2e exercises an interior-mark-after-sign draft. The reader-level pin covers the current call sites (`stock.tsx` calls the reader directly, no pre-processing). | Medium (coverage analyst) | **Deferred** as a candidate follow-up. The design documents the consumer; adding a `stock.test.tsx`/e2e pin would not change the reader's behaviour and would re-key this evidence. |
| Ordering pin is RLM-only between sign and digits; other marks are covered at the edge by the round-1 loop. | Low | Accepted — the rule is position-based, RLM is representative. |
| `-0` returns `-0` (unpinned). | Yellow | Deferred; the stock form refuses it through `parsedDelta === 0`. |
| Mixed digit scripts compose (`-٥۵` → -55); typographic minus U+2212 refused. | Yellow | Pre-existing reader semantics, out of scope. |
| The premise assertion is redundant for failure detection (the `toBeNull` lines already fail on the reorder). | Note | Kept — it documents *why* the refusal is correct. |

## Commands at `15d46e8`

| Command | Result |
|---|---|
| `bun run typecheck` | exit 0 (4/4 turbo tasks) |
| `bun run lint` | exit 0 (oxlint, no output) |
| `bun run test` | exit 0 — web 1135 pass / 0 fail; api 934; desktop 68; e2e-support 22; scripts 73 pass / 1 skip / 0 fail |
| `bun test apps/web/src/lib/numeric-input.test.ts` | exit 0 — 13 pass / 0 fail / 85 expect |
| `bun run test:e2e tests/e2e/sale-checkout.spec.ts` | exit 0 — 5 passed (`DOKAN_PORT=4441 DOKAN_WEB_PORT=5291`) |
| mutation reorder on `numeric-input.ts` | 1 fail / 12 pass, reverted, tree clean |
