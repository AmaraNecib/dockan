# ISSUE: **#244** — round 3: four more evasions, and one of them is my own proof lying

Tier: **High-assurance** (the ratchet guards money readers; a fake proof is worse than a missing one).
Keep the recorded tier.
BASE: origin/fix-244-blankness-ratchet (the PR head, `92f40d0`). Target: PR **#246**.
Authority: commit only. **Do NOT push, do NOT open a PR, do NOT merge, do NOT write `.agents/wisdom/`**
— put any candidate lesson in your `crew_report`.

Read the Greptile comment on **#246** — it is the specification. Read `.agents/wisdom/README.md`.
Findings **5–8** in that comment are the round-1/2 list being re-listed; they are already fixed and
pinned. **Do not rework them.** Findings **1–4** are new and all four are real.

## Finding 3 first, because it undermines every other claim in this PR

`.scratch/reviews/244/390da2d-mutation-proof.sh:80-85`

The script accepts **every non-zero test exit** as a successful detection. It never checks that the
unmutated suite is green first, and never checks that the **expected** assertion is the one that
failed. So a missing dependency, a startup error, or an invalid reverse patch produces a successful
script exit that proves nothing about the gate.

**Fix it before the others**, because the others are claims backed by this script. Require:
a green baseline, and the expected failing assertion. Apply the same requirement to
`branch-pin-proof.sh` — it collects failed-test lines but does not require any. A proof harness that
cannot distinguish "the gate was caught" from "the runner crashed" is the exact silent-pass failure
this whole ticket exists to end, and this time it is *mine*.

Then demonstrate it: make the runner error (e.g. point it at a missing file) and show the script now
**fails**, where before it "passed".

## Finding 1 — template expressions hide raw checks (`blankness-gates.ts:234-239`)

`${...}` is treated as text rather than code, in two separate ways:

- `stripComments` leaves comments inside a template expression untouched, so
  `` `${draft.trim() /* blank */ === ""}` `` returns no gate;
- `bracePairs` ignores scopes inside `${...}`, while `collectDeclarations` still reads their
  declarations — so an inner normalised `trimmed` can hide an outer raw `trimmed === ""`.

Both returned `[]` while their controls were detected. **Treat `${...}` as code in both passes**, with
a fixture for each of the two cases. Keep the existing decision that template *text* is not blanked
into code (that would hide a gate inside `${}`, the unsafe direction) — the fix is that the
expression part is code, not that the text part becomes code.

## Finding 2 — a normalised key hides a raw value (`blankness-gates.ts:362`)

`NORMALISED` skips a whole declaration when a normaliser call appears **anywhere in its receiver**:

```ts
const trimmed = drafts[normalizeArabicIndicDigits(id)].trim();
if (trimmed === "") return null;   // no gate reported
```

Only the **key** was normalised; the selected draft is still raw. The equivalent inline check *is*
detected, so this is an inconsistency, not a deliberate boundary. **Skip a declaration only when the
trimmed value itself comes from the normaliser**, and add a fixture for a normalised dictionary key.

## Finding 4 — the e2e asserts the form, not the stored value (`tests/e2e/blankness-mark-only.spec.ts:38-40`)

The spec claims the item saves with the default threshold, but it checks only the form reset and that a
row appeared. It would pass if the server stored the wrong threshold. The unit test asserts the mocked
request, not the stored value. **Reopen the saved item after a reload and assert its threshold is `5`** —
the saved-value contract, not just that a save happened.

## Required for every fix

- A **failing-first** fixture: the gate escaping *before*, caught *after*.
- The proof scripts must be **green-baseline-then-red**, never merely non-zero.
- `gate-set-diff` stays `ADDED []` / `REMOVED []` — the classification set must not move.

## Report

Name any of the four you judge the matcher cannot handle, with the reason, as a stated ceiling rather
than an omission. A stated ceiling is allowed; a silent one is the bug.
