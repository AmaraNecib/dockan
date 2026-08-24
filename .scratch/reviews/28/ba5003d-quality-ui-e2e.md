# Quality Review: UI + E2E (addendum) — Ticket #28 @ ba5003d

- Base review: **PASS** at `58f7665` (`58f7665-quality-ui-e2e.md`); all P1/P2 fixes there
  remain in place (spot-checked: modal hook wiring, aria attributes, deterministic duplicate
  window untouched by ba5003d)
- Delta assessed: commit `ba5003d` — UX correctness fix for scan-error handling + scanner
  buffer hygiene. Review-only run; e2e not executed here (parent verified 3/3 green).

## What the delta improves (UX correctness)

1. **Scan lookup failure no longer masquerades as "unknown barcode".**
   Before: any `catalogSearch` rejection (server down, auth expired, 500) fell through to the
   unknown-scan dialog, inviting the user to create a duplicate item whose barcode may well
   exist server-side. After: a retry notice ("تعذّر التحقق من الكود، أعد المسح" — "couldn't
   verify the code, rescan") is shown via the existing `role="status" aria-live="polite"`
   notice region, so screen readers announce it. The unknown dialog now appears exclusively
   on a confirmed miss (`exact === null`). This closes a genuine data-integrity UX hazard.

2. **Mid-burst focus change no longer concatenates stale prefixes into the next field.**
   If a human tabs/clicks to another input while a partial burst is buffered (>50 ms gap),
   the buffer drops instead of leaking half a code into the newly focused field's next burst.
   Invisible when things work; prevents garbled commits when they don't.

## Accessibility check of the new UI surface

- Notice renders through the pre-existing `data-testid="scan-found"` paragraph with
  `role="status" aria-live="polite"` (`items.tsx`) → announced. ✅
- Arabic copy present in the single-language resource file. ✅
- No new interactive elements, no focus-management implications.

## Findings (all minor / non-blocking)

1. **Minor** — the retry (failure) notice inherits the success styling of the shared notice
   paragraph (green `bg-green-50 text-green-800`). A user may misread a failed lookup as a
   positive confirmation at a glance. Cosmetic; consider a neutral/red variant if the notice
   ever carries multiple semantics.
2. **Note** — the reset condition requires both target change AND gap > `SCAN_MAX_GAP_MS`.
   A sub-50 ms target switch keeps the buffer; unreachable in practice (no human refocuses
   within 50 ms, scanners don't move focus). Acceptable as-is.
3. **Carried over** — prior minors from 58f7665 remain open (playwright.config trailing
   newline; `useModalDialog` onClose-identity effect churn). Unchanged by this commit.

## Regression sweep

Diff is additive guard logic; happy-path scan → found / miss → dialog flows byte-identical
in structure. Lint clean, typecheck 3/3, unit suite 89/89 green at this HEAD; parent-verified
e2e 3/3 green. No regressions found.

VERDICT: PASS
