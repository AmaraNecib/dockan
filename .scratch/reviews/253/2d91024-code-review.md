# #253 — code review, two axes (run against c1c9e25)

Two independent reviewer children (Standards, Spec) read `git diff
d843566...HEAD`. Findings and dispositions; the disposition commit is `2d91024`.

## Standards

**Claimed hard violation — committed evidence binaries.** The reviewer read
`docs/engineering-workflow.md` → Source-only change policy as forbidding the
before/after PNGs and videos in `.scratch/reviews/253/`. **Dismissed after
verifying the policy text and precedent.** The policy sentence is: *"Stage named
source/config/test/**evidence** files only. Never use `git add -A`."* Evidence
files are the allowed category, and `git ls-files .scratch/reviews` shows 42
committed image evidence files (`244/*.png`, `96/screenshots/before|after/*.png`).
The standing evidence rule (#259) explicitly requires before/after images **and** a
video for a visual change, so the videos are committed for the same reason.

**Judgement calls:**

| Smell | Finding | Disposition |
|---|---|---|
| Duplicated Code | The tag vocabulary appears in `activitySummaryTags`, the `activitySummaryText` if-chain, and `activityRefLink`'s tag lists | **Accepted.** The web set-equality guard binds the constant to the branches; the ref map is a different question (routing, not copy). |
| Duplicated Code + weak guard | `STARTUP_MESSAGES` mirrors api English literals; the web test re-hardcoded the same pairs, so a reword was undetected | **Fixed.** The api-side pin (ablation D) now fails if the api sentence changes. |
| Repeated Switches | `ActivityRef` repeats an identical `<Link>` body four times | **Accepted.** Documented: switching on `to` is what correlates `params` with the route union instead of widening it. |
| Primitive Obsession | `adjustmentDirectionKey(token: string \| null)` widens a typed enum input | **Accepted.** The stored token is a raw string; the doc-comment names the contract, and the activity page now only feeds it the two enum values. |

No documented-standard violation survived verification.

## Spec

**Blocker claimed — the acceptance example's direction word.** The spec example
is `رصيد افتتاحي — علينا: 100,000 (محمد بن علي)`. The stored row is
`SUPPLIER_OPENING_BALANCE THEY_OWE …`, and the code renders the direction through
`supplierAdjustDirectionTheyOwe`, which today is **«يسالنا»** (and becomes
«نسالوه» when #252 lands its swap). It never prints «علينا», and amounts are not
thousands-grouped.

**Disposition: not silently changed; raised for the parent/owner.** The reason is
in #252: that issue establishes `THEY_OWE` = *he owes us* and that the two labels
are currently swapped. Printing «علينا» (*we owe*) on a `THEY_OWE` row would be
the exact inversion #252 exists to fix, and hardcoding it in the activity page
would create a second direction source that survives #252. The test therefore
asserts the acceptance **shape** (Arabic sentence, supplier name, amount, no raw
token, direction equals the canonical key), not the example's literal word. The
grouping difference is decision D3 (raw digits everywhere). Both are recorded in
the design doc and the crew report as a decision request.

**Note — two of the six owner-named diagnostics strings have no source.** "Port
stored" and "Store auth under the server-side Tukan API routed" do not exist in
the repository; the four boot rows that do exist (`FIRST_TIME_SETUP` / "owner
account created", `VAULT_CREATED` / "vault created and unlocked",
`SERVER_BOOT_DONE`, `SERVER_STARTED`) are translated. Raised as a decision
request rather than invented.

**Note — "the one source" became two.** Fixed on the api side (the startup-
message pin above).

**Correct per the spec axis:** the reference column links by summary tag and
splits the multi-tag types correctly; the enumeration test exists as required for
both vocabularies; vault tags translate and unknown tags still render raw.
