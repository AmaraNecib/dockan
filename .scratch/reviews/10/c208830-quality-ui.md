# Quality Check — Ticket #10 UI @ c208830 (Greptile round-3 refresh)

- Prior UI quality evidence: `0b7d644-quality-ui.md` (PASS). This file
  covers the round-3 delta: `InvoiceHeader` gained loading/error/retry states
  (+ its happy-dom test).

## Design

The invoice-header change follows the same design language as before but adds
the three-state discipline the repo uses elsewhere (activity.tsx error+retry,
settings page skeleton/error states):

- **Pending** — a muted `Skeleton` bar (`animate-pulse bg-muted`) sized to
  the name line: the header region retains its height, so the card does not
  jump when identity arrives.
- **Failure** — `role="alert"` with `t("activityError")` and a retry link
  (`itemsSearchRetry`), identical vocabulary to the activity/settings pages:
  the same wording a user saw anywhere else means the same thing here.
- **Success** — bold store name + `dir="ltr"` canonical phone, unchanged.

Never a silent blank: each state renders something meaningful inside the
`invoice-header` region, and the region keeps its `data-testid` in every
state (stable hook for screenshots/E2E).

## Web Interface Guidelines / a11y

- Error state is announced (`role="alert"`), not color-only.
- Retry is a native `<button>` — keyboard operable, focusable.
- The loading placeholder is decorative (`aria-hidden` not needed for a bare
  div; it carries no semantics and is not focusable).
- RTL/bidi: unchanged — the phone keeps its isolated `dir="ltr"` span.
- No new colors beyond the existing `text-red-700` error treatment used by
  every page's error text (contrast already acceptable app-wide).

## Component/React practices

- `InvoiceHeader` stays a single-purpose presentational component; the
  state branching is one flat `isPending / isError / else` — no prop
  proliferation, no context.
- Retry mutates nothing; `settings.refetch()` is query-native.
- Test isolates states with a mode-driven mock of the RPC seam and
  `retry:false` (no react-query retry storm in tests) — matches the repo's
  established happy-dom pattern (item-picker-dialog.test.tsx).

No findings requiring changes. **VERDICT: PASS.**