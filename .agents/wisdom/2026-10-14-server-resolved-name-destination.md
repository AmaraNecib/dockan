# Expose a resolver; never mirror a tie-break in the client

**Date:** 2026-10-14 · **Ticket:** 184 · **Area:** apps/api/src/rpc/opening-balance-resolver.ts, apps/api/src/rpc/router.ts, apps/web/src/pages/supplier-opening-balance.tsx

Follow-up to #177/#180. The server became the only *writer* resolver of a typed
supplier name, but the confirmation dialog still mirrored the fold tie-break
(entry-carrying party, then lowest id) to name the destination. Two copies of one
rule. The lessons:

0. **If two sides must name the same thing, expose one resolver over the wire.**
   The dialog names the account the server will write to, so make the server
   answer a read-only `suppliersResolveName` query and render *that*. Delete the
   client copy outright — do not keep it as a fallback. The rule lives once, in
   `pickOpeningSupplier` / `resolveOpeningDestination`, called by the guarded
   write and the read query.

1. **Include the whole row signature in the resolve input.** The destination is
   not a pure function of the name: the #177 signature (direction, amount,
   reason, occurredAt) decides whether a retry stays on the account already
   holding it. A name-only resolve would reintroduce the divergence for retries.
   Inject the signature probe (`hasSupplierAdjustment`) so the same pure function
   serves the transaction and the read.

2. **Close the read→write gap by sending the resolved id back as a consistency
   check.** A pre-write resolve is a snapshot: the owner can edit the draft while
   the dialog is open, a row can be filled onto the named account, or a folded
   twin can gain entries between the resolve and the write. Send
   `expectedSupplierId` (the named id, or `null` for "new"); the server keeps its
   resolution authoritative but refuses `OPENING_BALANCE_TARGET_CHANGED` when the
   live answer differs. The client then re-resolves and re-opens the dialog. The
   server gate (`OPENING_BALANCE_EXISTS`) only covers the entry-count case; it
   does **not** cover a confirmed row whose account moved.

3. **Re-run the conflict guard at confirm time, not just at submit.** A reactive
   `blockedReason` that includes the server-resolved id re-blocks the dialog when
   a picked row is edited onto the named account while the dialog is open.
   Without it, two rows (different amounts, same account) pass the server's
   `supplierId:direction:amount` in-batch duplicate check and double-post.

4. **Clear the resolved-destination snapshot when the dialog closes.** A stale
   snapshot left in state blocks a later, unrelated save with a false
   "already has an amount" conflict. Bind the snapshot's lifetime to the dialog.

5. **The structural "one implementation" test is a guard, not a proof.** A regex
   over the identifier spelling (`entries > bestEntries`) is evaded by a rename or
   `Math.max`. Broaden it, but rely on the shared function plus a test that
   asserts the same account on both sides.
