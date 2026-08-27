# Test Audit — issue 64 + PR #65 finding 5 (portable build)

**Tier:** Standard · **Base:** `ffe5cf6` · **Reviewed head:** `eb4b801f`
**Diff:** `git diff ffe5cf6...eb4b801f`

Replaces `2e9be9b8-test-audit.md` (SHA updated after the PR #65 finding-5
round). Multiple review rounds (edge-case hunter, coverage analyst, quality
reviewer sub-agents), including a terminal mutation-checked round.

## Coverage vs acceptance criteria — all satisfied

| Criterion | Evidence |
|---|---|
| Rust detection: marker ⇒ `<exe-dir>/data` + `data/run`; absent ⇒ `%APPDATA%`; TOCTOU untouched | `runtime_data_dir_*` tests (incl. marker-as-directory must not flip). `cargo test` 13/13 |
| Folder assembly: exe+sidecar+ui+marker, no `setup.exe` | happy path: renamed exe present, source absent, deep-copied ui, EMPTY marker, byte-identical exe copy, `walkNames` no `setup.exe`, no staging leftover, build outputs never shipped |
| Fail-loud artifact guards | missing/zero-byte/wrong-type sidecar/exe, empty `ui/`, unknown CLI flags |
| Dispatch | default portable, `--installer`, `--portable` wins, unknown flags throw |
| Zip | real win32 run: exists + non-empty, name follows the folder (`-new` included) |
| **PR #65 finding 5 — lock handling** | bounded retry (exactly `LOCK_RETRY_ATTEMPTS` attempts, sleep ⇒ attempts−1, never after last), transient lock clears, absent dir removable, remove-without-delete re-checked via `existsSync`, BOTH locked ⇒ actionable error (message asserts `/locked by another process/`, `/close the running app/i`, `/Dokan-portable\*/`), no partial output, sentinel OUTSIDE `bundle/portable` survives, locked folders byte-untouched, no staging leftover; ONLY-canonical locked ⇒ `-new` fallback preserved |
| e2e | 18/18 green at the code head |

## Terminal-round verification (mutation-checked)

Removing the fail-loud throw makes exactly the BOTH-locked test fail on the
message assertion — the regression genuinely guards the fix. The lock is
simulated via the `removeOutputFolder` seam (`lockedRemoveWrapper` wraps the
REAL `tryRemoveOutputFolder`, injecting only `remove`/`sleep`) because Bun
1.3.14's `rmSync` ignores Windows open-handle locks (documented; OS-level
lock simulation is impossible on this toolchain).

## Residual risks (documented, not auto-tested)

- Empty `ui/` guard checks top-level only (real web builds always emit
  `index.html`).
- `-new` OS-lock fallback is seam-tested; a genuine locked zip on tar failure
  leaves a partial `.zip` (outside finding-5 scope).
- Env-glue line / `runTauri` args not mocked; covered by the real end-to-end
  build + e2e.
- Zip contents only existence/non-empty-verified off Windows (`skipIf`).

## Test-quality verdict

Grade **A** (terminal round). Cleanup hygiene: every scratch dir asserted a
direct child of `os.tmpdir()` before deletion, cleanup in `finally`; suite
avoids the bun-1.3.14 Windows hang (no skip-callback alongside junction fs
ops).

_Commands: `bun test` (desktop) 34 pass / 0 fail, 158 expects; `cargo test`
13 pass; e2e 18 pass; real `bun run --filter @dokan/desktop portable` re-built
the folder + zip through the new removal path._