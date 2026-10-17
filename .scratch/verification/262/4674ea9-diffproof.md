# #262 evidence — head `4674ea9` (code `65f183c` + the typecheck round `4674ea9`)

Tier: Standard. Base: `origin/develop` at `ec2f772`. Everything here is re-runnable; the
raw transcripts are next to this file in `raw/`.

The claims are written as fields because `crew-trust.ts` re-runs the decisive ones:

```
command   the exact command, runnable as-is
expect    what it SHOULD show -- an exit code, or a pass/fail count
observed  what it DID show
cwd       where it ran, if not the worktree root
```

## 1. What moved

| legacy (frozen in `legacy/`) | new | `--selftest` |
| --- | --- | --- |
| `crew-pickup.sh` 351 lines | `scripts/crew/crew-pickup.ts` | 38 cases |
| `crew-loop.sh` 154 lines | `scripts/crew/crew-loop.ts` | 19 cases |
| `e2e-slot.sh` 172 lines | `scripts/crew/e2e-slot.ts` | 20 cases |
| `herdr-wake.sh` 95 lines | `scripts/crew/herdr-wake.ts` | 11 cases |
| `crew-clean.sh` 95 lines | `scripts/crew/crew-clean.ts` | 15 cases |

The `.sh` names survive as `exec bun` shims (rule 4). That is not optional: the
`crew-autopilot` extension walks up for `.scratch/scripts/crew-pickup.sh` BY NAME and the
`e2e-slot-guard` extension for `.scratch/scripts/e2e-slot.sh`; deleting either file
disarms the autopilot or the e2e cap with no error.

## 2. Claims

### Tests — the selftest case lists, asserted by CI

```
command   bun test scripts/crew/e2e-slot.test.ts scripts/crew/herdr-wake.test.ts scripts/crew/crew-clean.test.ts scripts/crew/crew-pickup.test.ts scripts/crew/crew-loop.test.ts scripts/crew/shims.test.ts scripts/crew/parity.test.ts
expect    25 pass / 0 fail
observed  25 pass / 0 fail, 76 expect() calls
cwd       the worktree root
```

`bun test ./scripts/` (what `bun run test` runs) recurses into `scripts/crew/`, so this is
the CI path and not a local-only command.

### Lint

```
command   bun run lint
expect    exit 0, no findings
observed  exit 0 (oxlint, including the vendored anti-slop rules)
cwd       the worktree root
```

### Type check of the new directory (run by hand, not yet wired into `bun run typecheck`)

```
command   bunx tsc --noEmit --strict --target es2022 --module esnext --moduleResolution bundler --skipLibCheck --types bun,node --typeRoots apps/api/node_modules/@types scripts/crew/*.ts
expect    exit 0
observed  exit 0; BEFORE the second commit: exit 2 with 13 errors (nullable child stdio x2, a required parameter called with none x2, a `dirSizeMb` arity mismatch, 9 `.ts`-extension import errors)
cwd       the worktree root
```

### The diff-proof (rule 5)

```
command   bash .scratch/verification/262/raw/run-diffproof.sh
expect    IDENTICAL on every case except the one deliberate delta in §4
observed  see the table below
cwd       the worktree root; the legacy files run from the main repo's `.scratch/scripts/` or from `legacy/`, and the fixtures live in the native TEMP dir
```

| case | result | transcript |
| --- | --- | --- |
| `e2e-slot status`, live shared slot dir | IDENTICAL | `raw/1-slot-*.txt` |
| `crew-loop status`, fixture state dir, dead pid | IDENTICAL (`not running`) | `raw/2a-loop-dead-*.txt` |
| `crew-loop status`, fixture state dir, live pid | DIFFERS — deliberate, see §4.5 | `raw/2b-loop-live-*.txt` |
| `crew-clean --dry-run`, fixture repo (one dirty worktree, one clean) | IDENTICAL | `raw/3-clean-*.txt` |
| `crew-pickup --dry-run --why`, fixture queue (claimable + brief-less + doubly-claimed) | IDENTICAL modulo the masked live CPU window | `raw/4-pickup-*.txt` |
| same fixture with the slots free → the per-item path (`base=`, `WOULD start`, both skip reasons) | IDENTICAL modulo the masked live CPU window | `raw/4b-pickup-*.txt` |
| `crew-pickup --dry-run --why`, the LIVE queue | IDENTICAL modulo the masked live CPU window | `raw/5-pickup-live-*.txt` |

Why fixtures for two of them: `crew-clean` and `crew-pickup` read live state (open PRs, which
lanes hold a worktree, the CPU window). The first live attempt showed exactly that — the
`feat-258-invoice-prefix` row moved from `skip (a lane holds it)` to `keep (open PR ...)`
between two runs four minutes apart, and the admission reason changed with the machine. The
script therefore copies the legacy file and retargets its hardcoded constants (`REPO`,
`WT_ROOT`, `STATE`, `PIDFILE`) at a fixture, which is the only way to hand both versions the
same input. The live transcripts stay in `raw/` as a supplement. Only the live measurement is
masked (`budget=`, `load %`, the admission reason); every other byte is compared.

The deterministic half runs in CI as `parity.test.ts`, against the frozen legacy sources: slot
`status`, slot `release`, and the wake's no-herdr path.

### The ablation proof — every new guard has a case that reddens when it is deleted

```
command   bash .scratch/verification/262/raw/run-ablation.sh
expect    4 mutations, each producing FAIL lines in the selftest that covers it
observed  pickup-guard 3 FAIL, clean-guard 3 FAIL, loop-parse 4 FAIL, slot-atomic 1 FAIL; all files restored afterwards (git status clean)
cwd       the worktree root
```

The pickup mutation prints the historical bug verbatim — with the guard deleted, the run
proceeds and the command recorded is `herdr agent prompt issue-262-x  --wait`: an EMPTY
prompt, which herdr accepts at exit 0. That is the failure the ticket describes, reproduced
on demand.

The slot mutation is the interesting one, because the FIRST version of that case was vacuous.
With two lanes and one slot, the queue order means only the oldest lane ever attempts the
`mkdir`, so a non-atomic claim still looked correct. Four lanes and two slots (asserting two
distinct slot names) is what makes the mutation visible:
`won=slot1,slot1,slot1,slot1 losers=0`.

## 3. Deliberate deltas

1. `crew-pickup` validates the launch message BEFORE `herdr worktree create`. The shell checked
   `[ -z "$MSG" ]` after the worktree existed and the agent had started, so the refusal left a
   REGISTERED worktree behind and the next tick read that as "a lane has it", removed the
   ticket from the queue and never retried.
2. `[pickup] queue:` prints bare numbers (`queue: 999 998 997 `), not `#999`. Found by the
   fixture diff — the live queue was empty every time the two versions were compared.
3. A lane that stops waiting gives up its slot ticket. `e2e-slot-guard.ts` calls
   `acquire --no-wait` on every heavy run, so the shell's 2-minute leftover ticket blocked the
   next lane's acquire.
4. `hostPath` now knows MSYS `/tmp` and the display path is kept separate from the fs path.
5. `crew-loop status` reports a live pid as running: MSYS `kill -0` cannot see a native pid
   (`kill: (22976) - No such process` while `tasklist` shows `bun.exe` 22976 alive), so the
   shell called a running loop dead and `start` would add a second one.
6. The launch message's line separator is LF; the shell's literal carried the repo's CRLF.

## 4. Mistakes, and how many times

- The fixture queue was first seeded WITHOUT `CREW_QUEUE_DIR`, so `crew-queue.ts` fell back to
  `CREW_REPO` and wrote three fake issues (#999/#998/#997) into the REAL queue — **1
  occurrence**, spotted in the same run and undone with `crew-queue.ts remove`; the live queue
  is back to its single pre-existing entry. The lesson is in the design doc: a fixture script
  that inherits the harness' env vars writes the live harness.
- Two variable-rename slips in `realEnv` (`sessionDir` referenced after being renamed to
  `sessionRaw`; `briefDir` used inside a closure without being hoisted) — **2 occurrences of
  the same shape**. Both were caught by the end-to-end diff-proof, not by the selftests,
  because the selftests drive the injected env and `realEnv`'s own body is only exercised by a
  real run. One of them was swallowed by a `catch { return [] }` and produced the plausible
  answer "no brief declares it" for a brief that was on disk — the bare-`except` failure the
  ticket is about, reproduced in its own port.
- The first slot atomicity case was vacuous (2 lanes, 1 slot) — **1 occurrence**, caught by
  running the mutation instead of trusting the green.

## 5. Not done, and why

- `crew-repo.sh`, `launch-lane.sh`, `gh-pr-watch.sh`, `gh-pr-watch-settle.sh`,
  `gh-run-watch.sh`: none is on the hot path the acceptance criterion names. `gh-pr-watch.sh` is
  already superseded for Greptile by `crew-pr-watch.ts` (the loop calls that one) and
  `launch-lane.sh`'s job is inside pickup. Each is independently verifiable, which is the
  ticket's own rule, so they are a follow-up rather than a second sitting.
- `scripts/crew/**` is not in `bun run typecheck`: the repo has no root tsconfig and
  `@types/bun` lives under `apps/api`. Wiring it needs a root devDependency, which is a
  dependency decision, not a script conversion.
- **Acceptance criterion 4 (a full pipeline cycle: lane picked up, launched, reports, PR
  created) is not run.** It requires the live harness: the loop, a real queue item, a real
  lane. Doing it from a lane would launch a sibling lane against this lane's own files and
  create a second PR for the same issue. What is proved instead is the pipeline's contract at
  every seam: pickup's `started=N` line (asserted in `crew-loop`'s cases and through a real
  child process), the slot quartet the guard parses, and the launch message's contents.
- **Install steps for the parent** (not run here, because bash reads a running script
  incrementally and the loop is live): after the PR merges and the main repo is on a branch
  carrying `scripts/crew/`, move the five untracked `.sh` files aside, `git pull`, then
  `cp scripts/crew/herdr-wake.sh ~/.pi/agent/bin/herdr-wake.sh`. Until then the main repo keeps
  running its own copies.
- A **second writer** is editing the same scripts in `D:/projects/mani-project`
  (`.scratch/scripts/crew-loop.sh` is shimmed to its own `crew-loop.ts`; `crew-github.ts`,
  `dehardcode-repo.ts` are new). This lane touched nothing there. The parent decides which
  conversion becomes the source of truth before installing these shims.
