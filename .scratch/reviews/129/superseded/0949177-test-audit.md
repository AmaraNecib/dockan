# Test-audit evidence — issue #129 (round 2 review-fix)

**Base:** `21dbc13f13d1889646f4466e610decf5a077253b` (`origin/develop`).
**Reviewed/worktree SHA:** `0949177bf07b12d59876049203cc55f105ca1f52`.
**Round-2 commits:** `f8151fa` (eager read + `readRpc`), `42bee2c` (vault-header
mirror, honest comments, wisdom), `0949177` (envelope check, storage fallback).
**Product code unchanged since `0631081c1a30ac6e0df37b046f95064407985e9d`; the
round-2 delta is `tests/e2e` + `.agents/wisdom` only.**

Three read-only agents (edge-case hunter, coverage analyst, quality reviewer)
ran twice: once on `f8151fa` and once on `42bee2c` after the first round's fixes.
The parent then applied the second round's recommendations and verified the
result with the full gates. No open blocker; the residual items are documented
deferrals.

## The CI failure this round removes

```
1) tests/e2e/phone-identity.spec.ts:76 › phone identity: …
   Error: response.json: Protocol error (Network.getResponseBody):
          No resource with given identifier found
   Response body is not available for a response that was navigated away from.
          at rpc-helpers.ts (rpcOutput) → phone-identity.spec.ts:123 (readCustomers)
```

Round 1 armed an ack around `page.goto("/customers")` and read the body after
the action. The matched `customersList` response was issued by the document
being replaced; the document commit discarded its body. Trace timing on the
failing run showed the invalidation refetch at `22.515→22.533` and the `goto`
document at `22.534` — the body round-trip lost the ~1 ms race.

## Fix, class-level

| Layer | Change | File |
|-------|--------|------|
| Shared ack | `actAndAck` chains `.json()` onto the **armed** promise and returns the unwrapped output; `rpcOutput` (the deferred-read seam) and `expectRpcOk` are deleted. | `tests/e2e/rpc-helpers.ts:33-68` |
| Navigating read | `readCustomers` navigates first, then reads the server list with `readRpc` (`page.evaluate` fetch), which has no Playwright `Response` for a navigation to discard. | `phone-identity.spec.ts:23-37`, `customer-name-variants.spec.ts:113-127`, `rpc-helpers.ts:70-116` |
| Vault fidelity | `readRpc` mirrors the app link's `x-vault-session` header, with the product's blocked-storage fallback. | `rpc-helpers.ts:89-104` |
| Envelope | Both readers reject a body without `json` by procedure name (`hasOwnProperty`, not `typeof`). | `rpc-helpers.ts:39-42, 108-110` |

**Eager read alone is not enough — proven.** Running the eager-read build still
failed with the same Protocol error; only the navigate-first + direct read fixed
it. This is why the class fix is two shapes, not one.

## Caller walk (every `rpc-helpers` consumer)

| Call site | Procedure | Action | Navigates? | Safe |
|-----------|-----------|--------|-----------|------|
| `arabic-search.spec.ts:44` | `itemsCreate` | item save click | no | yes |
| `arabic-search.spec.ts:58` | `catalogSearch` | `search.fill` | no | yes |
| `arabic-search.spec.ts:89` | `customersCreate` | form save click | no | yes |
| `customer-name-variants.spec.ts:35` | `customersDelete` | confirm click | no | yes |
| `customer-name-variants.spec.ts:61` | `customersCreate` | form save click | no | yes |
| `customer-name-variants.spec.ts:79` | `customersCreate` | picker save click | no | yes |
| `customer-name-variants.spec.ts` readCustomers | `customersList` | **goto** | **yes** | **converted to `readRpc`** |
| `phone-identity.spec.ts:46` | `customersDelete` | confirm click | no | yes |
| `phone-identity.spec.ts:123` | `customersCreate` | form save click | no | yes |
| `phone-identity.spec.ts:150` | `customersCreate` | picker save click | no | yes |
| `phone-identity.spec.ts` readCustomers | `customersList` | **goto** | **yes** | **converted to `readRpc`** |
| `receipts.spec.ts:59` | `itemsCreateWithStock` | quick-add save click | no | yes |
| `receipts.spec.ts:81` | `invoicesCreate` | sale save click | no | yes |

The only two actions that navigate are the two `readCustomers` helpers, both
fixed. No remaining path reads a response body after a navigation.

## Edge-case hunter — findings and disposition

| # | Risk | Finding | Disposition |
|---|------|---------|-------------|
| E1 | orange (latent) | `readRpc` dropped the app client's `x-vault-session` header; a future vault-mode spec would 401. | **Fixed** at `42bee2c` (mirror the header) + `0949177` (blocked-storage fallback). |
| E2 | yellow | `readRpc` hardcodes `body: "{}"`; only correct for no-input procedures. | **Accepted + documented.** `customersList` is output-only (`app-contract.ts:122`), the docstring says no-input. A future input-taking caller fails loudly with `HTTP 4xx`. |
| E3 | yellow | Eager `.json()` now runs for ack-only callers. | **Accepted.** All `actAndAck` procedures have non-void outputs (`app-contract.ts:110-158`); a malformed 200 now fails by procedure name via the envelope check. |
| E4 | orange (latent) | `actAndAck` cannot detect a navigating action; the class can return with a future caller. | **Accepted + documented.** The docstring says `action` must not navigate; the wisdom entry marks it a review rule the helper cannot enforce. A type-level guard would false-positive on SPA route changes. |
| E5 | yellow | `waitForRpc` matches method+path only and could match `readRpc`'s own fetch. | **Accepted.** No caller arms `customersList` while `readRpc` runs; the two are never mixed. |
| E6 | yellow | `waitForRpc` exported but unused externally. | **Accepted.** Kept as the documented low-level seam; no caller misuses it. |
| E7 | yellow | `catalogSearch` ack may match one of several requests from one `fill`. | **Accepted, pre-existing.** The `fill`→ack coupling is unchanged by round 2 and is the established #179 pattern. |
| E8 | yellow | `afterEach` `page.goto` can itself time out on a failed test. | **Accepted.** Pre-existing cleanup shape; the failure it would mask is rarer than the leak it prevents. |
| E9 | yellow | `readRpc` error drops the oRPC error code. | **Accepted.** The helper throws the procedure + HTTP status, which is enough attribution for a test read. |

## Coverage analyst — acceptance table (brief vs final SHA)

| # | Requirement | Verdict | Evidence |
|---|-------------|---------|----------|
| 1 | Eager body read in the helper, every caller | **MET** | `rpc-helpers.ts:33-45`; `actAndAck` routes all 12 callers. |
| 2 | Remove the class, not the call site | **MET** | `rpcOutput`/`expectRpcOk` deleted; zero references repo-wide. |
| 3 | Do not arm an ack around a navigation | **MET** | both `readCustomers` goto-then-`readRpc`; no `goto` inside any `actAndAck` action. |
| 4 | Walk callers; fix or report safe | **MET** | table above; fixed the two navigating reads. |
| 5 | Prove real suite order + full e2e, isolated ports | **MET** | `phone-identity` passed at suite position 44; full 58 passed. |
| 6 | Regenerate evidence at the new SHA | **MET** | this file set at `0949177`. |
| 7 | No push | **MET** | branch is ahead of origin by 3 commits, unpushed. |

Missing coverage (all non-blocking, recorded):
- `readRpc`'s non-2xx and malformed-envelope throws are exercised only
  indirectly. The envelope guard is new at `0949177`; a focused helper test is a
  worthwhile follow-up (noted in the wisdom entry).
- The vault-header branch is not exercised by any spec (the shared suite runs
  with `DOKAN_VAULT=disabled`, `vault.spec.ts` has its own pair).

## Quality reviewer

Grade: **A− → A** after the `42bee2c`/`0949177` fixes. The eager read is in the
right place (armed promise, not awaited response); the two read shapes are
deliberate and documented; the envelope check and storage fallback close the two
residual fidelity gaps; the SAFETY comments now match the code. Duplicated
`readCustomers` wrappers across two specs and the `CustomerListPayload` type are
the remaining structural nit (a `parties-helpers.ts` would remove the drift).

## Assertion walk — the specs still prove server state

| Assertion | Server-backed? |
|-----------|----------------|
| `created.items.find(...).phone === +213…` | yes — raw payload, `displayAlgerianPhone` cannot mask it |
| refused name absent from a fresh read | yes — server list |
| identity unchanged after the refused edit | yes — fresh server read |
| picker record canonical phone | yes — fresh server read |
| `afterEach` final `filter(...).toEqual([])` | yes — fresh server read after the deletes |
| `arabicRow` visible, `sale-customer` value, panel count 0 | DOM, but complementary UI assertions after an awaited ack |

## Gates (commands and exit codes)

```
bun run typecheck                         exit 0 (3/3 turbo)
bun run lint                              exit 0
bun run test                              exit 0 (tier: @dokan/web 977 pass / 0 fail; 3/3 turbo)
bun run test:e2e (isolated ports)         exit 0 (58 passed, 4.9m)
  DOKAN_PORT=4451 DOKAN_WEB_PORT=5301 DOKAN_VAULT_PORT=4421 DOKAN_VAULT_WEB_PORT=5302
```

Contention note: an earlier full run of the same tree flaked on
`vault.spec.ts:196` (`expect(keyElement).toBeVisible()`, 5 s cap) with 56 passed.
`vault.spec.ts` then passed 3/3 alone, and a clean full run passed 58/58. This is
the documented vault-under-load flake (wisdom
`2026-10-15-phone-identity-boundary-validation`), not the delta.
