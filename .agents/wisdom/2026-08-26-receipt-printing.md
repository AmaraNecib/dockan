# Receipt printing — exactly-once print dialog in a SPA route

**Date:** 2026-08-26 · Area: apps/web/src/pages/receipt-print.tsx, components/receipt-view.tsx

## StrictMode double-mount silently cancels a "schedule then print" effect (🟠 Major)

A naive `useEffect(() => { setTimeout(() => window.print(), 300) }, [ready])`
**never prints in dev**: React 19 StrictMode mounts → unmounts → remounts, and
the cleanup clears the first timer, so the ref gate set in the effect body
blocks the second timer's schedule. The once-gate must live **inside** the
timer callback (`if (ref === id) return; ref = id; window.print();`), so the
second mount's timer is the one that fires.

**Always**: when an effect schedules a one-shot (print, focus, scroll), arm the
gate at fire time, not at schedule time — and key it by the route param
(`invoiceId`), not a boolean, or a same-route param change (`/print/A → /print/B`)
suppresses the second invoice's auto-print.

## Manual undo-button and auto-fire must share ONE gate (🟡 Minor)

The "طباعة الآن" toolbar button is the escape hatch for a suppressed auto
print; if it doesn't arm the same ref the timer checks, a click inside the
settle window opens a second dialog the moment the first closes. One
`printTriggered.current = invoiceId` in both paths.

## E2E can't assert OS print dialogs — assert the document that feeds them (💡 Design Principle)

`window.print()` is headless-hostile (no OS dialog in CI) but the print route's
document is exactly what the dialog captures; assert the route content
(store name, number, totals, payment rows) and document why in the spec.
The WebView2 desktop shell exercises the dialog manually.

## Print quality: pagination is part of the feature (🟡 Minor)

A print-only feature whose paper output splits a line row or the totals block
mid-cell across pages isn't done. `@media print` `break-inside: avoid` scoped
to the receipt's rows + totals block (not a global `tr` rule) closed it in
review; the reviewer found it because the acceptance line says "paper when the
owner wants it".