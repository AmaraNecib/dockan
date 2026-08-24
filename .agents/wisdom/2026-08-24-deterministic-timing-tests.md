# Deterministic browser tests for timing-based logic: inject the constant, count the wire

**Date:** 2026-08-24 · **Ticket:** 28 · **Area:** apps/web/src/lib/use-barcode-scanner.ts, ticket28.spec.ts

The wedge-scanner hook originally used pure keystroke-gap timing (35→50 ms) to
distinguish scans from typing. Under CI load gaps spiked past the threshold and
scans silently vanished — passed locally, failed in suites. Three fixes that
generalize:

1. **Make the regime structural, not timed.** When focus is outside any editable
   element, every printable key IS scanner output — commit regardless of gap.
   Timing now only arbitrates inside editable fields, where ambiguity actually exists.
2. **Inject time constants via env** (`VITE_SCAN_DUPLICATE_WINDOW_MS`) so e2e can
   widen/narrow windows deterministically instead of sleeping past production values.
3. **Count RPC calls instead of asserting UI absence.** oRPC multiplexes all
   procedures through `/api/rpc` with the procedure name in the URL PATH
   (`/api/rpc/catalogSearch`), NOT the POST body. `page.on("request")` + relative
   counts (snapshot before, assert unchanged after) prove "nothing was sent"
   without wall-clock races.

Corollary: never assert exact global call counts — unrelated refetches make them
drift. Snapshot-and-compare around the action under test.
