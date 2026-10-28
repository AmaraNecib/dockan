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
  ["reason 1 (5/5)", "The review confidence is 5/5"],
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

  test("the A/B protocol keeps paired evidence and an owner-controlled end", () => {
    const comparison = read("docs/review-comparison.md");
    for (const fact of [
      "Continue across PRs until the owner chooses",
      "same base SHA and head SHA",
      "before reading the other system's findings",
      "Both current-head reviews must be 5/5",
      "one request per head",
      "not an automatic replacement",
      "verified unique defects",
      "false positives",
      "elapsed review time",
      "unknown rather than zero",
    ]) expect(comparison).toContain(fact);
    expect(read(".agents/skills/guard/SKILL.md")).toContain(
      "Both current-head reviews are 5/5 with no actionable findings",
    );
  });

  test("review entry points link to the A/B protocol", () => {
    for (const [file, link] of [
      ["docs/engineering-workflow.md", "review-comparison.md"],
      ["docs/verification-and-merge-gate.md", "review-comparison.md"],
      [".agents/skills/feature-implement/SKILL.md", "../../../docs/review-comparison.md"],
      [".agents/skills/reviewloop/SKILL.md", "../../../docs/review-comparison.md"],
      [".agents/skills/guard/SKILL.md", "../../../docs/review-comparison.md"],
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
