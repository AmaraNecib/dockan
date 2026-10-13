# #179 — Playwright suite flakiness under CI load (design)

- **Tier:** Standard (test-only)
- **Base:** `origin/develop` @ `8bf2a817a2d25a58653704f1c4c15542bd822cc2`
- **Branch:** `fix-179-e2e-flake`
- **Scope guard:** flaky specs + shared test helpers only. No suite restructuring,
  no app behaviour change unless a real app race is proven.

## Observed failures

| Spec | Line | Symptom |
|------|------|---------|
| `tests/e2e/receipts.spec.ts` | 56 | `expect(sale-saved-number).toContainText("INV-")` times out at the default 5 s after Save. Seen twice on PR #173 and on the #163 develop push (`gh run 38395248682`, job `115288689280`). |
| `tests/e2e/arabic-search.spec.ts` | 64 | `fill("الب")` — results show the previous query briefly, then clear to «لا توجد نتائج مطابقة». Seen on PR #178. |

## Root cause

Both specs write through the app and then assert on UI that depends on the write,
inside Playwright's default **5 s** `expect` poll window. Under CI load (2-core
runner: API + Vite + Chromium) the oRPC write round-trip can exceed 5 s, so the
poll fails even though the write lands.

### receipts (proven by CI log)

`gh run 38395248682` / e2e job shows exactly:

```
Locator: getByTestId('sale-saved-number')
Expected substring: "INV-"
Timeout: 5000ms
Error: element(s) not found
> 56 | await expect(page.getByTestId("sale-saved-number")).toContainText("INV-");
```

The preceding writes are already acknowledged (`sale-total` shows the quick-added
line), so the only unacknowledged write is `invoicesCreate` itself. There is no
app race here: `createInvoice.onSuccess` sets `savedSale` from the server's
authoritative invoice. The test simply polls a 5 s window for a server round-trip.

### arabic-search

The spec seeds six items and three parties and **never waits for any of those
writes**, then searches. If a create is still in flight, `catalogSearch` correctly
returns zero matches for «الب», the `<ul>` renders the «لا توجد نتائج مطابقة» empty
state, and the item only appears when the late mutation's `invalidateQueries()`
refetch lands. That is the reported "populated (previous query) → cleared (empty)
→ repopulated" flicker. Under load the repopulating refetch spreads past the 5 s
poll and the spec fails.

**Verdict: no app race.** `CatalogSearch` debounces correctly and TanStack Query
isolates per-key data; the empty state is the correct render for a query whose
matching row is not committed yet. The defect is the spec racing its own
unacknowledged writes.

Secondary (latent) cross-spec coupling: the spec asserts on the **aggregate**
`search-results` list of a catalog shared with 52 other spec files. The catalog
search is capped at `DEFAULT_CATALOG_LIMIT = 20`, so accumulated data could in
principle push the spec's stamped row out of the window.

## Interface

New shared helper `tests/e2e/rpc-helpers.ts`:

```ts
/** Resolve on the POST response for `/api/rpc/<procedure>`. Set up BEFORE the click. */
export function waitForRpc(page: Page, procedure: string): Promise<Response>;

/** Await the response, fail loudly when the server refuses it. */
export async function expectRpcOk(response: Promise<Response>, procedure: string): Promise<Response>;

/** Set up the ack, run the action, assert the write was accepted (oRPC envelope `{ json }`). */
export async function actAndAck(page: Page, procedure: string, action: () => Promise<void>): Promise<Response>;
```

`actAndAck` makes the "arm the wait before firing the action" ordering impossible
to get wrong.

## Planned changes

1. **`tests/e2e/receipts.spec.ts`** — replace the 5 s UI poll after Save with
   `actAndAck(page, "invoicesCreate", ...)`, take `invoiceNumber` from the parsed
   `{ json }` response, assert it matches `INV-<digits>`, then assert the card
   shows that server-issued number.
2. **`tests/e2e/arabic-search.spec.ts`** — wrap every `itemsCreate` /
   `customersCreate` save in `actAndAck` so the search queries always run against
   committed data. Scope each search assertion to the spec's own result row
   (the `<li>`/row for the stamped name) rather than the aggregate list, so
   another spec's data can never satisfy or break it.

No timeout increases, no app change, no `workers`/config change.

## Planned tests

- The specs are the tests. Verification is repetition: affected specs
  `--repeat-each`, ≥3 clean full-suite runs at the shipped `workers: 1`, and a
  contended run at `--workers=2`, all green, logs under
  `.scratch/reviews/179/<sha>-*`.

## Risks

- `waitForResponse` needs the exact procedure path; verified at runtime
  (`/api/rpc/itemsCreate`, envelope `{ json: ... }`).
- Removing the UI poll could mask a real refused write — mitigated by
  `expectRpcOk` failing on any non-2xx status with the status in the message.
- The assertion-scoping must not weaken coverage — every negative assertion
  (`unrelatedItem`, `unrelatedParty`) is preserved.
