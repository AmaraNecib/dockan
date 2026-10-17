import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The guard behind issue #259's first acceptance criterion: "this rule is
// discoverable". A doc nobody links to is not discoverable, and deleting the doc
// or dropping a lane's link is a silent regression that no other gate sees. This
// suite is cheap, runs inside `bun run test` (`turbo test` then `bun test
// ./scripts/`), and fails on the current tree with a message that names the file
// that drifted. The scripted half of the gate (`crew-mergeable.ts`) is
// harness-local and untracked, so it is deliberately NOT read here: asserting on
// it would fail in CI where `.scratch/**` does not exist.
const ROOT = join(import.meta.dir, "..");
const DOC = join(ROOT, "docs", "verification-and-merge-gate.md");
const DOC_REF = "verification-and-merge-gate.md";

// Every tracked file a lane reads on the way to the gate. The lane launch prompt
// and the brief template are harness-local too, so these are the tracked stand-ins.
const LANE_READERS = [
  "docs/engineering-workflow.md",
  "AGENTS.md",
  ".agents/skills/feature-implement/SKILL.md",
] as const;

// The load-bearing literals, not the prose around them. If a rewording keeps the
// rule and drops one of these, the rule changed and the test should say so.
const REQUIRED_FACTS: [name: string, fragment: string][] = [
  ["the evidence marker", "<!-- crew-evidence -->"],
  ["reason 1 (5/5)", "Greptile confidence is 5/5"],
  ["reason 2 (head anchor)", "Last reviewed commit` equals the current head SHA"],
  ["reason 3 (nothing after the verdict)", "No comment lands after the verdict"],
  ["reason 4 (evidence at head)", "An evidence comment is present"],
  ["the visual evidence form", "before/after images **and** a video at real user pace"],
  ["the non-visual evidence form", "the failing-first run"],
];

const read = (relative: string) => readFileSync(join(ROOT, relative), "utf8");

describe("the verification rule is discoverable (#259)", () => {
  test("the canonical doc exists", () => {
    const doc = readFileSync(DOC, "utf8");
    expect(doc.length).toBeGreaterThan(500);
  });

  for (const laneFile of LANE_READERS) {
    test(`${laneFile} links to the canonical doc`, () => {
      // A lane can only find the rule if the file it already reads points at it.
      expect(read(laneFile)).toContain(DOC_REF);
    });
  }

  for (const [name, fragment] of REQUIRED_FACTS) {
    test(`the canonical doc carries ${name}`, () => {
      // Each of the four reasons and both evidence forms must survive an edit.
      expect(readFileSync(DOC, "utf8")).toContain(fragment);
    });
  }
});
