#!/usr/bin/env bun
// crew-clean.ts — burn worktrees whose work is already merged and which no lane holds.
//
//   crew-clean.ts            # burn everything unused (keeps the main repo)
//   crew-clean.ts --keep a b # never touch these worktree names
//   crew-clean.ts --dry-run  # say what would go and how much it frees
//   crew-clean.ts --selftest # prove the guards, touch nothing outside a temp repo
//
// WHY THIS EXISTS: closing a lane after its PR merges used to leave the checkout
// behind, and sixteen of them quietly reached 2.9 GB. Freeing disk cannot depend on
// someone remembering -- it is the last step of "merged and closed", so it is a
// command with a rule rather than a habit.
//
// SAFETY, in order, because this is destructive:
//   1. the main repo is never touched;
//   2. a worktree with a running lane (a herdr workspace label matching its name) is
//      skipped -- never burn a checkout an agent is working in;
//   3. uncommitted files OUTSIDE .scratch/ are reported and the worktree is SKIPPED,
//      unless --force. Scratch and build artifacts are disposable; source is not;
//   4. **an OPEN PR blocks the burn.** A worktree whose branch has an open pull request
//      is kept, because review findings come back and the fix happens in THAT checkout.
//      Burning it mid-review costs a re-clone for no gain. The owner's rule, verbatim:
//      "you are not allowed to burn the worktree until you merge that PR or we give up
//      on it totally."
//   4b. unpushed commits block the burn too -- the branch would keep them, but the
//      checkout is the only place someone was working;
//   5. `--keep` is honoured, for anything else worth holding;
//   5. the branch is never deleted -- it lives in the shared .git, so burned
//      checkouts stay recoverable with `git worktree add`.
//
// The five guards are a pure function (`planClean`) over facts, because a destructive
// command whose order of checks can only be tested by running it is not tested. The
// shell version interleaved the checks with `echo`, `du` and `rm -rf`, so the only way
// to know guard 3 still fired was to try it on real work.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { hostPath, winPath } from "./host-path.ts";
import { check, report, type SelftestCase } from "./selftest.ts";

export const DEFAULT_REPO = "D:/projects/mani-project";
export const DEFAULT_WT_ROOT = "/d/projects/mani-worktrees";
export const OPEN_PR_REPO = "AmaraNecib/dockan";
/** Scratch and build artifacts are disposable; source is not. */
const DISPOSABLE = /^\.scratch\/|^\.dokan-port$|^\.e2e-data|^test-results\/|^\.e2e-video/u;

export type CleanOptions = { dryRun: boolean; force: boolean; keep: string[] };

/** What the guards need to know about one worktree. Gathered, then decided. */
export type WorktreeFacts = {
  path: string;
  name: string;
  /** "" or "HEAD" when the checkout is detached: then there is no branch to protect. */
  branch: string;
  laneHeld: boolean;
  openPr: boolean;
  unpushed: number;
  dirtySource: string[];
  sizeMb: string;
};

export type CleanAction =
  | { kind: "keep"; name: string; reason: string }
  | { kind: "skip"; name: string; reason: string; loud: boolean }
  | { kind: "burn"; name: string; sizeMb: string }
  | { kind: "would-burn"; name: string; sizeMb: string };

/**
 * The guards, in the order the header lists them. Order is the whole safety story:
 * `--keep` and a live lane are checked before anything consults git or the network,
 * and the dirty check comes last because it is the only one `--force` may override.
 */
export function planClean(facts: WorktreeFacts[], options: CleanOptions): CleanAction[] {
  const actions: CleanAction[] = [];
  for (const wt of facts) {
    if (options.keep.includes(wt.name)) {
      actions.push({ kind: "keep", name: wt.name, reason: "(--keep)" });
      continue;
    }
    if (wt.laneHeld) {
      actions.push({ kind: "skip", name: wt.name, reason: "(a lane holds it)", loud: false });
      continue;
    }
    if (wt.branch !== "" && wt.branch !== "HEAD") {
      if (wt.openPr) {
        actions.push({
          kind: "keep",
          name: wt.name,
          reason: `(open PR on ${wt.branch} -- review fixes happen here)`,
        });
        continue;
      }
      if (wt.unpushed > 0) {
        actions.push({ kind: "keep", name: wt.name, reason: `(unpushed commits on ${wt.branch})` });
        continue;
      }
    }
    if (!options.force && wt.dirtySource.length > 0) {
      actions.push({
        kind: "skip",
        name: wt.name,
        reason: `(uncommitted source: ${wt.dirtySource.join(" ")})`,
        // The shell shouted this one (`SKIP`) and whispered the others (`skip`): a
        // skipped lane is routine, skipped source is the thing worth reading.
        loud: true,
      });
      continue;
    }
    actions.push({
      kind: options.dryRun ? "would-burn" : "burn",
      name: wt.name,
      sizeMb: wt.sizeMb,
    });
  }
  return actions;
}

export type CleanDeps = {
  worktrees: () => string[];
  laneLabels: () => string[];
  branchOf: (path: string) => string;
  openPr: (branch: string) => boolean;
  unpushed: (path: string) => number;
  dirtySource: (path: string) => string[];
  sizeMb: (path: string) => string;
  remove: (path: string) => boolean;
  prune: () => void;
  dirSizeMb: (path: string) => string;
};

type Run = { stdout: string; code: number };

function run(command: string, args: string[], cwd: string): Run {
  const done = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  return { stdout: done.stdout ?? "", code: done.status ?? -1 };
}

export function realDeps(repo: string, wtRoot: string, platform: string = process.platform): CleanDeps {
  const repoPath = hostPath(repo, platform);
  const rootPath = hostPath(wtRoot, platform);
  const sizeOf = (path: string): string => {
    const done = run("du", ["-sm", path], repoPath);
    return done.stdout.split(/\s+/u)[0] ?? "";
  };
  return {
    worktrees: () => {
      const done = run("git", ["worktree", "list", "--porcelain"], repoPath);
      const paths = done.stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length).trim());
      return paths.slice(1);
    },
    laneLabels: () => {
      const done = run("herdr", ["workspace", "list"], repoPath);
      if (done.code !== 0) return [];
      try {
        // SAFETY: `herdr workspace list` is the harness' own JSON; a shape change
        // drops to no lanes, which is the conservative side for a destructive burn.
        const parsed = JSON.parse(done.stdout) as { result?: { workspaces?: { label?: string }[] } };
        return (parsed.result?.workspaces ?? []).map((w) => w.label ?? "");
      } catch {
        return [];
      }
    },
    branchOf: (path) => run("git", ["rev-parse", "--abbrev-ref", "HEAD"], path).stdout.trim(),
    openPr: (branch) => {
      const done = run(
        "gh",
        ["pr", "list", "--repo", OPEN_PR_REPO, "--head", branch, "--state", "open", "--json", "number", "--jq", "length"],
        repoPath,
      );
      return done.stdout.trim() !== "0" && done.stdout.trim() !== "";
    },
    unpushed: (path) => {
      const done = run("git", ["log", "--oneline", "@{upstream}..HEAD"], path);
      if (done.stdout.trim() === "") return 0;
      return done.stdout.trim().split("\n").length;
    },
    dirtySource: (path) => {
      const done = run("git", ["status", "--porcelain"], path);
      return done.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => line.trim().split(/\s+/u).slice(-1)[0] ?? "")
        .filter((file) => file !== "" && !DISPOSABLE.test(file))
        .slice(0, 3);
    },
    sizeMb: sizeOf,
    remove: (path) => {
      run("git", ["worktree", "remove", "--force", path], repoPath);
      if (existsSync(path)) {
        run("cmd", ["/c", "rmdir", "/s", "/q", winPath(path, platform)], repoPath);
      }
      return !existsSync(path);
    },
    prune: () => {
      run("git", ["worktree", "prune"], repoPath);
    },
    dirSizeMb: () => sizeOf(rootPath),
  };
}

export type CleanResult = { burned: number; kept: number; skipped: number; before: string; after: string };

export function runClean(deps: CleanDeps, options: CleanOptions, out: (line: string) => void): CleanResult {
  const labels = deps.laneLabels();
  const before = deps.dirSizeMb();
  const facts: WorktreeFacts[] = deps.worktrees().map((path) => {
    const name = basename(path);
    return {
      path,
      name,
      branch: deps.branchOf(path),
      laneHeld: labels.includes(name),
      openPr: false,
      unpushed: 0,
      dirtySource: [],
      sizeMb: "",
    };
  });
  // The git and network probes are only consulted for a worktree the cheap guards
  // already admitted, so a burn run does not ask GitHub about a lane-held checkout.
  for (const wt of facts) {
    if (options.keep.includes(wt.name) || wt.laneHeld) continue;
    if (wt.branch === "" || wt.branch === "HEAD") continue;
    wt.openPr = deps.openPr(wt.branch);
    if (!wt.openPr) wt.unpushed = deps.unpushed(wt.path);
  }
  for (const wt of facts) {
    if (wt.openPr || wt.unpushed > 0 || wt.branch === "" || wt.branch === "HEAD") continue;
    wt.dirtySource = deps.dirtySource(wt.path);
    wt.sizeMb = deps.sizeMb(wt.path);
  }

  const actions = planClean(facts, options);
  let burned = 0;
  let kept = 0;
  let skipped = 0;
  for (const action of actions) {
    const wt = facts.find((item) => item.name === action.name);
    switch (action.kind) {
      case "keep":
        out(`  keep   ${action.name} ${action.reason}`);
        kept += 1;
        break;
      case "skip":
        out(`  ${action.loud ? "SKIP  " : "skip  "} ${action.name} ${action.reason}`);
        skipped += 1;
        break;
      case "would-burn":
        out(`  would burn ${action.name} (${action.sizeMb} MB)`);
        burned += 1;
        break;
      case "burn": {
        const gone = wt !== undefined && deps.remove(wt.path);
        if (!gone) {
          out(`  STUCK  ${action.name} (could not remove)`);
          skipped += 1;
          break;
        }
        out(`  burned ${action.name} (${action.sizeMb} MB)`);
        burned += 1;
        break;
      }
    }
  }
  deps.prune();
  const after = deps.dirSizeMb();
  out("");
  out(`  burned=${String(burned)} kept=${String(kept)} skipped=${String(skipped)}`);
  if (!options.dryRun && before !== "" && after !== "") {
    const freed = Number.parseInt(before, 10) - Number.parseInt(after, 10);
    out(`  freed ${String(freed)} MB (worktrees now ${after} MB)`);
  }
  out("  branches are kept: recover any checkout with git worktree add <path> <branch>");
  return { burned, kept, skipped, before, after };
}

// ------------------------------------------------------------------ selftest

function facts(patch: Partial<WorktreeFacts>): WorktreeFacts {
  return {
    path: "D:/projects/mani-worktrees/lane",
    name: "lane",
    branch: "issue-1-lane",
    laneHeld: false,
    openPr: false,
    unpushed: 0,
    dirtySource: [],
    sizeMb: "12",
    ...patch,
  };
}

const burn: CleanOptions = { dryRun: false, force: false, keep: [] };

function kinds(actions: CleanAction[]): string {
  return actions.map((action) => action.kind).join(",");
}

function git(cwd: string, args: string[]): number {
  return run("git", args, cwd).code;
}

/** A throwaway repo with one dirty and one clean worktree, on a temp path. */
type Fixture = { repo: string; dirty: string; clean: string };

function realFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "crew-clean-selftest-"));
  const repo = join(root, "repo");
  const dirty = join(root, "dirty-lane");
  const clean = join(root, "clean-lane");
  const lanesToAdd: [string, string][] = [
    [dirty, "dirty-lane"],
    [clean, "clean-lane"],
  ];
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "develop"]);
  writeFileSync(join(repo, "tracked.txt"), "one\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["-c", "user.email=selftest@example.invalid", "-c", "user.name=selftest", "commit", "-q", "-m", "base"]);
  for (const [path, branch] of lanesToAdd) {
    git(repo, ["worktree", "add", "-q", "-b", branch, path]);
  }
  writeFileSync(join(dirty, "unsaved-source.ts"), "// work nobody committed\n");
  mkdirSync(join(dirty, ".scratch"), { recursive: true });
  writeFileSync(join(dirty, ".scratch", "scratch.txt"), "disposable\n");
  return { repo, dirty, clean };
}

export function cleanSelftest(): SelftestCase[] {
  const cases: SelftestCase[] = [];

  cases.push(
    check(
      "--keep beats a lane hold and reports the reason",
      kinds(planClean([facts({ name: "keepme", laneHeld: true })], { ...burn, keep: ["keepme"] })) === "keep",
      kinds(planClean([facts({ name: "keepme", laneHeld: true })], { ...burn, keep: ["keepme"] })),
    ),
  );
  cases.push(check("a lane-held worktree is skipped", kinds(planClean([facts({ laneHeld: true })], burn)) === "skip", kinds(planClean([facts({ laneHeld: true })], burn))));
  cases.push(check("an open PR blocks the burn", kinds(planClean([facts({ openPr: true })], burn)) === "keep", kinds(planClean([facts({ openPr: true })], burn))));
  cases.push(check("unpushed commits block the burn", kinds(planClean([facts({ unpushed: 2 })], burn)) === "keep", kinds(planClean([facts({ unpushed: 2 })], burn))));
  cases.push(check("THE property: uncommitted source refuses the burn", kinds(planClean([facts({ dirtySource: ["src/a.ts"] })], burn)) === "skip", kinds(planClean([facts({ dirtySource: ["src/a.ts"] })], burn))));
  cases.push(check("--force overrides only the dirty check", kinds(planClean([facts({ dirtySource: ["src/a.ts"] })], { ...burn, force: true })) === "burn", kinds(planClean([facts({ dirtySource: ["src/a.ts"] })], { ...burn, force: true }))));
  cases.push(check("--force does not override a lane or an open PR", kinds(planClean([facts({ dirtySource: ["src/a.ts"], laneHeld: true, openPr: true })], { ...burn, force: true })) === "skip", kinds(planClean([facts({ dirtySource: ["src/a.ts"], laneHeld: true, openPr: true })], { ...burn, force: true }))));
  cases.push(check("--dry-run plans the burn and removes nothing", kinds(planClean([facts({})], { ...burn, dryRun: true })) === "would-burn", kinds(planClean([facts({})], { ...burn, dryRun: true }))));
  cases.push(check("a detached checkout has no branch to protect, so it is not kept for an open PR", kinds(planClean([facts({ branch: "HEAD", openPr: true })], burn)) === "burn", kinds(planClean([facts({ branch: "HEAD", openPr: true })], burn))));
  cases.push(check("the guard order reports --keep before a lane hold", planClean([facts({ laneHeld: true })], { ...burn, keep: ["lane"] })[0]?.kind === "keep", kinds(planClean([facts({ laneHeld: true })], { ...burn, keep: ["lane"] }))));
  cases.push(check("DISPOSABLE: .scratch, .e2e-data and test-results are not source", [".scratch/x", ".e2e-data/y", "test-results/z"].every((file) => DISPOSABLE.test(file)) && !DISPOSABLE.test("src/a.ts"), "scratch filter"));

  // Real git, real worktree remove, real guards: the decision function above is only
  // as good as the facts the real probes hand it.
  const fixture = realFixture();
  const deps: CleanDeps = {
    ...realDeps(fixture.repo, dirname(fixture.dirty)),
    worktrees: () => [fixture.dirty, fixture.clean],
    laneLabels: () => [],
    openPr: () => false,
    unpushed: () => 0,
  };
  const lines: string[] = [];
  runClean(deps, { ...burn, dryRun: true }, (line) => lines.push(line));
  const text = lines.join("\n");
  cases.push(
    check(
      "real git: a worktree with uncommitted source is SKIPped, the clean one would burn",
      text.includes(`  SKIP   dirty-lane (uncommitted source: unsaved-source.ts)`) && text.includes("  would burn clean-lane (") && text.includes("  burned=1 kept=0 skipped=1"),
      text,
    ),
  );
  cases.push(check("real git: a dry run leaves both directories in place", existsSync(fixture.dirty) && existsSync(fixture.clean), "dry run removed something"));

  const burnLines: string[] = [];
  const burned = runClean(deps, burn, (line) => burnLines.push(line));
  cases.push(
    check(
      "real git: the burn removes the clean worktree and keeps the dirty one",
      !existsSync(fixture.clean) &&
        existsSync(fixture.dirty) &&
        burned.burned === 1 &&
        burned.skipped === 1 &&
        burnLines.join("\n").includes("  burned clean-lane ("),
      burnLines.join("\n"),
    ),
  );

  const forcedLines: string[] = [];
  runClean(deps, { ...burn, force: true }, (line) => forcedLines.push(line));
  cases.push(
    check(
      "real git: --force burns the dirty worktree and says nothing was kept",
      !existsSync(fixture.dirty) && forcedLines.join("\n").includes("  burned dirty-lane ("),
      forcedLines.join("\n"),
    ),
  );

  rmSync(dirname(fixture.repo), { recursive: true, force: true });
  return cases;
}

// ----------------------------------------------------------------------- CLI

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--selftest") return report(cleanSelftest());
  const options: CleanOptions = { dryRun: false, force: false, keep: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--keep") {
      i += 1;
      const name = argv[i];
      if (name === undefined) {
        console.error("usage: crew-clean.ts [--dry-run] [--force] [--keep NAME...]");
        return 2;
      }
      options.keep.push(name);
    } else {
      console.error("usage: crew-clean.ts [--dry-run] [--force] [--keep NAME...]");
      return 2;
    }
  }
  const repo = process.env.CREW_REPO ?? DEFAULT_REPO;
  const wtRoot = process.env.CREW_WT_ROOT ?? DEFAULT_WT_ROOT;
  runClean(realDeps(repo, wtRoot), options, (line) => {
    console.log(line);
  });
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
