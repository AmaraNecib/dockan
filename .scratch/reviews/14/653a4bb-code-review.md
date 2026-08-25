# Code Review — Dokan Ticket #14 (stable DKN codes + diagnostics log)

- Diff: `git diff c1bec84...653a4bb` on `feat/14-diagnostics-log`.
- Reviewed HEAD: `4249cff` (standards + spec axes in parallel sub-agents);
  the findings below were then fixed in `653a4bb` and re-verified on the final head.
- Spec source: GitHub issue #14 + implementation notes (`.scratch/implementation/14-design.md`).
- Standards sources: `docs/engineering-workflow.md`, `docs/development-workflow.md`,
  `docs/adr/*`, base-file conventions (guarded RPC seam, `SAFETY:` comment rule,
  zod-at-boundary, i18n key style), plus the Fowler smell baseline from
  `.agents/skills/code-review/SKILL.md`.

## Standards axis

**Hard violations of documented repo standards: none.** Guarded RPC via
`guardedInput`+`requireSession`; `SAFETY:` comments on every type assertion;
zod parses the JSONL boundary; camelCase feature-prefixed i18n keys reusing
`activityError`/`itemsSearchRetry`; docs claims verified against
`apps/api/src/config.ts` and the contract; e2e reuses the login.spec testids
and the post-login URL-preserve behavior.

Smell findings (judgement calls) and dispositions:

1. **Duplicated Code / Divergent Change (medium)** — the viewer's `logRowSchema`
   duplicates the api's `LogEntry` shape (contract carries raw strings).
   **Accepted, documented**: the viewer deliberately parses raw JSONL lines so
   malformed rows render raw instead of 500ing; a shared object schema would
   lose that property. Coupling noted in the page comment and design doc.
2. **Shotgun Surgery (low)** — tail limits live apart (page 200, contract 500,
   rpc default 100). **Accepted**: coherent levels (page ≤ contract max;
   handler default between).
3. **Key remount on refetch (minor)** — `${ts}-${index}` indices shifted on every
   new line. **FIXED** — keys now derive from the raw (pre-reverse) index, so an
   appended line never remounts existing rows.
4. **Collapsed plain-`Error` vs no-error codes (minor)** — `errorKind` maps both
   undefined and plain `Error` to one key. **Accepted**: `logger.error` without an
   error payload only happens on direct call sites that pass none; the 
   `errorKind` fix additionally separates oRPC failure kinds.

## Spec axis

Against issue #14 ("every technical error gets a stable DKN-XXXXXXXX code ... a
small viewer shows today's tail") and notes (1)–(4):

1. **Stable derived codes, explicitly tested** — satisfied and strengthened:
   `errorCodeFor(event, errorKind)` where `errorKind` includes `ORPCError.code`,
   so RPC `UNAUTHORIZED` vs `INTERNAL_SERVER_ERROR` (previously one code) now
   differ while staying deterministic. Unit, seam, web, and e2e layers pin it.
2. **Per-day Algeria-local JSONL with stack** — satisfied; `ts` corruption at
   minute `:24` (found by the test-audit) fixed; non-Error rejections are wrapped
   in the `onError` interceptor so "every technical error" writes a row+stack.
3. **Admin-guarded bounded viewer in nav** — satisfied (`UNAUTHORIZED` seam test,
   nav e2e, 1..500 clamp + real 500-truncation test).
4. **Documented log location** — satisfied; §5 now also documents the
   one-literal⇒one-code rule, the `errorKind` derivation, and retention.

Residuals accepted (documented, non-blocking):

- `main.ts` reuses the `SERVER_ERROR` literal at three genuinely different sites
  (backup failure / port-record publish / bind) — they share one code when the
  class matches. The docs now state the rule: give distinct literals to sites the
  log must tell apart. Touching boot literals was out of this ticket's scope.
- The interceptor passes no `context` (url/version) on RPC_ERROR rows — the
  handler has no context values readily; lit as a future improvement.
- Viewer shows the absolute log path — deliberate (admin-only; matches the
  backups page convention of showing paths).

**Verdict:** no blockers on either axis after the `653a4bb` fixes; both axes'
medium findings were addressed, low findings documented.