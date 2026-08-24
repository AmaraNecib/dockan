# Ticket 10. Settings screen (store identity): design

- **branch:** `feat/10-settings-screen`
- **base SHA:** `c1bec84` (merge-base with origin/develop; == HEAD at design time)
- **review tier:** Standard
- **issue:** github #10 — owner edits store name + phone; they appear on the
  invoice header; values survive restarts; screen in Arabic (RTL).

## Scope decisions up front

- The settings store seam ALREADY exists (ticket 02/03-era): `storage` table,
  `StorePort.getSettings()/updateSettings()`, seeded defaults
  (`storeName="Dokan"`, `storePhone=""`). No store or schema changes.
- The RPC procedures `settingsGet`/`settingsUpdate` exist in the contract but
  are `notImplemented` stubs in the router — this ticket wires them.
- Phone normalization reuses the shared Algerian helper
  (`normalizeAlgerianPhone`) exactly like auth's reset flow: valid input is
  stored in canonical `+213XXXXXXXXX` form; invalid input is rejected with the
  stable `INVALID_PHONE_NUMBER` key (already translated). An empty string
  means "clear the phone" and is sent as `null`, matching `settingsSchema`.
- Invoice header: the web app has ONE invoice display today — the saved
  invoice card after a purchase is created (ticket 29, `purchase.tsx`). Sale
  checkout is ticket #30's PR, so the additive change is a small reusable
  `InvoiceHeader` component rendered in that card. No unrelated refactors.
- Settings changes are audit-visible: new `SETTINGS_UPDATED` activity type
  appended to the existing tuple (append-only), with an Arabic label.
- Persistence across restarts is inherent: settings live in the SQLite
  `settings` table; the E2E proves it by reloading the page after saving.

## Public interfaces

### contracts (`packages/contracts/src/core.ts`)

```ts
// append "SETTINGS_UPDATED" to the activityTypes tuple (already exported)
export const activityTypes = [ ..., "SETTINGS_UPDATED"] as const;
```

`settingsSchema` / `settingsUpdateInputSchema` already exist and stay
unchanged (shape validation only — semantic phone normalization lives at the
router boundary, same pattern as `requireBarcode`).

### rpc router (`apps/api/src/rpc/router.ts`)

```ts
settingsGet: os.settingsGet.handler(guarded(async () => deps.store.getSettings())),
settingsUpdate: os.settingsUpdate.handler(guardedInput(async (input) => {
  const storePhone = input.storePhone === undefined ? undefined
    : input.storePhone === null ? null
    : requireStorePhone(input.storePhone);
  const updated = await deps.store.updateSettings({
    storeName: input.storeName,
    storePhone,
  });
  await deps.store.insertActivity({ type: "SETTINGS_UPDATED", summary: "تحديث إعدادات المتجر" });
  return updated;
})),
```

`requireStorePhone(raw)` = `normalizeAlgerianPhone(raw)`, throwing
`ORPCError("BAD_REQUEST", { message: "INVALID_PHONE_NUMBER" })` on null.
Empty string also normalizes to null → rejected (the UI sends `null` to
clear). Session guard identical to every other business procedure.

### web (`apps/web/src`)

- `pages/settings.tsx` — Arabic RTL form: store name input + phone input
  (`dir="ltr"` for the digits) + save. On success invalidates the
  `settingsGet` query (so the invoice header catches up). Mirrors
  categories/purchases styling (plain bordered inputs, stone-900 button).
- `components/invoice-header.tsx` — `useQuery(orpc.settingsGet.queryOptions())`;
  renders `storeName` bold + `storePhone` (only when set) in an RTL header
  block with `data-testid="invoice-header"`.
- `pages/purchase.tsx` — render `<InvoiceHeader />` at the top of the saved
  invoice card (`savedInvoice` block). Only additive: no flow changes.
- `router.tsx` — add `/settings` route + nav link `الإعدادات`.
- `lib/i18n.ts` — new keys: `navSettings`, `settingsTitle`,
  `settingsStoreName`, `settingsStorePhone`, `settingsSave`,
  `settingsSaved`, `settingsPhoneHint`, `activityType_SETTINGS_UPDATED`.

## Dependencies

- No new packages. react-query, react-i18next, shared contracts — all in.
- `activityTypes` tuple change flows into `activityTypeSchema` +
  drizzle enum automatically (no DB column change: `activities.type` is TEXT).

## Tests

Unit / router — `apps/api/src/rpc/router.test.ts`:

- `settingsGet` rejects unauthed with UNAUTHORIZED; returns seeded defaults
  (`storeName "Dokan"`, `storePhone null`).
- `settingsUpdate` normalizes a loose Algerian input to canonical `+213…`
  form, persists (round-trip through `settingsGet`), and records a
  `SETTINGS_UPDATED` activity entry.
- explicit `null` clears the phone (round-trip → `storePhone null`).
- invalid phone (`"2660123123"`, `"abc"`) → rejects with `INVALID_PHONE_NUMBER`
  and leaves stored settings untouched.

E2E — `tests/e2e/ticket10.spec.ts` (login-first shared-db pattern):

- edit store name + phone on `/settings`, save → success message.
- reload the page → the form still shows the saved values (restart
  persistence).
- create a purchase (the only invoicing path today) → the saved invoice card
  shows the edited store name + normalized phone in the header.

## Implementation risks

- The `settingsGet` react-query cache can go stale after update — mitigated by
  invalidating `settingsGet` in the mutation's `onSuccess`.
- Invoice header rendering depends on the purchase flow that another PR owns;
  scope is limited to the card in `purchase.tsx` and `InvoiceHeader` is
  reusable later by the sale view.
- Phone strictness: only Algerian mobiles normalize; a landline store number
  would be rejected with a clear, already-translated error. Consistent with
  auth; documented here as intended behavior.