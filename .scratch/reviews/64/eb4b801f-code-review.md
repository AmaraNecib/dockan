# Code Review — issue 64 + PR #65 finding 5 (portable build)

**Tier:** Standard · **Base:** `ffe5cf6` · **Reviewed head:** `eb4b801f`
**Diff:** `git diff ffe5cf6...eb4b801f`
**Commits:** `aef13f8` → `c478565e` → `a6d7c43` → `36be366e` → `2e9be9b8` →
`242083cf` (finding-5 lock handling) → `eb4b801f` (micro-tests + design)

Replaces `2e9be9b8-code-review.md` (SHA updated after the PR #65 finding-5
round). Standards + Spec axes reviewed in parallel sub-agents across three
rounds, final round scoped to the lock-handling delta.

## Standards

_Hard violations:_ none at the final head. Semantic commits, bun-workspaces
only (no new lockfiles), evidence under `.scratch/reviews/64/<sha>-<gate>.md`
(this file + `eb4b801f-test-audit.md`), desktop.rs comment style preserved,
working tree clean (`git status --short` empty; the recurring `Cargo.toml`
modification is byte-identical line-ending noise, restored).

_Judgement calls (accepted, labelled):_
- Lock-failure message re-derives `${PORTABLE_BASENAME}-new` instead of
  reusing `outputNames` naming — deliberate: the literal, actionable text is
  asserted by the regression tests.
- `fix(64)` convention on feature work — consistent with the
  `fix/64-portable-mode` branch (repairs the owner-facing portable command).
- No Playwright E2E for this packaging change — dev mode is provably
  untouched; the real end-to-end build is the attestation.
- Duplicated `[dokan] portable … ready at` logs between `portable.mjs`
  entry and `release.ts` (two entry points); `PORTABLE_MARKER` /
  `Dokan-portable` literals inherently cross-language.
- `-new` fallback broadly treats any persistent removal failure as locked
  and then fails loudly — no silent masking.

_Verification of the retry loop:_ bounded `for` (attempts exhausted ⇒ false,
no recursion), sleep bounded (150ms × attempts−1 via `Atomics.wait`), staging
dir pre-removed and post-cleaned on every failure path, throw fires before
any staging/zip output.

## Spec

All four issue-64 requirements plus PR #65 finding 5 confirmed:

1. **Rust detection** — `portable.marker` next to `current_exe()` ⇒
   `data_dir = <exe-dir>/data`, `port_root = data/run`; absent ⇒ `%APPDATA%`
   unchanged; reserve-port/boot-token/registry untouched.
2. **portable.mjs** — `bundle/portable/Dokan-portable/` (`Dokan-portable.exe`
   byte-copy + `dokan-api.exe` + `ui/` + marker) + `Dokan-portable.zip` via
   System32 `tar -a -c -f`; NSIS avoided (`--no-bundle`, stale `bundle/nsis`
   removed); prints final paths.
3. **Wiring** — desktop `portable` (default) / `installer` scripts + root
   aliases; unknown flags fail loudly; win32 preflight.
4. **DOKAN_DATA_DIR** — carries the resolved (portable ⇒ exe-adjacent) path.
5. **Finding 5 (both folders locked)** — bounded retry (3 × 150ms) → FAIL
   LOUDLY with `Portable output folders are locked by another process: both
   <canonical> and <root>/Dokan-portable-new could not be removed. Close the
   running app (or remove <root>/Dokan-portable*) and retry.` Never a silent
   skip, never a partial folder/zip, nothing touched outside `bundle/portable`;
   `-new` fallback preserved when only the canonical is busy.

**Scope notes:** `-new` fallback + pid-unique staging + zip-follows-folder
naming are beyond the literal brief but tuari-mirroring, tested, and prevent
stale-overwrite; `--portable` symmetry deliberate. No scope creep found in
the terminal round.

**Verdict per axis:** Standards — zero hard violations, worst issue minor
(cross-language literal drift). Spec — no missing or wrong behavior; all
finding-5 points implemented per the owner brief. No blockers on either axis.

_Commands: `bun test` 34/34 desktop; `cargo test` 13/13; `cargo clippy … -D
warnings` clean; typecheck + lint + turbo test green; e2e 18/18; real
end-to-end portable build green (folder + 41.8MB zip re-built through the new
removal path)._