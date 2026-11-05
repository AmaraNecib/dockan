import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// The guard behind issue #259's first acceptance criterion: "this rule is
// discoverable". A doc nobody links to is not discoverable, and deleting the doc
// or dropping a lane's link is a silent regression that no other gate sees. This
// suite is cheap, runs inside `bun run test` (`turbo test` then `bun test
// ./scripts/`), and fails on the current tree with a message that names the file
// that drifted. The scripted half of the gate (`crew-mergeable.ts`) is
// harness-local and untracked, so it is deliberately NOT read here: asserting on
// it would fail in CI where `.scratch/scripts/**` does not exist.
//
// The link check resolves the markdown target on disk, not a substring: a bare
// mention of the filename, a fenced path, or a link to a missing file is not a
// lane finding the rule, and a substring check passed all three (#259 test-audit).
const ROOT = join(import.meta.dir, "..");
const DOC_FILE = "verification-and-merge-gate.md";
const DOC = resolve(ROOT, "docs", DOC_FILE);

// Every tracked file a lane reads on the way to the gate. The lane launch prompt
// and the brief template are harness-local too, so these are the tracked stand-ins.
const LANE_READERS = [
  "docs/engineering-workflow.md",
  "AGENTS.md",
  ".agents/skills/feature-implement/SKILL.md",
] as const;

// The load-bearing facts, not the prose around them: a reworded sentence that
// keeps the rule must pass, but dropping the rule itself must fail. Every
// fragment is a single line, so Windows CRLF cannot split one in half.
const REQUIRED_FACTS: [name: string, fragment: string][] = [
  ["the evidence marker", "<!-- crew-evidence -->"],
  ["reason 1 (5/5)", "The local review confidence is 5/5"],
  ["reason 2 (the field)", "Last reviewed commit"],
  ["reason 2 (the head anchor)", "equals the current head SHA"],
  ["reason 3 (nothing after the verdict)", "No comment lands after the verdict"],
  ["reason 4 (evidence present)", "An evidence comment is present"],
  ["reason 4 (bound to the head)", "at the head being merged"],
  ["the cardinality (all four, not three)", "hold. Not three"],
  ["the visual form: images", "before/after images"],
  ["the visual form: a clip at real user pace", "video at real user pace"],
  ["the non-visual form: failing-first", "the failing-first run"],
  ["the non-visual form: ablation proof", "ablation/mutation proof"],
  ["the AUTO class", "inert diff"],
  ["the AUTO limit (no waiver)", "waives neither reason 4"],
  ["the OWNER class", "production code"],
  ["the MERGED outcome", "is a fourth outcome"],
];

const read = (relative: string) => readFileSync(join(ROOT, relative), "utf8");

/**
 * Drop fenced code blocks and inline code spans. A link shown as an *example* is
 * not a link a lane can click, and a substring match inside a fence stayed green
 * while every lane's real link was gone.
 */
function withoutCode(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]*`/g, "");
}

/** True when `content` links to the canonical doc and the link target exists. */
export function linksToDoc(content: string, fromFile: string): boolean {
  // Accept the legal markdown destination forms a lane might use: a bare path, an
  // angle-bracket path, and either with a title. Reference-style links are not
  // matched; none of the three lane files uses them, and a miss reddens loudly
  // rather than passing a broken link.
  for (const match of withoutCode(content).matchAll(/\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g)) {
    const target = (match[1] ?? match[2] ?? "").split("#")[0] ?? "";
    // The target must BE the canonical doc, not merely share its basename: a
    // link to another `verification-and-merge-gate.md` kept the old check green.
    if (resolve(ROOT, dirname(fromFile), target) === DOC) return true;
  }
  return false;
}

describe("the verification rule is discoverable (#259)", () => {
  test("the canonical doc exists", () => {
    const doc = readFileSync(DOC, "utf8");
    expect(doc.length).toBeGreaterThan(500);
  });

  for (const laneFile of LANE_READERS) {
    test(`${laneFile} links to the canonical doc`, () => {
      // A lane can only find the rule if the file it already reads links to a
      // target that resolves. A mention, or a link to a deleted path, is not it.
      expect(linksToDoc(read(laneFile), laneFile)).toBe(true);
    });
  }

  for (const [name, fragment] of REQUIRED_FACTS) {
    test(`the canonical doc carries ${name}`, () => {
      // Each of the four reasons and both evidence forms must survive an edit.
      expect(readFileSync(DOC, "utf8")).toContain(fragment);
    });
  }

  test("lean local review cannot retire the owner-controlled hosted verdict gate", () => {
    const comparison = read("docs/review-comparison.md");
    expect(comparison).toContain("Until the owner explicitly ends the trial");
    expect(comparison).toContain("both current-head verdicts must be 5/5");
    expect(comparison).toContain("Request Greptile once after pushing a new head");
    for (const file of ["docs/engineering-workflow.md", "docs/verification-and-merge-gate.md", ".agents/skills/guard/SKILL.md", ".agents/skills/feature-implement/SKILL.md", "AGENTS.md"]) {
      expect(read(file), file).toContain("docs/review-comparison.md".replace("docs/", ""));
      expect(read(file), file).not.toContain("no standing paired-review trial");
      expect(read(file), file).not.toContain("there is no paired-review requirement");
    }
  });

  test("local readiness stays distinct from CI acceptance until owner activation", () => {
    const workflow = read("docs/engineering-workflow.md");
    expect(workflow).toContain("required-check enforcement on the current PR head");
    expect(workflow).toContain("Other PRs retain the existing local baseline until the parent verifies activation");
    expect(workflow).toContain("Local readiness, a pending check and CI acceptance are distinct states");
    const ci = read("docs/ci.md").replace(/\s+/g, " ");
    expect(ci).toContain("exact check name `CI acceptance`");
    expect(ci).toContain("The aggregate cannot establish branch-protection settings or bypass policy itself");
  });

  test("pending activation retains executable local checks and requires the aggregate", () => {
    const guard = read(".agents/skills/guard/SKILL.md");
    const pending = guard.split("#### Before activation")[1]?.split("#### Browser verification")[0] ?? "";
    for (const command of ["bun run typecheck", "bun run lint", "bun run skills:check", "bun run test", "bun run --filter @dokan/web build", "bun audit --audit-level=high"]) {
      expect(pending, command).toContain(command);
    }
    expect(pending).toContain("other PRs");
    expect(pending).toContain("policy PR is the narrow bootstrap exception");
    expect(pending).toContain("focused policy tests");
    const manual = read("docs/ci.md").split("## Required checks")[1]?.split("## Desktop release")[0] ?? "";
    expect(manual).toContain("Select the exact `CI acceptance` check");
    expect(manual).toContain("bypass");
    expect(manual).not.toContain("Select the `typecheck, lint, test, audit`");
  });

  test("activated CI-final policy has no unconditional local acceptance mandate", () => {
    const feature = read(".agents/skills/feature-implement/SKILL.md");
    const guard = read(".agents/skills/guard/SKILL.md");
    const development = read("docs/development-workflow.md");
    expect(feature).not.toContain("Do not trade this for a focused test run and a typecheck");
    expect(guard).toContain("the selector defines CI scope, not a mandatory local full run");
    expect(development).toContain("The aggregate `CI acceptance` check is mandatory before merge");
    expect(guard).toContain("The worktree must be clean before handoff or publication");
  });

  test("CI acceptance stays mandatory while this policy change can publish pending proof", () => {
    const workflow = read("docs/engineering-workflow.md");
    const guard = read(".agents/skills/guard/SKILL.md");
    const gate = read("docs/verification-and-merge-gate.md");
    expect(workflow).toContain("The stable aggregate `CI acceptance` check is mandatory for merge");
    expect(workflow).toContain("this policy PR may be published after focused local proof and review");
    expect(workflow).toContain("It is not merge-ready and does not activate the new routine policy until the parent records remote enforcement");
    expect(guard).toContain("recorded owner acceptance of the bypass policy");
    for (const file of ["docs/engineering-workflow.md", "docs/verification-and-merge-gate.md", "docs/development-workflow.md", ".agents/skills/feature-implement/SKILL.md"]) {
      expect(read(file), file).toContain("recorded owner acceptance of the bypass policy");
    }
    expect(gate).toContain("CI acceptance is green on the current head");
    expect(gate).toContain("both current-head verdicts must be 5/5");
  });

  test("routine review is one focused execution; concrete risks select three lenses", () => {
    const workflow = read("docs/engineering-workflow.md").replace(/\s+/g, " ");
    const reviewloop = read(".agents/skills/reviewloop/SKILL.md");
    expect(workflow).toContain("one fresh `code-review` context");
    expect(workflow).toContain("Standards, Spec and affected-test adequacy");
    expect(workflow).toContain("three distinct sessions initially");
    for (const risk of ["CI", "security", "schema", "dependency", "money", "recovery", "auth", "crypto", "release"]) {
      expect(workflow.toLowerCase()).toContain(risk.toLowerCase());
    }
    expect(workflow).not.toContain("Standard otherwise uses all three lenses");
    expect(reviewloop).toContain("A routine reversible localized change gets one fresh `code-review` session");
    expect(reviewloop).toContain("Record only executions that actually happened");
    const debate = read(".agents/skills/debate/SKILL.md");
    expect(debate).toContain("Run one reviewer session with explicit critic and defender sections");
    expect(debate).not.toContain("Run two parallel reviewer sub-agents");
    expect(debate).not.toContain("critic + defender sub-agents");
  });

  test("a review fix gets one bounded fresh review without a full restart", () => {
    const workflow = read("docs/engineering-workflow.md");
    const reviewloop = read(".agents/skills/reviewloop/SKILL.md");
    expect(workflow).toContain("one fresh reviewer to inspect the combined delta and direct affected callers");
    expect(workflow).toContain("explicitly carries forward unchanged conclusions");
    expect(workflow).toContain("Rerun another lens only if the fix creates a concrete risk");
    expect(reviewloop).toContain("Do not restart every lens after a bounded fix");
    expect(reviewloop).toContain("no unresolved actionable finding may remain");
    expect(reviewloop).toContain("A 5/5 with zero unresolved actionable findings remains mandatory");
  });

  test("local payload recovery and rendering precede worker handoff", () => {
    const feature = read(".agents/skills/feature-implement/SKILL.md");
    expect(feature).toContain("| Local review payload missing or stale | Steps 7–9 before Guard Phase 2 |");
    expect(feature).toContain("The handoff may supply the author account; a fresh author-review session is not required.");
    const workflow = read("docs/engineering-workflow.md");
    const lifecycle = workflow.match(/## Feature lifecycle\r?\n\r?\n```\r?\n([\s\S]*?)```/)?.[1];
    expect(lifecycle).toBeDefined();
    const steps = [
      "Commit complete reviewable scope",
      "Risk-sized local review",
      "Local reviewloop payload and 5/5",
      "Guard Phase 2 — verify committed HEAD",
      "Handoff verified SHA and local evidence",
      "Push + open PR",
      "CI acceptance — required on the current head before merge",
    ];
    const positions = steps.map((step) => (lifecycle ?? "").indexOf(step));
    let previous = -1;
    for (const position of positions) {
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
    expect(feature).toContain("Commit the complete reviewable scope before step 6");
  });

  test("finding dispositions and refinements cannot bypass review gates", () => {
    const workflow = read("docs/engineering-workflow.md");
    const gate = workflow.match(/^- \*\*A bounded fix gets one bounded review\.[^\r\n]*/m)?.[0] ?? "";
    for (const fact of [
      "one fresh reviewer to inspect the combined delta and direct affected callers",
      "explicitly carries forward unchanged conclusions",
      "Never clear or defer an actionable finding",
    ]) expect(gate).toContain(fact);
    const refinement = workflow.match(/^- \*\*Small related refinements[^\r\n]*/m)?.[0] ?? "";
    for (const fact of [
      "serve the same acceptance goal, stay localized",
      "add no behavior, risk, decision, dependency or architecture scope",
      "optional only when the reviewer accepts its disposition and applicable gates allow it",
    ]) expect(refinement).toContain(fact);
    const skill = read(".agents/skills/reviewloop/SKILL.md");
    const resolution = skill.split("### 5. Verify and resolve findings")[1]?.split("### 6.")[0] ?? "";
    for (const fact of [
      "hold dependent work for substantial blockers",
      "reviewer resolution",
      "no unresolved actionable finding may remain at any score",
      "Do not hide one in `summary.dismissed`",
    ]) expect(resolution).toContain(fact);
  });

  test("shared implementation ownership retains every safety condition", () => {
    const agents = read("AGENTS.md");
    const ownership = agents.match(/^\*\*One writer owns[^\r\n]*/m)?.[0] ?? "";
    for (const fact of [
      "One writer owns the PR worktree at a time",
      'one implementation worker with `delegate_task` and `isolation: "shared"`',
      "the parent gives up edits while the worker owns it",
      "Reviewers may share the same tree read-only at the pinned head",
      "Freeze source during final verification and review",
      "Before replacing a writer, cancel it and confirm it stopped",
      "never use the shared project root for concurrent writes",
    ]) expect(ownership).toContain(fact);
  });

  test("same-family fallback records standing approval without waiving gates", () => {
    const skill = read(".agents/skills/reviewloop/SKILL.md").replace(/\s+/g, " ");
    for (const fact of [
      "when OpenCode is unavailable, same-family review is allowed without asking again per PR",
      "Prefer an enabled working non-author family; otherwise use separate reviewer sessions",
      "not model-family-independent reviews",
      '"approvedBy": "owner"',
      "It waives neither required lenses nor current-head 5/5",
    ]) expect(skill).toContain(fact);
  });

  test("review entry points link to the A/B protocol", () => {
    for (const [file, link] of [
      ["docs/engineering-workflow.md", "verification-and-merge-gate.md"],
    ] as const) expect(read(file)).toContain(`](${link})`);
  });

  test("diagram guidance covers inclusion, omission and code-backed edges", () => {
    expect(read(".agents/skills/reviewloop/SKILL.md")).toContain(
      "](../../../docs/review-diagrams.md)",
    );
    const guide = read("docs/review-diagrams.md");
    for (const fact of [
      "Keep summary.diagram optional",
      "Include a diagram whenever",
      "even when it repeats the text summary",
      "independently collapsible and open by default",
      "require 5/5 for a pass",
      "control flow, data flow, state transitions or interaction order",
      "Omit the field",
      "Verify every node and edge against the pinned code",
      "not a diagram-selection algorithm",
    ]) expect(guide).toContain(fact);
  });

  test("native findings remain commit-linked and are not resolved just for being outdated", () => {
    expect(read(".agents/skills/reviewloop/SKILL.md")).toContain(
      "](../../../docs/review-findings.md)",
    );
    const protocol = read("docs/review-findings.md");
    for (const fact of [
      "native GitHub pull-request review comments",
      "commit_id",
      "Outdated is not fixed",
      "reply with the fixing commit and the regression proof",
      "before retrying",
      "Findings outside eligible changed lines",
    ]) expect(protocol).toContain(fact);
  });

  test("a link to a same-named file elsewhere is not the canonical doc", () => {
    // `endsWith(DOC_FILE)` accepted any existing file with the same basename, so a
    // lane could point its readers at a different file and stay green. The fix
    // resolves the target and compares it to DOC, so a same-named decoy must fail.
    const decoyDir = mkdtempSync(join(tmpdir(), "vrule-"));
    try {
      const decoy = join(decoyDir, DOC_FILE);
      writeFileSync(decoy, "# not the canonical doc\n");
      expect(existsSync(decoy)).toBe(true);
      expect(linksToDoc(`[the rule](<${decoy}>)`, "docs/engineering-workflow.md")).toBe(false);
    } finally {
      rmSync(decoyDir, { recursive: true, force: true });
    }
  });

  test("a link-shaped example in a fenced code block does not count", () => {
    // A fenced example is documentation about a link, not a link a lane can click.
    expect(linksToDoc("```md\n[x](docs/verification-and-merge-gate.md)\n```", "AGENTS.md")).toBe(
      false,
    );
  });

  test("a link-shaped example in an inline code span does not count", () => {
    expect(
      linksToDoc("see `[x](docs/verification-and-merge-gate.md)` for the syntax", "AGENTS.md"),
    ).toBe(false);
  });

  test("the AUTO and OWNER rows still name their own classes", () => {
    // The fragments above are present even if the two rows are swapped; this
    // keeps the class on the row that decides it. A swap would tell a lane to
    // merge production code without review while every fragment test stayed green.
    const lines = readFileSync(DOC, "utf8").split(/\r?\n/);
    // Only the decision table's own row counts: `OWNER` also appears in the prose
    // above the table, where it does not name the class.
    const rowFor = (verdict: string) =>
      lines.find((l) => l.startsWith("|") && l.includes(`\`${verdict}\``)) ?? "";
    expect(rowFor("AUTO")).toContain("inert");
    expect(rowFor("OWNER")).toContain("production code");
    expect(rowFor("REFUSED")).toContain("not a judgement call");
  });
});
