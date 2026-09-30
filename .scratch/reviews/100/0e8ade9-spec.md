# Spec axis review — PR #107 / issue #100

HEAD 0e8ade9, merge-base 0b4d5a1. Verified against the issue body, the lane brief, `100-design.md`, and the diff (`git diff 0b4d5a1...0e8ade9`).

## (a) Missing / partial

1. **"Locked-out account" is not mapped as its own message.** Issue #100: *"Invalid credentials, a malformed phone number, **a locked-out account** and a too-short password each deserve their own Arabic message."* The design collapses this to the rate limiter: *"| too many attempts in the window | HTTP 429, `{ message: "Too many requests…" }`, **no code** | temporary lockout |"* — implemented as `AUTH_TOO_MANY_ATTEMPTS` in `apps/web/src/lib/i18n.ts` (`@@ -487,10 +501,90 @@`). The api's real lockout refusal (`apps/api/src/rpc/router.ts:214`: `deps.logger.warn("SETUP_LOCKED", "firstTimeSetup refused while lockout is active …")`) has no key; if it does not throw `RESET_LOCKED`, setup lockout lands on `errorGeneric`. Not verifiable from the diff alone — flagging as partial.
2. **"Prevent the bad input" is submit-time, not input-time.** Issue #100 item 4: *"a phone field that accepts twelve digits and then fails is a worse experience than one that stops at the right length."* `App.tsx` (`@@ +1,112` hunk) adds `authFieldKey()` which runs only inside `submit`, plus `placeholder={t("phoneExample")}`; the design concedes: *"**No `maxLength`.** Deliberate, argued above; the reviewer may disagree."* The owner still types 12 digits and only learns after submitting — the stated improvement is copy, not prevention.
3. **Call-site audit is documentation only.** Issue item 3 asks to audit the other `tError` sites; `backups.tsx`, `categories.tsx`, `debts.tsx` are unchanged. The design asserts *"They keep working unchanged"* — acceptable, but the claim is unverified by any test or diff.

## (b) Scope creep

- **Setup→login handoff changes flow.** `App.tsx` adds `loginNotice`/`SetupPage onDone(notice?: MessageKey)` and moves the owner to the login form on `SETUP_ALREADY_DONE` — beyond "map the message". Brief out-of-scope: *"No changes to the auth flow's behaviour."*
- Minor, benign: added `name` attributes, `data-testid="forgot-password"`, `dir="ltr"` on login password — no spec basis, no behavioural impact.

## (c) Implemented but wrong / risky

- **`SERVER_ERROR_KEY = /^[A-Z][A-Z0-9_]*$/`** (`i18n.ts`) means a server key that is not SCREAMING_SNAKE is flattened to `errorGeneric` even when a translation exists — the opposite of the design's rule 3: *"**`message` that is a known resource key** → that key"*. No such key found in the diff, so Note, not Blocker.
- **Doc/copy drift:** design copy table says *"محاولات كثيرة خلال وقت قصير. انتظر **دقيقة** ثم أعد المحاولة."*; shipped `i18n.ts` and `pr-100.md` say *"انتظر **قليلاً**"*. Behaviour fine; the design doc is now wrong.
- **Empty-field path still uses the browser bubble** (`required` kept, `minLength` dropped); `pr-100.md` admits it as follow-up: *"The auth forms keep `required`, so a fully empty field shows the browser's own bubble."* Issue item 2 ("must not look like a crash") is not fully met for that path.

Not verified (budget): the `tests/e2e/login.spec.ts` diff, so I make no claim on the E2E acceptance.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Findings written to .scratch/reviews/100/spec.md with spec quotes and diff hunk anchors; residual risks listed below."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "git log/diff 0b4d5a1...0e8ade9 (worktrees/auth-errors)",
      "result": "passed",
      "summary": "9 commits, 11 files, +1133/-44"
    },
    {
      "command": "gh issue view 100 --repo AmaraNecib/dockan",
      "result": "passed",
      "summary": "issue body matched against implementation"
    }
  ],
  "validationOutput": [
    "Spec-axis findings: 3 partial/missing, 2 scope creep, 3 wrong/risky; no blockers found."
  ],
  "residualRisks": [
    "Setup lockout (apps/api/src/rpc/router.ts:214) may fall through to errorGeneric; not verified from the diff.",
    "tests/e2e/login.spec.ts diff not inspected, so the E2E acceptance criterion is unverified by this axis.",
    "SERVER_ERROR_KEY regex silently drops non-SCREAMING_SNAKE server keys that do have translations."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed by this review (read-only).",
  "reviewFindings": [
    "partial: issue #100 item 1 - locked-out account mapped only as 429 AUTH_TOO_MANY_ATTEMPTS; api lockout at apps/api/src/rpc/router.ts:214 unmapped",
    "partial: issue #100 item 4 - prevention is submit-time (authFieldKey) not input-time; design doc concedes 'No maxLength'",
    "note: issue #100 item 3 audit is doc-only; backups/categories/debts unchanged",
    "scope creep: setup-to-login notice handoff (loginNotice) vs brief 'No changes to the auth flow's behaviour'",
    "wrong/risky: i18n.ts SERVER_ERROR_KEY=/^[A-Z][A-Z0-9_]*$/ flattens non-SCREAMING_SNAKE resource keys",
    "note: design doc copy says 'انتظر دقيقة', shipped copy says 'انتظر قليلاً'",
    "note: empty-field path still shows the native browser validation bubble (required kept)"
  ],
  "manualNotes": "Read-only spec-axis pass; no edits made to the worktree. E2E diff not read within tool budget, so no claim about it."
}
```
