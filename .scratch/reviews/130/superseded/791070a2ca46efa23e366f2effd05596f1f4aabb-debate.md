# #130 — Debate, review-fix round 1 (critic + defender)

Reviewed HEAD: `791070a2ca46efa23e366f2effd05596f1f4aabb` (`feat-130-arabic-name-variants`, PR #189)
Base: `fc951133134a9b0b18b5ae38f9658665c29e73ec` (`origin/develop`)
Previous reviewed HEAD: `14f0a0d9b9e812adb2cbd0c2b53d1327a5fb2f3d`
Method: critic and defender as two independent parallel sub-agents (`oracle`)
against `d967295369946c98d6c317456428a6431e9c72d5` (the fix commit); the
follow-up findings were applied and re-verified at this HEAD.

## Verdict

**Pass after fixes.** No blocker. The critic confirmed the correctness fix is a
strict subset of the old rule (no warning lost) and found two gaps in the
*proof*, both fixed.

## Round-1 findings and resolutions

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| G1 | correctness (Greptile 4/5) | With a phoneless «علي علي» **and** a phoneless variant «على علي» stored, typing the exact spelling returned the **variant** — the warning's one-click pick offered a different debtor, and `needsChoice` did not stop the click. | **Fixed** in `d967295`: `duplicateNameParty` returns `undefined` as soon as a stored record is the candidate's exact phoneless spelling (the identity case `needsChoice` owns), so the variant fallback cannot run. The defender's 114-case sweep found 4 behavioural differences from the old code, every one of them this bug; with a phone on the candidate the change is a provable no-op. |
| G2 | correctness (Greptile 4/5) | The E2E cleanup treated a pending `customersList` as an empty list. | **Fixed**: presence now comes from the acked `customersList` payload via `readCustomers()`. |
| G3 | correctness (Greptile 4/5) | The cleanup asserted the success notice, which survives into the next dialog, so it could finish before the record was gone. | **Fixed**: each deletion awaits its own `customersDelete` and asserts the row disappears; a final fresh read asserts neither name is left. |
| F1 | 5 | Even after G2, the `row.count()` presence check was a one-shot DOM read: an unflushed filter could still read a present record as absent and skip it silently (the same failure class, narrowed). | **Fixed**: presence is taken from the acked payload, and the end-of-hook re-read turns any skip into a failure. |
| F2 | 3 | Three full list scans per call (the early-return `some`, then two `find`s) duplicated the rule in two shapes; `duplicateNameParty` runs on every render while the create panel is open. | **Fixed** in `d967295`: one single-pass loop, order-independent, exact spelling still preferred. |
| F3 | 3 | The regression test under-covered Greptile's shape: no case with the exact phoneless record **plus a variant that has a phone**. | **Fixed**: both variant-with-phone orders added, plus bidi/tashkeel-typed names and the candidate-with-a-phone counter-case. |
| F4 | 3 | No test at the seam the bug actually crossed (the picker's one-click pick). | **Fixed**: `party-picker.test.tsx` pins it — with both phoneless spellings stored, typing the exact one shows the identity gate and **no** duplicate panel. Verified red against `14f0a0d`. |
| F5 | 1 | Doc comment restated the phoneless rule and read as contradicting itself. | **Fixed**: two bullets, one per identity rule. |

## Defender's case (kept, verified)

- The early return is the same rule the code already pinned for the phoneless
  walk-in, hoisted from "this record" to "the whole list" — the correct scope.
- `needsChoice` (keyed on `normalizeTextKey`) is what refuses the typed-only
  submit in both consumers, so suppressing the warning does not leave the owner
  unguarded.
- A shared-phone record is skipped individually, so a differently spelled
  duplicate of it still warns (pinned).
- Residual risk accepted: the function's safety now leans on the UI's
  `needsChoice` gate; the doc comment states that coupling.

## Process note

The three review-fix findings are Greptile's; this debate round attacked the
*fix* (over-suppression, order-dependence, and whether the new tests could pass
on a broken build). The CI failure on PR #189 (`receipts.spec.ts`) is filed as
#191 and untouched.
