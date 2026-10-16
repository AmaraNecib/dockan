# Editing a shared test fixture erases the pin that relied on it (🟠 Major)

**Date:** 2026-10-16 · **Ticket:** 229 · **Area:** apps/web/src/components/parties/supplier-return-panel.test.tsx

Greptile's 4/5 round on the #210 Arabic-Indic PR found two pins in one test file
that passed against the code they claimed to guard.

**1. A shared fixture is shared by every older pin.** The #210 preview checks
needed a non-zero line total, so the single `invoicesGet` fixture was changed to
`unitPrice: 400`. That silently deleted the zero-value case from the older
"enables submit for a valid quantity on a free line (zero return value)" test:
with a priced line the preview is 2000, so a change that wrongly disabled
zero-value returns would no longer fail. The new pin was bought with an old pin.

**2. A preview-then-submit pin that rewrites the draft is two drafts.** The
Arabic test typed `٥`, asserted the preview was 2000, then typed ASCII `5`
before submitting. It previewed an Arabic draft and saved an ASCII one, so it
would still pass if the save path stopped reading Arabic digits entirely.

The fix keeps **two** fixture lines: `l1` at `unitPrice: 0` for the zero-value
pin (which now also submits and asserts the saved return), and a priced `l2` for
every preview pin. The Arabic test submits the same `٥` it previewed.

**Always**: when a new test needs different fixture data, add a second fixture
(or a second record) instead of mutating the shared one — then grep the older
tests that depended on it. When a pin covers a preview and a save, submit the
exact draft the preview asserted; a value change in between makes it a test of
two different inputs. Prove the pin by running **both** shapes against the
mutation: the new pin must fail, and the pre-fix shape must pass (that pass is
the false negative being fixed). A green suite is not evidence a pin has teeth.
