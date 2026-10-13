# #146 debate evidence (critic + defender)

- **Issue:** #146, one invoice-draft module behind the sale and purchase screens
- **Tier:** Standard (web UI). Debate was run at the lane's explicit request.
- **Base:** `origin/develop` @ `fc951133134a9b0b18b5ae38f9658665c29e73ec`
- **Evidence HEAD:** `6e0d153059a8d0197e62a67cdec2ac9a651509d2`
- **Provenance:** round 1 reviewed `6c6e9f4`; round 2 reviewed `e231b47`; both
  rounds used a critic and a defender child with no write access. The round-2
  findings were applied in `6e0d153`, which is the HEAD this file is named for.
  No reviewable file changed after `6e0d153`.

## Round 1 (reviewed `6c6e9f4`)

### Critic findings

| # | Finding | Severity |
|---|---|---|
| F1 | The quick-add **form** is still duplicated. The module took its state machine, but each page keeps the field list, labels, defaults, required flags, test ids, layout, validation and payload build. Net production LOC grew from 1120 to 1472. The issue asks the module to own "the quick-add item form". | 7 |
| F2 | "Line and invoice totals" is only half extracted: `draftTotals` was dead production code and sale recomposed `subtotal − discountAmount` by hand. Nothing shares the checkout-bar composition. | 6 |
| F3 | The hook interface mirrors the reducer action union one-for-one, and `patch(itemId, Partial<T>)` leaks the kind-specific line shape back into the pages. The deep module is the pure file; the hook adds only `subtotal`. | 6 |
| F4 | The claimed guard evidence did not exist on disk when round 1 ran. | 5 |
| F5 | `nextUnitCost` used the strict `parseWholeNumber`, so `"1e3"` and `"0x10"` became "keep previous" instead of 1000 and 16. A reachable money input changed. | 5 |
| F6 | `useQuickAdd` exposed an unused `pending` flag, and a rejected `create` could leave it stuck. | 4 |
| F7 | Interface bloat: five names for one concept (`AmountKind`, `DiscountType`, `OverrideType`, `toDiscountType`, `toOverrideType`), a public predicate for a React detail (`paymentPairUnchanged`), and four test-only op exports. | 4 |
| F8 | `openForm(seed)` silently ignored the seed when `resetOnOpen === false`. | 4 |
| F9 | The "submit refuses an unusable draft" guard was duplicated per page. | 3 |
| F10 | Both pages hand-built the `PaymentPair` literal for `resolveInitialPaid`, whose `source` field it never reads. | 3 |
| F11 | The committed design doc described an interface the code did not have. | 3 |
| F12 | One module, two money readers, only one rationalised. | 3 |
| F13 | Three unrelated hooks in a file named after one of them. | 3 |
| F14 | The payment link invariant lives in the component, not the hook that claims to own it. | 2 |
| F15 | Per-page type aliases shadow the module types. | 2 |

Critic verdict: a correct, behaviour-preserving extraction of the *rules*, but it
does not deliver the issue's "one invoice-draft module" claim. The quick-add form
and the checkout composition stay duplicated, the hook layer is a shallow
dispatcher mirror, and the design doc did not match the code.

### Defender concessions

- Seam is real and one-directional: `invoice-draft.ts` imports only contracts and
  pure libs; the reducer is exported and unit-tested without React.
- The drift fix is proven at three levels: pure table, rendered page, browser.
- `nextUnitCost` preserved the *common* cases exactly, but the defender could not
  defend the `1e3`/`0x10` delta as inside "preserve the money math exactly".
- Decision 3 ("quick-add shared") is only partly satisfied: behaviour shared,
  markup not. Defensible on depth grounds, but a strict reader will call it a
  concession.
- `String(Number(fields.qty))` round-trips a resolved integer through a draft.
- `useQuickAdd`'s `submit` depends on an `options` object recreated every render,
  so its memoization does nothing.

Defender verdict: defensible extraction, no blocker.

### Synthesis and disposition

Fixed in `e231b47`: F2, F5, F6, F7, F8, F9, F10, F11, F15, plus the round-1
test-audit and code-review findings listed in the other two evidence files.

Not fixed, with reasons:

- **F1 (quick-add markup).** Kept per-kind. The design doc section 4.1 now carries
  a field-by-field table (6 fields versus 7, different category defaulting,
  sale's scan and required-stock path, different reset policy and button rows).
  A descriptor list covering all of it would be as long as the forms it replaces,
  which is the shallow-module failure mode. This narrows the issue's decision 3
  and is raised to the parent as a `decisionRequest`.
- **F3 (hook mirrors the reducer).** Kept. The pure module is the deep one and
  the reducer is its test surface; the hook is a deliberately thin React adapter
  at the same seam. Design doc section 3.2 says so.
- **F12 (remaining `Number()` readers in `nonNegativeOr`, `saleUnitPrice`,
  `saleOverrideInvalid`, quick-add payloads).** Pre-existing sale behaviour,
  unchanged, and the brief requires the money path to be preserved. The
  round-1 attempt to tighten one reader was itself the F5 regression.
- **F13 (one hook file, three hooks).** Kept. All three hooks are the
  invoice-draft module's React side, and the quick-add's behaviour is part of
  what the issue asked this module to own.
- **F14 (link invariant in the component).** Documented in the hook docstring
  rather than re-plumbed: the input owns the edit link and the hook follows the
  reference total. Behaviour is unchanged and covered.

## Round 2 (reviewed `e231b47`)

### Critic findings

| # | Finding | Severity |
|---|---|---|
| N1 | `draftTotals`' docstring claimed both screens use it; purchase reads the hook's `subtotal`. | 2 |
| N2 | `firstUnusableQuantity` moved sale's per-line override-then-quantity check into two passes, so a cart with two invalid lines surfaces a different (still correct) message. | 2 |
| N3 | The clamp in `addDraftLine` changes a reachable sale value on purpose: a maxed line used to become `1000001`, resolve to zero and block the save. | 2 |
| N4 | The unit-cost field snaps back on an unreadable draft where the old handler left the text in the DOM. The number billed is identical. | 2 |
| N5 | Purchase's quick-add quantity now rejects spellings the old `Number` reader accepted (`"1e3"`, `"2.0"`, `"0x10"`). | 2 |

All 11 round-1 fixes verified as landed and value-correct. No blockers.

### Defender concessions

- Restoring the old `nextUnitCost` reader weakened the module's internal
  consistency but was correct for this lane.
- Removing the type aliases was name-level, not a real interface narrowing.
  Removing `pending` was the one genuine win.
- The clamp is the one change that is not a pure move, and it should have been
  left in only with an explicit note.
- **Could not defend:** pinning `nextUnitCost("9007199254740993")` as intended
  contract, which freezes a precision quirk into the test suite.

Defender verdict: fixes real, non-fixes defensible, round 2 tidied rather than
deepened.

### Synthesis and disposition

Fixed in `6e0d153`:

- N1: the `draftTotals` docstring now names sale as its caller.
- N2: `firstLineError` replaced `firstUnusableQuantity`. It walks the draft once
  and calls a per-kind `errorFor` per line, so sale keeps override-then-quantity
  precedence and the duplicated loop shape is gone. Pinned by two pure tests,
  including a two-invalid-line ordering case the round-1 test could not catch.
- N3: the clamp stays (a maxed line must not become unsaveable) and is recorded
  in the design doc as the one intentional reachable-value change, with its own
  pin in the money-math table.
- N4: left as is, documented: the number billed is identical, and the field
  snapping back is a visible improvement. Pinned by the new purchase unit-cost
  test.
- N5: accepted: the quick-add quantity is a line quantity, so the shared parser
  is the right rule. Recorded in the design doc.
- Defender's concession: the precision-quirk assertion is now labelled as an
  inherited quirk with a recorded follow-up, not an intended contract.

Remaining, deferred with a written reason (design doc section 8):

- the amount-source payment plus a discount-zeroed total (pre-existing, and it
  needs a product decision about operator intent);
- purchase's line inputs not being disabled while a save is in flight
  (pre-existing parity gap);
- `Number()` in `nonNegativeOr`, `saleUnitPrice`, `saleOverrideInvalid` and the
  quick-add payloads (pre-existing, preserved on purpose);
- em dashes in the module comments (repo house style; the design doc was
  rewritten with far fewer);
- test-hygiene duplication in `purchase.test.tsx` (a separate cleanup).

## Verdict

No blocker at `6e0d153`. The extraction removes real duplication (one quantity
parser, one line-list rule set, one totals path, one initial-payment rule), the
drift fix is proven at unit, rendered and browser level, and the one narrow
reading of the issue (quick-add markup) is disclosed and escalated as a
decision rather than taken silently.
