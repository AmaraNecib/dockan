# Issue #115 — onboarding escape hatch, stale design doc, three latent defects

Tier: **Standard**. Base: `origin/develop` @ `850d1f7`. Branch:
`fix/115-onboarding`.

Tier justification: one owner-facing settings toggle plus three fixes to the
preferences/onboarding seams. No money, stock, debt-direction, auth/RBAC
secret-handling, or backup/restore path is touched, and there is no schema or
DB migration (the `preferences` table already exists). The one server-side
change is a value-guarded allowlist entry, not a new contract or table.

## Problem

Deferred from the adversarial review of #104 (`ef119c8`), recorded in
`.scratch/reviews/97/ef119c8-review.md`. Four findings, one PR:

1. `hidden = dismissed || completed` and nothing clears either flag: a
   mis-click retires the getting-started checklist forever.
2. `97-design.md`'s Interfaces section still says "no new tables, no writes"
   while the code added the `preferences` table and RPCs.
3. `recordOnboardingCompletion` avoids re-entering the store queue only because
   `serializeStore` binds `raw` — invisible at the call site.
4. The legacy sidebar import skips when a competing write is in flight, and if
   that write then fails the import is not retried until the next launch.

## 1 — "Show getting started" (the feature)

**Where:** a new `GettingStartedSetting` section on `/settings`, rendered
between the store-identity form and `VaultSettings`.

**What it writes — the decision.** The toggle owns the pair of persisted flags
that hide the checklist, and turning it **on clears both**
(`ui.onboarding.dismissed = "false"` and `ui.onboarding.completed = "false"`);
turning it **off** writes only `ui.onboarding.dismissed = "true"`. Clearing one
and not the other would leave `hidden = dismissed || completed` true and
reproduce the one-way door the issue reports, so both go together.

`ui.onboarding.completed` is a *record-derived milestone*, not a user choice:
the server records it whenever `onboardingProgress` observes all four real
records, and re-records it on the next observation. Clearing it therefore means
"the milestone no longer holds", and it stays cleared only while the checklist
is genuinely incomplete. If the shop really has all four records, the checklist
has nothing to teach and the next progress read records the milestone again —
which is correct, not a second one-way door.

**Contract/route impact — deliberately minimal.** `preferencesSet` refuses
server-owned keys because a client writing `ui.onboarding.completed = "true"`
could hide the checklist with nothing behind it (#104 finding 2). Turning that
into "the client may write this key, but only to `"false"`" keeps the original
protection (the client can never *set* completion) and needs no new RPC, table,
or contract schema. The guard is a server-side value check in
`apps/api/src/rpc/router.ts`.

**Partial-failure honesty.** Clearing `completed` and then `dismissed` are two
`preferencesSet` calls (the existing one-key API); if either fails the control
shows `role="alert"` and the toggle stays off, and a retry converges because
each write is idempotent. No new optimistic state is introduced.

**Interfaces (new):**

```ts
// apps/web/src/components/app/onboarding-state.ts
export function useGettingStartedVisibility(): {
  visible: boolean;      // !dismissed && !completed
  setVisible: (next: boolean) => void;
  isPending: boolean;
  isError: boolean;
  isWriting: boolean;
  writeFailed: boolean;
};

// apps/web/src/components/app/getting-started-setting.tsx
export function GettingStartedSetting(): ReactElement;
```

## 2 — `97-design.md` Interfaces section

Correct the `drizzle-store.ts` bullet that claims "no new tables, no writes, no
change to any existing query", and add the preferences table, the two
`StorePort` methods, the two RPCs, `onboardingComplete`, and the
`lib/preferences.ts` seam to the Interfaces section, cross-referencing the
"PR #104 follow-up" section that already documents them. Doc-only.

## 3 — Make the composition safety visible

Extract the two raw operations `recordOnboardingCompletion` composes into
closures declared outside the port object:

```ts
const readOnboardingProgress = async (): Promise<OnboardingProgress> => { … };
const upsertPreference = async (key: string, value: string): Promise<void> => { … };
```

The port exposes them (`onboardingProgress: readOnboardingProgress`,
`setPreference: upsertPreference`) and `recordOnboardingCompletion` calls the
**closures directly**. A closure cannot be re-wrapped by `serializeStore`, so
the safety is structural at the call site instead of resting on
`.bind(raw)` inside the wrapper. No store-connection model change.

## 4 — Retry the legacy sidebar import

The import runs once per mount and skips itself while the owner's write is in
flight (`hasPreferenceWrite`). Two changes:

- `lib/preferences.ts`: a write that **failed** is removed from `writtenKeys`
  (a failed write is not a choice), and every settled write notifies
  `onPreferenceWriteSettled(key, ok)` after any queued follow-up settles.
- `App.tsx`: `useSidebarPreferenceMigration` subscribes to settled writes and
  re-runs the import when a `ui.sidebar.collapsed` write fails. The import's own
  direct `writePreference` does not notify, so there is no retry loop; an
  in-flight guard prevents two concurrent imports.

## Round 2 (PR #241 Greptile review) — the guard must remember, not just refuse

The round-1 retry had the same defect shape it was written to remove, one step
narrower: `importLegacy()` refused while `importing` was true, and the refusal
was silent. When the migration read and the competing write settle in the same
**turn**, the read observes the write in flight and the migration skips
(`hasPreferenceWrite`), then the failed-write listener fires *before* the
migration's `.finally()` clears `importing`. The listener's one retry is
dropped, and the owner's legacy sidebar choice stays unimported for the whole
session. Sequential settling (read, then write) hid it because the guard was
already clear by the time the listener ran.

The fix is one bit of state: when `importing` is true, set `retryPending`
instead of merely returning, and run the remembered import from `.finally()`
after clearing `importing`. One flag, not a queue — a second request while one
is pending is the same request, so state cannot grow without bound. The
concurrent-import guard itself is unchanged.

**The general rule**, worth stating in the code: a guard that decides "not now"
must record that it was asked, or "not now" silently becomes "never". The one
other guard of this shape found in the same change is named under
candidate follow-ups rather than fixed quietly.

## Planned tests

Unit (`apps/web`):

- `getting-started-setting.test.tsx`: both flags off → toggle on; both flags on
  → toggle off and clicking writes **both** keys to `"false"` and flips the
  switch (the two-way pin); a failed write shows the alert and leaves the flag
  unchanged; a failed preferences read disables the control.
- `App.test.tsx` (RequireSession migration): legacy key + a competing sidebar
  write held in flight → migration skips, then the write fails and the import
  re-runs, lands the legacy value, and clears the legacy key. Round 2 adds the
  interleaved variant: the read is released and the competing write is rejected
  in the same turn, so the failure listener runs while `importing` is still
  true; the remembered retry must land the legacy value. Mutation proof:
  remove the pending flag (the pre-round-2 code) and the interleaved test fails
  with `preferenceStore[...] === undefined`.
- `lib/preferences.test.tsx`: a failed write notifies `ok: false` and clears
  `hasPreferenceWrite`; a successful write notifies `ok: true` and keeps it.

API (`apps/api`):

- `onboarding-progress.test.ts`: a bounded-race deadlock guard — if
  `recordOnboardingCompletion` re-entered the serialized port methods, the
  single-connection queue would hang; the race turns that into a failure
  (mutation proof: revert to `this.*` **and** drop `.bind(raw)` → the race
  reports the deadlock; the fixed code passes with the same mutation).
- `router.test.ts`: `ui.onboarding.completed` with `"true"` is still refused;
  `"false"` is accepted and readable.

E2E (`tests/e2e/00-onboarding.spec.ts`, plus map wiring):

- Dismiss → reload (gone) → `/settings` toggle on → dashboard shows the panel
  again, proving the escape hatch survives a fresh session. The e2e-selection
  map and `docs/ci.md` gain `00-onboarding.spec.ts` on the settings rule,
  because `settings.tsx` now drives that spec.

## Risks

- **Two-key clear is not atomic.** A partial failure is surfaced, not swallowed,
  and retrying converges. Accepted for a client-owned settings action.
- **A genuinely-complete shop re-records the milestone**, so the toggle looks
  ineffective there. That is the intended "nothing to teach" behaviour; the
  hint copy explains the checklist returns while a step is open.
- **Server auto-record on every progress read** keeps `completed` derived from
  records; the toggle cannot leave a false "incomplete" claim standing.
- **e2e selection drift**: settings now hosts an onboarding-owning control, so
  the map rule is widened rather than left to under-select.

## Out of scope (deliberate)

- No schema/table change, no new RPC, no change to the single-connection store.
- No "reset progress"/re-teach-the-recipe feature beyond re-showing the panel.
- No change to the milestone's write path or its retry cap.

## Candidate follow-ups (named, not fixed quietly)

Round 2 is the sidebar retry only. Two more "refuse silently becomes never"
guards sit in the same #115 change; they are reported to the parent as
candidates rather than folded into this diff.

1. **The escape hatch is unreachable when the preferences read fails.**
   `GettingStartedSetting` sets `disabled = isPending || isError || isWriting`,
   so a failed `/preferences` read leaves the owner with a static
   "unavailable" message and no retry on the control. It self-heals only through
   the shared query's refetch-on-focus/reconnect or a remount — there is no
   explicit retry. That is closer to "never" than the sidebar case was.
2. **The import's own write failure is only retried next launch.**
   `migrateLegacySidebarCollapsed` returns null when its direct
   `writePreference` fails and relies on the next launch, while a *competing*
   write's failure is now retried in-session through
   `onPreferenceWriteSettled`. The asymmetry is deliberate today (the import's
   own write does not notify, which is what keeps the retry loop-free), but it
   means the same failure mode survives on the other branch of the same
   function.
