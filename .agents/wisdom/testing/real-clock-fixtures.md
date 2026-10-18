# Real-date fixtures and time-format traps: pin instants, keep fixture dates far from the clock

**Date:** 2026-08-25 · **Ticket:** 14 · **Area:** apps/api/src/lib/logger.ts + backups.test.ts, diagnostics E2E

Two classes of latent failure in apps that format local time:

1. **Fixture dates that can collide with the real clock.** `backups.test.ts`
   hardcoded `2026-08-25` while the sandbox's real Algeria-local "today" was
   also 2026-08-25; an earlier test in the same file creates the REAL today's
   backup, so the fixture test's "first copy → created:true" flipped to false.
   The same `2026-08-29`/`2026-08-30` siblings were scheduled to break within
   days. **Rule: any test fixture date must be a far-future date (repo uses
   `2035-06-0x`) — never a plausible near-today value**, and sweep the whole
   file/describe in one pass, not just the failing test.
2. **Value-format compensation hacks must be anchored.** `localDateTime`
   normalized midnight's occasional "24:" hour with a bare
   `replace("24:", "00:")` — which also rewrote every real `:24` minute
   (`12:24:05` → `12:00:05`). Format-regex tests (`/^\d{4}-.../`) can never
   catch a wrong-but-valid value. **Rule: anchor replacements to their field
   position (`", 24:"`), and pin FIXED instants (a UTC instant whose Algeria
   local time is `12:24:05`, one straddling the day boundary) so formatting
   regressions fail loudly.**

Corollaries: deterministic codes should be derived from stable identity (site +
failure kind), not randomness — deriving `sha256(event::kind)` makes codes
useful cross-run identifiers; and when an oRPC error class collapses many
failure kinds (`ORPCError` for UNAUTHORIZED and crashes alike), fold the
framework's kind code into the key.