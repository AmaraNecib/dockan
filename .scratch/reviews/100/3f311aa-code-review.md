# Code review — issue #100 (HEAD `3f311aa`)

Two-axis review of `git diff 0b4d5a1...3f311aa` (commits `dfb4faf`, `d316611`,
`f2af582`, `1617c70`, `3f311aa`). Base pinned to `0b4d5a1`.

Spec source: the issue #100 brief (lane handoff) and the design doc
`.scratch/implementation/100-design.md`.
Standards sources: `AGENTS.md`, `docs/engineering-workflow.md`,
`tools/oxlint/anti-slop/*` (lint enforces them), plus the Fowler smell baseline.
Each axis ran as its own sub-agent against this HEAD.

Gates at this HEAD: typecheck clean, lint clean, 446 api / 256 web / 34 desktop
tests pass, e2e 27/27.

## Standards

**Hard violations: none.** The one type assertion carries the required
`SAFETY:` comment; lint is the enforcement for the anti-slop rules.

Documented-standard notes:

1. **Review tier.** `docs/engineering-workflow.md` lists "auth login" under
   High-assurance (which adds the debate gate). The lane brief explicitly pins
   **Standard** and the brief overrides, so no debate was run. Recorded here so
   the deviation is visible rather than silent.
2. **Source-only policy.** The design doc and this evidence live in `.scratch/`,
   which is tracked in this repo (other `.scratch` design/review files are
   tracked too); only named source/test/evidence files were committed.

Remaining baseline smells (all judgement calls, none blocking):

| Smell | Where | Disposition |
|---|---|---|
| Duplicated Code | the `report` wiring was repeated in three forms | **Fixed** in `f2af582` via `useAuthReporter`; the per-form pre-check now shares `authFieldKey` |
| Duplicated Code | `aria-invalid` / `aria-describedby` ternaries repeat per input | **Accepted** — six explicit one-line attributes read better than a props-spreading helper; changing them would add indirection for no behaviour gain |
| Data clump | the example number lives in `phoneExample`, inside `INVALID_PHONE_NUMBER` copy, and in the e2e assertion | **Accepted** — copy is allowed to repeat an example; the e2e literal is deliberate copy-pinning |
| Duplicated rule by value | `MIN_PASSWORD_LENGTH = 4` mirrors `core.ts` `min(4)` | **Accepted, documented** — the comment names the source and the server still enforces; importing the schema just to read one bound was judged heavier than the comment |
| Dead copy | `unexpected` / `UNEXPECTED` resources are unreachable | **Accepted** — kept intentionally so the negative assertions stay meaningful |
| Speculative Generality | `SENTENCE_KEYS` regexes pin producer English | **Accepted, documented** — it is the only last-resort signal available without editing api/contracts |

## Spec

Requirements met:

- Precedence: stable `code` → `status === 429` → known server key → anchored
  sentence → `errorGeneric`. Message text is the documented last resort, with
  the reason in the code.
- Each named failure has its own Arabic key naming problem **and** recovery:
  `AUTH_INVALID_CREDENTIALS`, `INVALID_PHONE_NUMBER`, `AUTH_TOO_MANY_ATTEMPTS`,
  `AUTH_PASSWORD_TOO_SHORT`, plus `SETUP_ALREADY_DONE`.
- `UNEXPECTED` / `unexpected` are redirected, so no path renders
  `حدث خطأ غير متوقع`; other `tError` sites were audited (design doc) and keep
  resolving their existing oRPC keys, gaining the calm fallback where a key is
  genuinely missing.
- No `apps/api` or `packages/contracts` change; no validation rule changed. The
  pre-submit checks use `normalizeAlgerianPhone` and a `min(4)` mirror — the same
  accept/reject set. `minLength={4}` on the new-password inputs was replaced by
  the Arabic check (presentation), and `required` is untouched.
- All copy is in `i18n.ts`; `App.tsx` has no Arabic literals; the
  locale-neutral guard stays green (api tests pass).
- `role="alert"` + `tabIndex={-1}` with a nonce-keyed remount; focus lands on
  the phone field for a malformed phone, the password field for a short password
  or rejected credentials, and the alert summary for lockout / unknown failures.

Notes recorded, not blockers:

- `AUTH_TOO_MANY_ATTEMPTS` says "انتظر قليلاً" (wait a bit) rather than the
  design's earlier "wait a minute"; better-auth's window default is 10 s, so no
  concrete duration is promised.
- Lockout is the one named failure with no test against a live limiter; the
  limit is off outside production, so the component test injects `status: 429`.
- The audit is documentation-only for unchanged non-auth `tError` sites; they
  still render a plain `<p>`, and the announcement requirement in the brief is
  scoped to the auth errors.
- `receipt-print.tsx` / `return-print.tsx` now show the calm generic message
  instead of an empty error box when both queries error without a message.
- `SENTENCE_KEYS` password regex is not anchored to a field name (Zod emits
  none); latent only, and documented above.

Summary: Standards — 0 hard violations, 6 judgement-call notes (2 fixed).
Spec — 0 missing requirements, 0 scope creep, 5 documented notes. No blocker on
either axis.
