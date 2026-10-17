# #262 design — the hot-path shell scripts become TypeScript on Bun

Tier: **Standard**. The diff moves harness scripts (`scripts/crew/**`, `.scratch/scripts/**`,
`.scratch/verification/262/**`) that run the crew pipeline. Nothing it touches is bundled into
the app or reachable from a browser, so none of the five High-assurance failure modes (stock < 0,
payment > total, debt direction, auth bypass, backup corruption) applies. It is Standard, not
Lightweight, because a runtime executes every line of it: a mistranslated guard here stops lanes
from starting or burns a worktree that still held work.

Base: `origin/develop` at `ec2f772f63418d0af9b343826e3399f6b814c8e4` (merge-base = HEAD).

## Problem

Five scripts on the hot path are still shell:

| legacy | lines | why it is the risky kind of shell |
| --- | --- | --- |
| `crew-pickup.sh` | 351 | builds a multi-line prompt into `$MSG`, passes it as an argv element, `grep -l` claims a brief, `sed`/`paste`/`awk` parse the queue, a `mkdir` lock with `stat -c %Y` |
| `crew-loop.sh` | 154 | backgrounds itself with `nohup bash $0`, parses pickup's `[pickup] started=N`, pipes JSON through inline `bun -e` |
| `e2e-slot.sh` | 172 | a `mkdir` mutex whose stdout is parsed by an extension (`^PORTS (.+)$`), plus `ls`/`sort`/`find -mmin` queue reaping |
| `herdr-wake.sh` | 95 | exit codes carry the whole policy (0/2/3), a `jq` dependency that cannot be told apart from a gone pane |
| `crew-clean.sh` | 95 | destructive, with five ordered guards, one of them a python-in-pipeline lane reader |

The class is quoting, word splitting, path mangling and unparsed external JSON — the failures the
ticket lists (an empty `$MSG` accepted at exit 0, a `MSG=` definition deleted while its uses stayed,
`A=x cmd1 | cmd2` scoping an env var to the wrong process, python mangling UTF-8).

## Deliverable

1. `scripts/crew/{crew-pickup,crew-loop,e2e-slot,herdr-wake,crew-clean}.ts` — tracked, linted, and
   covered by `bun run test` (`turbo test && bun test ./scripts/`, which recurses into subdirectories).
2. `.scratch/scripts/{crew-pickup,crew-loop,e2e-slot,crew-clean}.sh` — the compat name, now a
   forwarding shim (`exec bun "$(dirname "$0")/../../scripts/crew/<name>.ts" "$@"`). **Required, not
   cosmetic**: `crew-autopilot.ts` walks up for `.scratch/scripts/crew-pickup.sh` to decide whether
   the in-session autopilot arms at all, and `e2e-slot-guard.ts` walks up for
   `.scratch/scripts/e2e-slot.sh`. Moving rather than shimming silently disarms both.
3. `scripts/crew/herdr-wake.sh` — the installable shim for `~/.pi/agent/bin/herdr-wake.sh`, which is
   outside every repo, so it cannot be committed in place. It resolves the TypeScript by env
   override, then the caller's repo, then this repo.
4. `--selftest` on every converted script, printing `ok`/`FAIL` per case and exiting non-zero on a
   failure. The same case list is what `scripts/crew/*.test.ts` asserts, so `--selftest` cannot
   drift from CI.
5. `.scratch/verification/262/legacy/*.sh` — the frozen pre-migration sources, with the live
   old-vs-new diff in `.scratch/verification/262/<sha>-diffproof.md`. This is rule 4's other half:
   `.scratch` is untracked in the main repo's working tree, so replacing a `.sh` there would lose
   the implementation with no way back.

Deferred, with a decision request: `crew-repo.sh`, `launch-lane.sh`, `gh-pr-watch.sh`,
`gh-pr-watch-settle.sh`, `gh-run-watch.sh`. None is on the hot path named in the acceptance
criterion, `gh-pr-watch.sh` is already superseded for Greptile by `crew-pr-watch.ts` (the loop
calls that one), and `launch-lane.sh`'s job is inside pickup. They are the "one at a time"
remainder, each independently verifiable, rather than a second unverifiable sitting.

## Interfaces and contracts

The output that is **parsed** is reproduced byte for byte. Named in code where each one lives:

- pickup, last line: `[pickup] started=<N>` — `crew-loop.sh` line 80's `sed -n 's/^\[pickup\] started=\([0-9]*\)$/\1/p'`
  and `crew-autopilot.ts`'s `/started=([1-9][0-9]*)/`.
- loop log: `tick: <first line, 160 chars> | started=<N>`, `pickup: <12 `[pickup]` lines, `|`-joined, 500 chars>`.
- slot, stdout: `^PORTS (.+)$` and `^PORT_SLOT=` — `e2e-slot-guard.ts` reads `PORTS` and treats a
  non-zero exit as "no slot, block the run". `acquire` therefore keeps exit 2 (not 1) when the
  queue is busy.
- slot, port quartet: `4600 + slot*100` then `+1000`, `+1`, `+1001`; slot names stay `slot1..slotN`.
- wake, exit codes: `0` delivered, `2` stayed blocked, `3` missing/refused, `1` usage (the bash
  `${x:?}` code, kept).

What changes deliberately, and why:

- **`crew-pickup` validates the launch message before it creates the worktree.** The bash order was
  `worktree create` → `agent start` → `if [ -z "$MSG" ]`, so the refusal path left a *registered*
  worktree behind (the next tick saw "already a registered worktree" and dropped the ticket from the
  queue). The refusal now happens where it can be obeyed. Rule 3's property — refuses to launch
  with an empty message — is unchanged and now testable without side effects.
- **`crew-clean`/`crew-pickup`/`crew-loop` read env overrides** (`CREW_REPO`, `CREW_WT_ROOT`,
  `CREW_PICKUP`, `HERDR_BIN`) with today's hardcoded values as the defaults. Without it the
  destructive path can only be tested against the live checkout.
- **MSYS paths are translated for `node:fs` only.** `E2E_SLOT_DIR=/d/projects/...` stays in the
  printed `status` line (a human reads it), while the filesystem calls receive `D:/projects/...`;
  `node:fs` would otherwise read `D:\d\projects\...`.
- **`jq` is gone from the wake path.** A missing `jq` and a gone pane looked identical (`state()`
  returned empty for both, and empty means exit 3). The JSON is parsed in-process.
- `herdr`/`bun`/`gh`/`git` are invoked as argv arrays, never through a shell string.

## Planned tests

`scripts/crew/<name>.test.ts` (CI: `bun run test`) each assert their module's `--selftest` cases all
pass, plus the CLI-level contracts above through `execFileSync`:

- `e2e-slot.test.ts` — port arithmetic; two concurrent acquires with `E2E_SLOTS=1` produce exactly
  one holder; re-acquire is a no-op; release frees; stale hold reaped; another lane's dead request
  reaped after 2 min; `--no-wait` exits 2.
- `crew-pickup.test.ts` — refuses an empty message *before* any herdr call (fake runner, asserting
  the worktree create was never invoked); a failed `worktree create` leaves the item queued; the
  queue parse skips `[blocked]`; the lane count filters by repo; `BASE:` strips backticks.
- `crew-loop.test.ts` — `started=N` parsing; the tick logs and wakes exactly once; a fake pickup
  spawned as a real child process end to end.
- `crew-clean.test.ts` — an uncommitted source file blocks the burn; an open PR blocks it; `--force`
  overrides only the dirty check; `--keep`; `--dry-run` removes nothing.
- `herdr-wake.test.ts` — blocked → 2, missing → 3, 5 refusals → 3, accepted → 0; `herdr` absent from
  `PATH` → 3.
- `parity.test.ts` — the new CLI stdout against golden fixtures captured from the legacy shell on the
  same inputs.

## Risks
- **A concurrent writer is editing the same files in the main repo.** While this lane ran, a second
  writer in `D:/projects/mani-project` shimmed `.scratch/scripts/crew-loop.sh` to its own
  `.scratch/scripts/crew-loop.ts`, added `crew-github.ts`/`dehardcode-repo.ts` and touched
  `crew-pr-watch.ts`. This lane touched nothing there (the live loop reads its own `.sh`
  incrementally), so the two conversions are disjoint on disk — but the parent must decide which
  becomes the source of truth before installing these shims. Recorded in the lane report.
- **`.scratch/scripts/*.sh` now exist in the repo, so merging collides with the untracked harness
  copies in the main repo.** The install step is: move the five files aside (they are in the frozen
  legacy set), `git pull`, then install `scripts/crew/herdr-wake.sh` at `~/.pi/agent/bin/`. Running
  the loop while its own `.sh` is rewritten is what this avoids — bash reads a script incrementally.
- **A shim is still a `.sh`.** The acceptance criterion says no `.sh` on the hot path and rule 4 says
  keep the `.sh` name; both hold only as "no `.sh` contains an implementation" — every hot-path `.sh`
  is an `exec bun` one-liner. `scripts/crew/shims.test.ts` fails if one grows logic back.
- **Live-state diff flakiness.** The live `crew-clean --dry-run` pair is ~4 minutes per side, so a
  lane closing in between changes the answer. The committed proof therefore runs the legacy file
  with its two constants retargeted at a fixture (`.scratch/verification/262/raw/run-diffproof.sh`);
  the live runs stay as a supplementary transcript. A non-empty diff is a failed proof, never noise.
- **Untested in CI:** `scripts/crew/**` is not in `bun run typecheck` (the repo has no root
  tsconfig, and `@types/bun` lives under `apps/api`). Lint and the tests cover the directory; the
  type pass is run by hand and is reported as deferred work.

## Deltas the diff-proof forced (each one found by running both versions, not by reading)

1. **`[pickup] queue:` prints bare numbers**, not `#N`. The shell's `sed` captured `\1` from
   `^[0-9]*\. #\([0-9]*\)`, so the echo is `queue: 999 998 997 ` with a trailing space. The first
   version printed `#999`. Caught only because the fixture queue was non-empty; the live queue was
   empty every time, which is exactly the confident-silence shape this ticket is about.
2. **`hostPath` had to learn MSYS `/tmp`.** `node:fs` reads `/tmp/x` as `D:\tmp\x`, so
   `readdirSync` threw, the `catch` returned no briefs, and pickup reported "no brief declares it"
   for a brief that was sitting on disk. The `catch` swallowing a `ReferenceError` in the same
   function produced the same plausible-but-wrong answer — the bare-`except` failure the ticket
   describes, reproduced in the port of it.
3. **The display path and the fs path are now separate** for briefs and for the loop's log/pidfile:
   the raw string is printed (so it matches the shell byte for byte) and `hostPath` is applied only
   where a syscall happens.
4. **A lane that stops waiting gives up its queue ticket.** The shell left it behind for the full
   2-minute grace, and `e2e-slot-guard.ts` calls `acquire --no-wait` on EVERY heavy run, so a blocked
   lane parked a ticket that then blocked the next lane. The ablation for the slot's atomic claim
   (`mkdirSync(..., { recursive: true })`) is what proved the four-lane case, and this one is the
   same class: a lock that reports a holder that has already left.
5. **`crew-loop status` reports the truth for a live pid.** The shell's `kill -0` under MSYS cannot
   see a native Windows pid (`kill: (22976) - No such process` while `tasklist` shows `bun.exe`
   22976 running), so it called a running loop "not running" — and `start` would happily add a
   second one. `process.kill(pid, 0)` sees it. This is the one deliberate diff in the loop's output.
6. **The launch message's line separator is LF.** The shell's `MSG=` literal carried the repo's CRLF
   bytes; the prompt is read by a model, not parsed. Everything else in the message is byte-identical
   (asserted in `crew-pickup.ts`'s selftest).
