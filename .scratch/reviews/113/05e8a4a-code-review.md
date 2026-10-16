# Issue #113 — code review evidence (Standards + Spec)

Base `850d1f7`. Independently reviewed HEAD `05e8a4a`. The final commit adds only
a corrected test comment (`i18n.test.ts`, comment-only) and the evidence files;
the review below is the state the two axis sub-agents saw.

Commit list: `6fd2f47` (cherry-picked from the abandoned `fix-113-auth-errors`),
`24a8e98`, `24a6c4f`, `05e8a4a`.

## Standards axis

**Hard violations: none.** Checked against `docs/engineering-workflow.md` and
`AGENTS.md`:

- tier + one-line justification recorded in `.scratch/implementation/113-design.md`;
- evidence filenames carry the reviewed SHA (`05e8a4a-*`);
- source-only staging (no `git add -A`); only source/test/`.scratch` files in the
  diff; `.dokan-port` restored after e2e runs;
- `bun run test` is unconditional in the CI `checks` job, so the web parity scan
  runs on an api-only PR — the cross-app dependency is not skipped by turbo's
  affected graph.

**Judgement calls (recorded, not fixed):**

1. **Duplicated Code** — `i18n.test.ts` repeats the translate-and-check body
   across the vault, opening-balance and router describes (`not.toBe(code)`,
   non-empty, Arabic range). The router *scan* is new; the assertion trio is a
   third copy. A shared `expectTranslatable(code)` helper would collapse all
   three. Optional cleanup.
2. **Cross-workspace source scan** — the web test reads
   `apps/api/src/rpc/router.ts` (and `stock-ledger.ts`). Precedent in the repo is
   web-internal (`cell-ltr.test.ts`, `a11y-contrast.test.ts`); this is the first
   to reach into `apps/api`. Documented in the design doc, guarded by a `> 40`
   non-empty check and the named forwarded codes, so a move fails loudly.
3. **Mysterious Name** — `authFieldKey` returns a `MessageKey`, not a field,
   while `authErrorField` returns the field. Moved verbatim; a rename is out of
   scope.
4. **Note** — the `message:` scan would false-positive on a future non-refusal
   `message: "literal"` in the router. Verified every current `message:` in
   `router.ts` is a refusal code or the refusal map.

**`SERVER_ERROR_KEY` is byte-identical to base `850d1f7`** (issue #113: the regex
change is optional and must not be made speculatively). The only `i18n.ts` change
is the `PREFERENCE_NOT_WRITABLE` resource entry, required by the parity test.

## Spec axis — **PASS**

| Item | Verdict | Evidence |
|------|---------|----------|
| 1. One announcement path | Fixed | `auth-errors.tsx` sets `role={field === null ? "alert" : undefined}`; field-blamed pins assert `role` null and zero live regions, field-less pins assert `role === "alert"` and exactly one, plus a transition test. Mutation returns 8 failures. |
| 2. Pure move | Fixed, proved | Five helpers + `authTarget` + `AuthErrorField` moved to `lib/auth-errors.tsx`; `setupNameKey`/`PHONE_MAX_LENGTH` stay. Proof: pre-#113 tests untouched pass 34/34 against the move-only edit, plus byte-identity of the moved bodies. |
| 3. Router parity test | Fixed | Source scan over `router.ts` literals and the two forwarded unions; `SERVER_ERROR_KEY` unchanged; `PREFERENCE_NOT_WRITABLE` copy added. Mutations fail for non-conforming, missing-resource and named-type cases. |
| 4. Login e2e decoupled from the limiter | Fixed | Allowed copy set `{credentials, too-many-attempts}` (account isolation rejected: it needs a second owner and still shares the limiter window); limiter config untouched. |

No requirement missing or partial; no scope creep beyond the
`PREFERENCE_NOT_WRITABLE` resource the parity test requires; no requirement
implemented wrongly. One mapper only (`serverErrorKey`/`tError` in `i18n.ts`);
`auth-errors.tsx` adds no normalisation.

**Rounds:** the axis reviews ran on `24a8e98` (Standards: no hard violations;
Spec: PASS with a pure-move-proof note) and a confirmation on `05e8a4a` (no new
hard violation, PASS, prior findings closed).
