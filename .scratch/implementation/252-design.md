# #252 — the two supplier-direction labels are swapped

Base: `origin/develop` @ `d84356633235d6fef925cee3ac0782d426a9d666` (merge-base = HEAD).
Branch: `fix-252-direction-labels`.

## Review tier

**Standard**, per the brief's explicit tier line. One-line justification: the diff
moves two display strings between enum values and adds the missing value→label map
to three `Select` roots; it cannot change a stored sign — the sign path
(`apps/api/src/lib/supplier-ledger.ts`) is untouched, and the acceptance test pins
label→value→submit so a re-swap reddens.

Tension, recorded rather than hidden: `docs/engineering-workflow.md` lists "debt
direction is wrong (who owes whom)" as High-assurance failure mode 3, and the
*user-visible consequence* of this bug is exactly that. What the diff can break is
the label↔value binding, not the arithmetic. The brief names Standard, the brief is
the specification, so the lane does not escalate on its own; the parent can ask for
`debate` if it reads failure mode 3 as covering a display-only swap.

## Root cause

`apps/web/src/lib/i18n.ts:928-929` attaches the THEY_OWE Darija to the WE_OWE key
and vice versa. The hints at :930-931 are correct, so each label contradicts the
hint rendered beside it (`supplier-adjust-panel.tsx` renders label + hint on the
same button). Introduced in `8259667` (#176).

Two consequences, one root cause:

1. the picker's label sits on the other value, so a user picking by the visible
   label stores the opposite direction;
2. `supplierEntryDirectionKey` resolves THEY_OWE to that same swapped key, so the
   debts/party-detail movement rows read `تسوية: يسالنا` for a THEY_OWE row.

## Second defect, found while proving acceptance 3

`<SelectValue />` is a Base UI `Select.Value`. With no `items` prop on
`Select.Root` it renders the RAW value
(`resolveSelectedLabel(value, items, …)` → `stringifyAsLabel(value)`); the label
only appears when the root supplies the value→label map. Verified in
`@base-ui/react@1.7.0` source and already documented by
`components/ui/select.test.tsx` ("SelectValue resolves the item label from the Root
`items` prop").

Three `Select`s rendered a bare `<SelectValue />` with no `items`:

| file | what the trigger printed |
| --- | --- |
| `pages/supplier-opening-balance.tsx:697` (row direction) | `WE_OWE` |
| `pages/supplier-opening-balance.tsx:752` (new-row direction) | `WE_OWE` |
| `components/parties/supplier-adjust-panel.tsx:224` (linked invoice) | the invoice uuid |

The first two are the screenshot-02 symptom in the brief and are acceptance 3. The
third is the same defect class, found by the new guard; it is fixed here rather
than baselined (one line), and called out in the commit body as beyond the literal
acceptance.

## Interfaces

`apps/web/src/lib/supplier-entry-display.ts` gains one export:

```ts
/** The i18n key that names a direction. WE_OWE raises what the shop owes. */
export function supplierDirectionKey(
  direction: SupplierAdjustmentDirection,
): "supplierAdjustDirectionWeOwe" | "supplierAdjustDirectionTheyOwe";
```

`supplierEntryDirectionKey` now delegates to it. The three `Select` roots build
their `items` map through it, so the trigger, the option list and the movement rows
read one definition. The sign-based columns (`balance > 0 ? … : …`) are left as
they are: they choose a *direction from a signed balance*, already resolve to those
same two keys, and the brief does not ask for them to move.

## Planned tests

1. `lib/supplier-entry-display.test.ts` — pins label-to-VALUE with the Darija
   glosses in the test, and pins the two hints, so swapping the hints instead of
   the labels cannot fake a fix.
2. `pages/supplier-opening-balance.test.tsx` — both direction triggers read a
   Darija label and never `WE_OWE`/`THEY_OWE`; choosing the «نسالوه» option
   submits `THEY_OWE`.
3. `components/parties/supplier-adjust-panel.test.tsx` — the linked-invoice
   trigger reads the invoice NUMBER, not its id.
4. `lib/select-trigger-label.test.ts` — new TS-AST source guard: every `<Select>`
   in a non-test `.tsx` that renders a `<SelectValue>` must pass an `items` map.
   (AST, not regex: the `cell-ltr` experience is that `[^>]*` cannot see past a
   `>` inside a JSX attribute, and half these `Select` roots carry an inline
   arrow function.)
5. `tests/e2e/supplier-adjustment.spec.ts` — two existing assertions encode the
   swapped mapping (`:142` expects `يسالنا` on a THEY_OWE row; `:157` picks
   `يسالنا` to get a credit). Both move to `نسالوه`.

## Risks

- The e2e spec pins the swap in two places; forgetting either leaves a test that
  passes for the wrong reason.
- The guard could be seen as scope creep. It is one general rule with a named
  mutation, and its first act was to find the panel's raw-uuid trigger.
- Any other raw-value trigger outside `apps/web/src` (none found; sweep over every
  `<SelectValue` site, 24 sites) would escape the guard. Stated as the guard's
  boundary.
