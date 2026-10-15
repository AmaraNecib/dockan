# Debate evidence — #184 review-fix round 1 (PR #190)

- Base for the delta: `9697611` (round-0 head); PR base `da44b502d39c79a1368e9848542d9a25fac301fc`
- Code head: `179eaf1`; evidence head: `e1c9fbf`
- Tier: **High-assurance** (money path).
- Roles: `oracle` (harsh critic) + `reviewer` (charitable defender), then a second
  critic/defender pass at `179eaf1` after the fixes.

## The two Greptile findings

| Finding | Verdict | Resolution |
|---|---|---|
| **1 (money) — Cancel still wrote balances** | **Confirmed & fixed** | `attemptRef`: `submit` captures `attempt = ++attemptRef.current` and returns after the await when it moved. `leave()` bumps *and* closes the dialog synchronously; the back `<Link>` has `onClick={invalidateAttempt}`; the unmount cleanup bumps too. Cancel is never disabled while `resolving` — a hung lookup cannot trap the owner. |
| **2 — the old destination blocked valid edits** | **Confirmed & fixed** | `typedResolution = { key, supplier }` tagged with the serialized lookup tuple; `typedDestination` is non-null only when the key matches, so a stale destination cannot be used in render. A `useEffect` on `resolveKey` closes the dialog and clears the snapshot; `confirmStale` hides the dialog for the intervening commit. |

## First-pass critic findings and resolutions

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| F1 | 6 | A row edited during a pending resolve was written from the stale click-time closure. | **Fixed** (`0f0a6a9`): `invalidateAttempt()` runs synchronously in `setRow` and every field `onChange`. Unit test added. |
| F2 | 5 | The typed-field invalidation was effect-timed; a resolve settling first could write pre-edit values. | **Fixed** by the synchronous handler bumps (above). |
| F3 | 4 | A one-commit frame could confirm against `typedDestination === null`. | **Fixed**: `confirmStale` gates the dialog render. |
| F4 | 3 | `resolveKey` NUL-join could collide. | **Fixed**: `JSON.stringify([...])`. |
| F5 | 3 | `save` success-path state writes were not mount-guarded. | **Fixed**: success/`closeConfirm` and `setSubmitting` guarded by `mountedRef`. |
| F6 | 2 | "re-resolve the edited row again" is lazy (next submit). | **Accepted** — the edited batch saves; eager re-resolve would add churn. |

## Verification-pass findings and resolutions (at `a207283`)

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| EDGE-1 | 🟠 | The browser-back / router-driven unmount relied on the deferred passive-effect cleanup; the unit unmount test uses `root.unmount()` (synchronous), so the real path was unproven. | **Hardened + tested** (`179eaf1`): the back link invalidates synchronously; a browser-back E2E now proves the unmount path on the real router. |
| EDGE-2 | 🟠 | A refusal after a *row* edit during the in-flight write hit `saveAttempt !== attemptRef.current` and skipped the dialog refresh, leaving a stale `expectedSupplierId` → confirm → refuse forever. | **Fixed** (`179eaf1`): the recovery guard compares the **lookup key** (`resolveKeyRef`), not the attempt id — a row edit still refreshes; only a typed-field edit skips. Unit test with a parked write added. |

## Residual (accepted, documented)

- Browser back/forward settles through the unmount cleanup; the E2E now covers it,
  and the server's `expectedSupplierId` check contains any drift as a refusal.
- The lookup request is not aborted (only its result discarded). The generation
  guard is the brief's offered shape; `staleTime: 0` means the cache is not reused.
- A lost-response retry still surfaces `DUPLICATE_ADJUSTMENT` (pre-existing #177).

## Evidence

- Reviewer transcripts were produced by the debate/test-audit/code-review
  sub-agents for this round; the synthesized findings and their resolutions are
  above. Fix commits: `0f0a6a9`, `a207283`, `179eaf1`.
