# A normalisation that empties a non-blank draft re-opens every raw-blank guard (🔴 Critical)

**Date:** 2026-10-16 · **Ticket:** 227 · **Area:** apps/web/src/lib/amount-parse.ts, apps/web/src/lib/invoice-draft.ts

#227 strips the Unicode `Bidi_Control` marks (RLM/LRM/ALM and the explicit
embeddings/isolates) in `normalizeArabicIndicDigits`, the one normalizer every
money reader shares, so a pasted `"\u200f٥"` reads as 5 instead of being
refused. The strip is correct. What it *newly created* is the class
"non-empty raw draft, empty normalised draft": `"\u200f"` normalises to `""`.
A bidi mark is Unicode `Cf`, **not** ECMAScript `WhiteSpace`, so
`String.prototype.trim()` does not drop it.

Two guards in `lib/invoice-draft.ts` tested blankness on the raw draft
(`overrideValue.trim() === ""`). For a mark-only override (`" "` was fine,
`"\u200f"` was not) the guard saw a *chosen* value while `parseLooseNumber`
read `0` — so the sale line **billed free**: exactly the hole
`saleOverrideInvalid` exists to close, reopened through an invisible string.
Reachable by pasting a marked value and deleting the digits. Before #227 the
same input was refused (`Number("\u200f")` is `NaN`).

**Always**: when a normalisation can turn a non-empty draft into `""`, grep
every blank check on that draft and send it through the *same* normaliser. The
raw `.trim()` predicate and the normalising reader must never disagree about
"empty". Fix here was one private `draftBlank(draft)` used by both the price
(`saleUnitPrice`) and the guard (`saleOverrideInvalid`).

**Always**: pin the *mark-only* draft per field, not just the happy path. The
happy-path pins (leading mark + digits) all passed while the mark-only hole was
open. The failing pin was `saleOverrideInvalid({ overrideType: "AMOUNT",
overrideValue: "\u200f" }) === true` (it was `false`).

**Always**: an invisible mark is not "nothing". `trim()` is the wrong emptiness
test for `Cf` format characters; use the reader's own normalisation. (U+FEFF is
the trap in reverse: it *is* ES `WhiteSpace`, so `trim()` already drops it — do
not attribute that to a strip that leaves it alone.)

**Always**: strip the *property*, not the three marks the ticket names. The
Unicode `Bidi_Control` set is exactly 12 code points
(`U+061C U+200E U+200F U+202A-202E U+2066-2069`); none is a digit, sign or
separator, so a money draft can never legitimately contain one and dropping all
of them cannot change a number. Pin the boundary both ways: loop all 12 (so a
typo'd range boundary fails), and assert a non-`Bidi_Control` invisible
(U+200B ZWSP, U+2060, U+FEFF) is *not* stripped, so a future widening to
`\p{Cf}` fails loudly.

**Always**: an e2e "paste" pin must assert the field still *holds* the mark
(`await expect(field).toHaveValue("\\u200f٥")`). Without that, the test passes
even if the app normalises the value before the parser ever sees it, and it is
no longer pinning the strip. Build marks from `"\uXXXX"` escapes; never type an
invisible literal into source.
