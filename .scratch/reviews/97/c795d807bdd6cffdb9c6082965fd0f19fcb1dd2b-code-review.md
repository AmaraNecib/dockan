# Code review — issue #97, PR #104 round 4 (delete the optimism)

- **Reviewed HEAD:** `c795d807bdd6cffdb9c6082965fd0f19fcb1dd2b`
- **Fixed point:** `dfe35222a355fcdb606725cbac175726b03ae760` (previous reviewed HEAD)
- **Diff:** `git diff dfe3522...c795d80` (commits `ce91093` simplification, `c795d80` review fixes)
- **Method:** two read-only reviewer sub-agents (Standards, Spec) run as one
  parallel workflow at `ce91093`; findings are kept separate below and
  dispositioned by the parent, whose fixes are in `c795d80`.

## Standards

**Deleted (verified by grep):** the optimistic overlay and its clear effect, the
per-key write queue (`writeTails`, `pendingWrites`, `writeSequence`,
`latestWriteSequence`, `queuePreferenceWrite`, `isLatestPreferenceWrite`,
`hasPendingPreferenceWrite`, `PreferenceWrite`, `persistPreference`), the write
retries, `cancelQueries` around writes, and the imperative seams
(`readSidebarCollapsed`/`writeSidebarCollapsed`/
`readOnboardingDismissed`/`readOnboardingCompleted`/
`writeOnboardingDismissed`/`writeOnboardingCompleted`/`readPreference`). No
orphaned callers; `writePreference`/`readPreferences` survive as real paths.

**Hard violation found and fixed in this HEAD**

- The write echo's `setQueryData` updater created a partial map when the cache
  was empty (`{ [key]: stored }`), violating the design's "never a partial
  cache" rule and dropping sibling preferences. **Fixed** `c795d80`: the updater
  returns the previous value unchanged when undefined, and the controls are
  disabled while the shared read is pending so a write cannot race it.

**Correct (verified)**

- `setValue` awaits the server and installs only the returned value; a failed
  write (`null`) leaves the server value showing.
- The synchronous `inFlight` ref guards a double-click before any await; the
  test proves one request for two clicks.
- `RequireSession` withholds the preference-driven shell until the one-time
  migration settles; the effect's `.finally` cannot strand the app.
- `isPending` (read loading) and `isWriting` (write in flight) are distinct and
  both consumed; `disabled` wiring is tested.
- RTL/a11y/contrast unchanged; the loading screen is the existing translated
  component.

**Judgement calls (dismissed)**

- `updateValue` silently no-ops while a write is in flight. **Dismissed:** the
  controls are disabled in the same window, and the hook is not a public API.
- The in-flight guard is per hook instance, not per key. **Dismissed:** the app
  has one hook per key; a shared key would need a shared store, which is the
  machinery just deleted.
- No live-region announcement for a failed write. **Dismissed:** the directive's
  failure policy is "the server value stands"; the control merely stays put.
- `isPending`/`dismissPending` naming proximity. **Dismissed:** the panel prop
  is documented as "disable the dismiss control" and the dashboard computes it.

## Spec

**Req 1 — write awaits the server and sets the cache from its returned value.**
**Met.** One awaited `writePreference`; only the server echo is installed; no
overlay, sequence, or cancel dance remains.

**Req 2 — simple in-flight guard, disabled control meanwhile.** **Met.** A
synchronous ref plus `isWriting`; the sidebar toggle and dismiss button are
disabled; the double-click test asserts one request.

**Req 3 — Finding 1 disappears.** **Met.** There is no optimistic value; the
only local write state is the boolean guard. (A stale read/refetch can still
install an older server value transiently; that is inherent to the mandated
design and self-heals on the next focus.)

**Req 4 — migration before the preference-driven shell renders.** **Met.**
`RequireSession` gates children on the migration; the obsolete pending-write
guard and its racing test are gone; the sequencing itself is now tested.

**Req 5 — failed write keeps the server value.** **Met.** `writePreference`
returns `null`, the hook skips the cache write, and tests cover the hook and the
dashboard dismissal.

**Delete the imperative seams.** **Met.** All test-only seams and their test
file are deleted; the remaining `writePreference`/`readPreferences` are
production paths.

**Keep the right things.** **Met.** The preferences table, session-guarded
bounded procs, the durable idempotent `onboardingComplete` milestone, and
`enabled: false` when hidden are untouched.

**Notes**

- The migration now runs for every authenticated launch even with no legacy key
  (it returns before any RPC when the key is absent), and its result is ignored,
  which adds one loopback read on launch. **Accepted.**
- `getting-started-panel`'s `dismissPending` combines read-pending and
  write-in-flight; the panel is only rendered after the read settles, so in
  practice it is the write state. **Accepted.**

## Disposition (parent synthesis)

| Axis | Finding | Action |
|------|---------|--------|
| Standards | Partial cache from the write echo | **Fixed** `c795d80` |
| Standards | `updateValue` no-op / per-instance guard / no live region / naming | **Dismissed** (judgement; controls disabled, one hook per key) |
| Spec | Req 1-5 (delete optimism, guard, migration, failure policy) | **Met** |
| Spec | Imperative seams deleted | **Met** |
| Spec | Keep server table/procs/milestone/no-poll | **Unchanged and verified** |
| Spec | Migration RPC on every launch | **Accepted** (one cheap loopback read) |

**Summary:** Standards — 1 hard violation (fixed in this HEAD), 4 judgement
calls dismissed. Spec — all requirements met; the directive's deletions are
verified by grep and the retained server-side pieces are untouched.
