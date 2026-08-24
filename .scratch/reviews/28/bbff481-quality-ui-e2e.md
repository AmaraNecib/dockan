# Ticket #28 — Quality Review: UI + E2E (bbff481)

Scope: `git diff 3bbad9c...bbff481`, files `apps/web/src/pages/items.tsx`,
`apps/web/src/components/catalog/item-picker-dialog.tsx`,
`apps/web/src/components/catalog/unknown-scan-dialog.tsx`,
`apps/web/src/lib/use-barcode-scanner.ts`, `tests/e2e/ticket28.spec.ts`,
`playwright.config.ts`. Skills applied:
`.agents/skills/web-design-guidelines/SKILL.md` (guidelines URL could not be
fetched offline; applied the checklist given in the task plus standard
web-interface-guidelines rules) and `.agents/skills/playwright-best-practices/SKILL.md`.

## Verification performed

- Read all five in-scope source files in full; cross-checked every testid and
  i18n key used by the spec against `apps/web/src/lib/i18n.ts` and components
  (all resolve — including `matchedBy*`, `scan*`, `setup-*`, `login-submit`).
- Confirmed `dir="ltr"` isolation is applied consistently to barcode text in
  CatalogSearch results, ItemList rows, ItemForm barcode input, picker dialog,
  and unknown-scan dialog.
- Ran `cd apps/api && bun test`: **86 pass / 0 fail** (197 expect calls).

## Findings

### P1

1. **unknown-scan-dialog.tsx — no Escape handling and no focus management.**
   `apps/web/src/components/catalog/unknown-scan-dialog.tsx:29-53`. The dialog
   renders `role="dialog" aria-modal="true"` but: (a) there is no keydown
   handler, so **Escape cannot dismiss it** (only the Cancel button or backdrop
   mousedown); (b) focus is never moved into the dialog, so screen-reader/AT
   context stays on the background page while `aria-modal` claims exclusivity;
   (c) no focus trap and no focus restore on close. This directly fails the
   stated acceptance check "keyboard accessibility of dialogs (Escape, focus
   management)". Fix: move focus to the first action button on mount, add a
   `keydown` listener for Escape → `onClose()`, trap Tab within the dialog,
   restore focus to the previously focused element on close. (The same pattern
   should be shared with `item-picker-dialog.tsx` — see P2-1.)

### P2

2. **item-picker-dialog.tsx — Escape works only while focus is in the search input.**
   `apps/web/src/components/catalog/item-picker-dialog.tsx:73-77`. Escape is
   handled solely on the input's `onKeyDown`; once a user Tabs to a result
   button, Escape stops closing the dialog. Also no focus trap despite
   `aria-modal="true"` (`:63`), and no focus return to the trigger
   (`open-picker`) on close. Same fix pattern as P1-1; consider extracting one
   small dialog primitive used by both.

3. **CatalogSearch input has no programmatic label.**
   `apps/web/src/pages/items.tsx:96-104`. The search field relies on
   placeholder text only (placeholder disappears on input and is a weak
   accessible name). Add `aria-label={t("itemsSearchPlaceholder")}` or a
   visually-hidden `<label>`. (ItemForm fields are correctly label-wrapped.)

4. **scan results / notices are not announced to assistive tech.**
   `apps/web/src/pages/items.tsx:52-57` (`data-testid="scan-found"`) and the
   search-results list. A POS operator using a screen reader gets no feedback
   when a wedge scan resolves. Add `role="status"` / `aria-live="polite"` to
   the notice paragraph (and ideally the results region).

5. **E2E: `waitForTimeout(900)` × 3 are timing-coupled to `SCAN_DUPLICATE_WINDOW_MS = 800` with ~100 ms slack.**
   `tests/e2e/ticket28.spec.ts:56,66,79` vs
   `apps/web/src/lib/use-barcode-scanner.ts:24`. Under CI load the elapsed time
   between commit and retype is comfortably larger, but the *lower* bound is
   what matters: if the preceding `expect()` resolves fast and the machine
   stalls, a repeat scan could land inside the 800 ms window and be silently
   dropped, failing round 2 / step 5 nondeterministically. Deterministic
   alternatives: (a) make the duplicate window injectable (prop / `VITE_`
   env override set to e.g. 50 ms under test), or (b) use a *different barcode*
   per round so correctness never depends on the window, keeping one dedicated
   duplicate-window test with an explicit shortened window.

6. **E2E: round 1 of the "duplicate protection" loop asserts nothing new, and true duplicate suppression is never tested.**
   `tests/e2e/ticket28.spec.ts:51-58`. After round 0, `scan-found` already
   contains "بطارية"; round 1's `expect(...).toContainText("بطارية")` passes
   immediately from stale state, even if round 1's keystrokes were never
   processed. Also, the header comment claims "sending it twice must not
   double-handle", but each round sends the code exactly once — the actual
   behavior under test (identical commit inside 800 ms is dropped) is never
   exercised. Fix: clear/assert the notice between rounds (e.g., assert
   `scan-found` becomes detached first), and add a real same-window double-send
   case asserting the second Enter produces no second RPC/dialog.

7. **CatalogSearch shows "no results" on network/RPC failure.**
   `apps/web/src/pages/items.tsx:117-119`. When `catalogSearch` errors,
   `search.data` is undefined, so the empty-state branch renders
   `itemsSearchEmpty` — indistinguishable from a genuine miss and hiding the
   error state (violates error-state visibility). Branch on `search.isError`
   and render a distinct retryable message.

### P3

8. **use-barcode-scanner buffers modifier chords and whitespace.**
   `apps/web/src/lib/use-barcode-scanner.ts:64`. `event.key.length === 1`
   includes Ctrl/Cmd/Alt combos (Ctrl+C etc.) and Space; Space also scrolls the
   page when focus is outside inputs, injecting `" "` into the scan buffer.
   Guard with `event.ctrlKey || event.metaKey || event.altKey` early-return.
   Low practical risk for numeric wedges, worth hardening.

9. **playwright.config.ts `workers: 1` is global.**
   `playwright.config.ts:20-22`. Serializing *all* specs because one sqlite DB
   is shared is pragmatic and honestly commented, but it caps future suite
   throughput and makes spec order semantically meaningful. Longer-term:
   per-spec `DOKAN_DATA_DIR` (the config already builds an absolute `e2eData`
   path — parameterize it per test file via `process.env`/projects) so specs
   regain parallelism. Acceptable now; noted as tech debt.

10. **`waitForTimeout(300)` after cancel before row-count compare.**
    `tests/e2e/ticket28.spec.ts:65`. Cancel creates nothing synchronously; the
    sleep only pads. Replace with asserting the dialog is hidden and then
    comparing counts directly, or better, assert `page.getByRole("row", {
    name: /UNKNOWN-999/ })` has count 0 (auto-retrying, deterministic).

### Correct (evidence-backed)

- RTL handling is right: every barcode string is wrapped in
  `<span dir="ltr" className="font-mono">` across all four surfaces
  (`items.tsx:110,124,276`; `item-picker-dialog.tsx:12-16`;
  `unknown-scan-dialog.tsx:41-44`), correct for the Arabic-first RTL layout.
- Labels are properly nested inside `<label>` elements in ItemForm (name,
  category, barcode, cost/sell/threshold, initial stock) — implicit-label
  association is correct; barcode input additionally sets `dir="ltr"`.
- Testids are stable kebab-case and unique per page; the spec uses
  `getByTestId`/`getByRole`/`getByLabel` throughout — no CSS selectors, no
  strict-mode violations found (single test, unique locators).
- Unknown-scan design is sound: nothing auto-creates; RPC failure in
  `handleScan` falls through to the explicit dialog (`items.tsx:35-46`);
  client-side barcode normalization mirrors the API contract.
- E2E environment hygiene: `wipe-e2e.mjs && reuseExistingServer: false` gives a
  clean DB per run; absolute `DOKAN_DATA_DIR` avoids cwd drift.
- `apps/api` unit coverage for the new behavior exists
  (`catalog-search.test.ts`, updated `router.test.ts`,
  `drizzle-store.test.ts`); full suite green.

## Residual risks

- The two dialogs share copy-pasted overlay/backdrop logic; fixes for P1/P2-1/2
  should land as one shared primitive to avoid divergence.
- The spec runs everything in one monolithic test; a mid-test failure forces a
  full setup replay. Splitting into ordered serial tests would improve triage.
- Web-interface-guidelines rules were applied from the task checklist and known
  rules; the upstream command.md could not be fetched offline, so exotic rules
  (touch targets, reduced-motion) were not audited.

## VERDICT: FAIL

P1-1 (unknown-scan dialog: no Escape, no focus management/trap/restore despite
`aria-modal="true"`) is an explicit acceptance criterion for this review and is
unmet; P2-5/6 leave the headline "duplicate protection" behavior effectively
untested and timing-dependent. All other work is solid; fixing P1-1, P2-1, and
P2-5/6 should flip this to PASS quickly.
