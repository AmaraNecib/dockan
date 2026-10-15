# Test-audit evidence — #184 review-fix round 4 (PR #190)

- PR base: `origin/develop`; round-3 final head `d9aad47`; round-4 review head
  `9705b23`; review-driven fixes `1329f69` and `732ce7c` (final code); latest
  commit `62a5322` (this evidence's header SHA).
- Tier: **High-assurance** (opening-balance money math). Agents: edge-case hunter
  + coverage analyst (`reviewer`), quality reviewer (`oracle`). Delta reviewed:
  `git diff c25b66a...9705b23 -- apps/web/src/pages/`; fixes applied after.
- Note: the brief lives in the parent project
  (`D:/projects/mani-project/.scratch/sessions/crew/briefs/feat-184-greptile-round4.md`),
  not this worktree; two review agents reported it "absent" for that reason.

## The brief's required tests

| Requirement | Test |
|---|---|
| **1** — hold the refusal lookup, Ctrl/Cmd-click the back link, release, assert the dialog IS STILL THERE | `keeps the dialog open when a <activation> hits the back link while a refusal's recovery lookup is pending (review round 4)` — parameterised over Ctrl/Cmd/Shift/Alt/middle. Holds `resolveHold` after `OPENING_BALANCE_TARGET_CHANGED`, dispatches the activation, releases, asserts `opening-balance-confirm` is non-null and names `مورد بديل`, `resolveCalls === 2`. |
| **2** — plain-click control so it cannot pass by never abandoning | `abandons the dialog on a plain back-link click while a refusal's recovery lookup is pending (review round 4 control)` — `{ button: 0 }`, asserts the dialog is null immediately and after the release, `resolveCalls === 2`. |

Red-proof: at `c25b66a` (pre-fix) the new-tab case fails with `Received: null`
(the unconditional `abandonAttempt` bumps `dismissalRef`, so the recovery returns
early); the control passes both before and after, so it is a real control, not a
second copy of the fix.

## Findings and resolutions

| # | Risk | Finding | Resolution |
|---|------|---------|------------|
| T1 | 🟠 | Only `ctrlKey` was exercised. `navigatesCurrentTab` is a conjunction; deleting the `!metaKey`, `!shiftKey`, `!altKey` or `button === 0` term left every test green (a macOS-only `metaKey` regression would ship). | **Fixed at `1329f69`**: the new-tab case is parameterised over `[Ctrl, Cmd, Shift, Alt, middle]` (`NEW_TAB_ACTIVATIONS`). Verified mutant-adequate by deleting `!event.metaKey` and watching the Cmd case fail. |
| T2 | 🟡 | ~30 lines of render→type→save→hold-refusal setup were triplicated across the round-3 Escape test and both round-4 tests. | **Fixed at `1329f69`**: extracted `openConfirmWithRefusedSaveHeld()` + `releaseHeldRecovery()`; the round-3 Escape test now consumes the same helper. |
| T3 | 🟡 | `modifiedClickOn` duplicated the querySelector + null-throw + `act` scaffold of `clickOn`; the name was also misleading for the plain-click control. | **Fixed at `1329f69`**: shared `clickTarget()`; renamed to `dispatchClickOn`. |
| T4 | 🟡 | Nested `act` (an `await act(async …)` wrapping a helper that already wraps `act`). | **Fixed at `1329f69`**: the helpers own their `act`; tests call them directly. |
| T5 | 🟡 | The predicate docstring claimed the rule was "applied to every dismissal route … so the rule cannot drift", but there is exactly one call site. | **Fixed at `1329f69`**: reworded to "the back link is the only route today; a future one calls it instead of growing a second, drift-prone check." |
| T6 | 🟡 | `ReactMouseEvent<HTMLAnchorElement>` on a predicate that reads only `button`/modifier keys and ignores the target. | **Fixed at `1329f69`**: narrowed to `ReactMouseEvent`; the `732ce7c` target read uses `currentTarget.getAttribute` (an `Element` method), so the generic-free type stays honest. |
| T7 | 🟡 | A synthetic `click` with `button: 1` models no real browser: middle-click emits `auxclick`, which React's `onClick` never sees. | **Accepted, documented**: `button: 1` stays to pin the predicate's `button === 0` term, with a comment stating real browsers emit `auxclick`. It guards the branch, not a live path. |
| T8 | 🟡 | Keyboard activation (Enter) synthesises `click(button 0)`, so the predicate abandons — the comment called modified activations new-tab generally. | **Dismissed (not a bug)**: Enter navigates the current tab, so abandoning is correct. Comment now says "modified **mouse** activation". |
| T9 | 🟡 | Drag-off-window ending in a `click(button 0)` can abandon without navigating; touch long-press fires `contextmenu`, unasserted. | **Dismissed, out of scope**: no navigation happens on those paths and a plain click abandoning is defensible. |
| T10 | 🟡 | The audit pass did not verify page Cancel / dialog Cancel / resolveKey-change / unmount-cleanup triggers. | **Closed**: walked below; none is a navigation gesture. |
| T11 | 🟠 | The debate critic found the predicate omitted `target`, so adding `target="_blank"` to the back link later would reintroduce the round-4 bug on a plain click. | **Fixed at `732ce7c`**: the predicate requires the anchor's target to be absent/empty/`_self`; new test `keeps the dialog open when the back link targets a new tab …` fails on `1329f69` and passes on `732ce7c`. |

## Dismissal-trigger walk (the class behind the finding)

| Trigger | File:line | Modality | New-tab hole? |
|---|---|---|---|
| Back `<Link to="/suppliers">` | `supplier-opening-balance.tsx:410-420` | anchor click; the browser owns navigation | **Yes — fixed**: `onClick` only calls `abandonAttempt` when `navigatesCurrentTab(event)` (modifiers, button, and target all checked). |
| Form `onKeyDown` Escape | `:451` | keyboard | No — not a navigation gesture. |
| Page Cancel (`leave`: abandon + `navigate`) | `:237`, `:628` | `<Button type="button">` | No — buttons have no new-tab semantics; the app navigates the current tab itself. |
| Dialog Cancel | `:651` | button; dismisses the inline dialog | No. |
| `useEffect([resolveKey])` (lookup-field edit) | `:164-169` | programmatic | No. |
| Unmount `useLayoutEffect` cleanup | `:179-186` | lifecycle (sidebar, browser back, programmatic nav) | No — and a new-tab click does not unmount this tab, so it no longer races the fix. |
| `opening-balance-done` | `:437` | post-save button; plain `navigate`, no dismissal state | No. |

## Verification (all at `732ce7c`)

- `bun run typecheck` → **0** (3/3 tasks).
- `bun run lint` → **0**.
- `bun run test` → **0**; web **986 pass / 0 fail**.
- `DOKAN_PORT=4673 DOKAN_WEB_PORT=5419 bun run test:e2e` → **0**; **64 passed /
  0 failed** (`supplier-adjustment.spec.ts` back-link and sidebar-leave cases
  included; `vault.spec.ts`, which hardcodes 4399/5174, passed).
- Targeted file: `bun test src/pages/supplier-opening-balance.test.tsx` → **46
  pass / 0 fail**.
- Red-checks: new-tab case fails on `c25b66a` (`Received: null`); mutant-check
  deleting `!event.metaKey` fails only the Cmd case; target case fails on
  `1329f69` (`Received: null`).
- **Contention: none.** All suites ran green on the first isolated-port attempt.
  The one earlier red e2e run was self-inflicted: I had set
  `E2E_DATA_DIR=.e2e-data-r4`, which `backups.spec.ts` ignores (it hardcodes
  `.e2e-data/backups`), so the spec looked at a stale file. Re-run with isolated
  ports and the default per-worktree data dir passed 64/0.
