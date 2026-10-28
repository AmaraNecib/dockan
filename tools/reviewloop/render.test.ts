import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeScore,
  dedupe,
  independenceOf,
  isAnchored,
  modelFamily,
  parseDiff,
  renderBody,
  sameFamily,
  scoreOverride,
  validate,
  validateMerged,
  worse,
  type Finding,
  type Hunk,
  type Lens,
  type Payload,
} from "./render";

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "fixture-defect",
  lens: "debate",
  severity: "P2",
  title: "A defect",
  path: "apps/api/src/main.ts",
  line: 10,
  body: "Why it is wrong.",
  evidence: "self-evident: the hunk deletes the only write.",
  ...over,
});

const at = (over: Partial<Finding> & { anchored?: boolean } = {}) => ({
  ...finding(over),
  anchored: over.anchored ?? false,
});

describe("computeScore", () => {
  test("a clean review is 5/5", () => {
    expect(computeScore([])).toBe(5);
  });

  test("a P2 alone does not lower the score", () => {
    expect(computeScore([finding()])).toBe(5);
  });

  test("one P1 is 4/5", () => {
    expect(computeScore([finding({ severity: "P1" })])).toBe(4);
  });

  test("two P1s are 3/5", () => {
    expect(computeScore([finding({ severity: "P1" }), finding({ severity: "P1", line: 40 })])).toBe(3);
  });

  test("one P0 is 2/5", () => {
    expect(computeScore([finding({ severity: "P0" })])).toBe(2);
  });

  test("two P0s are 1/5", () => {
    expect(computeScore([finding({ severity: "P0" }), finding({ severity: "P0", line: 40 })])).toBe(1);
  });
});

describe("worse", () => {
  test("keeps the more severe level", () => {
    expect(worse("P0", "P2")).toBe("P0");
    expect(worse("P1", "P2")).toBe("P1");
    expect(worse("P2", "P2")).toBe("P2");
  });
});

describe("dedupe", () => {
  test("merges the same defect reported a line apart by two lenses", () => {
    const merged = dedupe([
      at({ lens: "debate", line: 10 }),
      at({ lens: "code-review", line: 11 }),
    ]);

    expect(merged).toHaveLength(1);
    const [first] = merged;
    expect(first?.lenses).toEqual(["debate", "code-review"]);
  });

  test("three lenses agreeing on a defect still promote it to P1", () => {
    const merged = dedupe([
      at({ lens: "debate" }),
      at({ lens: "test-audit" }),
      at({
        lens: "code-review",
        body: "A longer explanation of the same defect.",
        endLine: 10,
        suggestion: "```suggestion\nreplaceSameRange();\n```",
      }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.lenses).toHaveLength(3);
    expect(merged[0]?.severity).toBe("P1");
    expect(merged[0]?.line).toBe(10);
    expect(merged[0]?.endLine).toBeUndefined();
    expect(merged[0]?.suggestion).toBe("```suggestion\nreplaceSameRange();\n```");
    expect(computeScore(merged)).toBe(4);
  });

  test("a later, folded P0 cannot be lost behind an earlier P2", () => {
    const merged = dedupe([
      at({ lens: "debate", severity: "P2", line: 10 }),
      at({ lens: "code-review", severity: "P0", line: 11 }),
    ]);
    expect(merged[0]?.severity).toBe("P0");
    expect(computeScore(merged)).toBe(2);
    expect(worse("P2", "P1")).toBe("P1");
  });

  test("keeps two defects two lines apart separate", () => {
    const merged = dedupe([at({ lens: "debate", line: 10 }), at({ lens: "code-review", line: 12 })]);

    expect(merged).toHaveLength(2);
  });

  test.each([
    ["without IDs", undefined, undefined],
    ["with different IDs", "missing-null-guard", "wrong-error-code"],
  ])("keeps distinct adjacent cross-lens P1s %s", (_name, firstId, secondId) => {
    const merged = dedupe([
      at({ lens: "debate", severity: "P1", line: 10, title: "Missing null guard", id: firstId }),
      at({ lens: "code-review", severity: "P1", line: 11, title: "Wrong error code", id: secondId }),
    ]);

    expect(merged).toHaveLength(2);
    expect(computeScore(merged)).toBe(3);
    expect(merged.map((f) => f.title)).toContain("Wrong error code");
  });

  test("keeps two defects from one lens a line apart, and counts both", () => {
    const merged = dedupe([
      at({ lens: "debate", severity: "P1", line: 10, title: "First defect" }),
      at({ lens: "debate", severity: "P1", line: 11, title: "Second defect" }),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged.map((f) => f.title)).toContain("Second defect");
    expect(computeScore(merged)).toBe(3);
  });

  test("keeps the more severe level when two lenses disagree", () => {
    const merged = dedupe([
      at({ lens: "debate", severity: "P2", line: 10 }),
      at({ lens: "code-review", severity: "P1", line: 10 }),
    ]);

    const [first] = merged;
    expect(first?.severity).toBe("P1");
  });

  test("agreement promotes a P2 to P1", () => {
    const merged = dedupe([
      at({ lens: "debate", severity: "P2", line: 10 }),
      at({ lens: "code-review", severity: "P2", line: 10 }),
    ]);

    const [first] = merged;
    expect(first?.severity).toBe("P1");
  });

  test("agreement never invents a P0", () => {
    const merged = dedupe([
      at({ lens: "debate", severity: "P1", line: 10 }),
      at({ lens: "code-review", severity: "P1", line: 10 }),
    ]);

    const [first] = merged;
    expect(first?.severity).toBe("P1");
  });

  test("keeps a retained suggestion when a longer adjacent finding has a different range", () => {
    const retained = "```suggestion\nreplaceLineTen();\n```";
    const merged = dedupe([
      at({ lens: "debate", line: 10, suggestion: retained }),
      at({
        lens: "code-review",
        line: 11,
        body: "A much longer explanation from the adjacent line.",
        suggestion: "```suggestion\nreplaceLineEleven();\n```",
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.line).toBe(10);
    expect(merged[0]?.endLine).toBeUndefined();
    expect(merged[0]?.suggestion).toBe(retained);
    expect(merged[0]?.body).toBe("A much longer explanation from the adjacent line.");
  });

  test("omits a longer finding's suggestion when its end differs from the retained range", () => {
    const merged = dedupe([
      at({ lens: "debate", line: 10 }),
      at({
        lens: "code-review",
        line: 10,
        endLine: 11,
        body: "A much longer explanation for the two-line range.",
        suggestion: "```suggestion\nreplaceLinesTenAndEleven();\n```",
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.line).toBe(10);
    expect(merged[0]?.endLine).toBeUndefined();
    expect(merged[0]?.suggestion).toBeUndefined();
    expect(merged[0]?.body).toBe("A much longer explanation for the two-line range.");
  });

  test("borrows a suggestion when undefined and explicit single-line ends match", () => {
    const merged = dedupe([
      at({ lens: "debate", line: 10 }),
      at({
        lens: "code-review",
        line: 10,
        endLine: 10,
        body: "A longer explanation for the same single line.",
        suggestion: "```suggestion\nreplaceLineTen();\n```",
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.line).toBe(10);
    expect(merged[0]?.endLine).toBeUndefined();
    expect(merged[0]?.suggestion).toBe("```suggestion\nreplaceLineTen();\n```");
  });

  test("keeps findings from different files separate", () => {
    const merged = dedupe([at({ line: 10 }), at({ path: "apps/web/src/app.tsx", line: 10 })]);

    expect(merged).toHaveLength(2);
  });

  test("a merge never borrows the anchoring of the finding it folds in", () => {
    const merged = dedupe([
      at({ lens: "debate", line: 10, endLine: 100, anchored: false }),
      at({ lens: "code-review", line: 11, anchored: true }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.endLine).toBe(100);
    expect(merged[0]?.anchored).toBe(false);
  });
});

describe("modelFamily", () => {
  test("hyphenless and hyphenated root-version aliases are the same family", () => {
    expect(sameFamily("opencode/qwen3-coder", "opencode-go/qwen-3-coder")).toBe(true);
    expect(sameFamily("opencode/qwen2.5-coder", "opencode-go/qwen-3-coder")).toBe(true);
  });

  test("case differences cannot make the author's family independent", () => {
    const result = independenceOf(
      [{ name: "debate", model: "OPENCODE/DEEPSEEK-V4.1-FLASH-FREE" }],
      "opencode/deepseek-v4.1-flash-free",
    );
    expect(result.allowed).toBe(false);
  });
  test("free and paid DeepSeek are one family", () => {
    expect(modelFamily("opencode/deepseek-v4.1-flash-free")).toBe("deepseek");
    expect(modelFamily("opencode-go/deepseek-v4.1-flash")).toBe("deepseek");
  });

  test("a versionless id still matches its versioned siblings", () => {
    expect(sameFamily("opencode/deepseek-chat", "opencode-go/deepseek-v4.1-flash")).toBe(true);
    expect(sameFamily("opencode/glm-5.3-flash-free", "opencode-go/deepseek-v4.1-flash")).toBe(false);
    expect(sameFamily("opencode/beam-free", "opencode/beam-free")).toBe(true);
  });

  test("reads the family past the provider and a commit trailer prefix", () => {
    expect(modelFamily("pi/opencode-go/deepseek-v4.1-flash")).toBe("deepseek");
    expect(modelFamily("opencode/glm-5.3-flash-free")).toBe("glm");
    expect(modelFamily("opencode-go/glm-5.3-flash")).toBe("glm");
  });

  test("separates the other vendors", () => {
    expect(modelFamily("opencode/mimo-v2.6-flash-free")).toBe("mimo");
    expect(modelFamily("opencode-go/mimo-v2.6-flash")).toBe("mimo");
    expect(modelFamily("opencode/beam-free")).toBe("beam");
    expect(modelFamily("opencode-go/minimax-m3.1-flash")).toBe("minimax");
    expect(modelFamily("opencode/kimi-k3.1")).toBe("kimi");
  });
});

describe("independenceOf", () => {
  const author = "pi/opencode-go/deepseek-v4.1-flash";
  const on = (name: string, model: string): Lens => ({ name, model });

  test("one lens on another family is allowed", () => {
    const status = independenceOf([on("debate", "opencode/glm-5.3-flash-free")], author);

    expect(status.allowed).toBe(true);
    expect(status.families).toBe(1);
  });

  test("refuses a lens on the author's family, even under another ID", () => {
    const status = independenceOf([on("debate", "opencode/deepseek-v4.1-flash-free")], author);

    expect(status.allowed).toBe(false);
    expect(status.sameFamily).toEqual(["debate"]);
    expect(status.reason).toContain("deepseek");
  });

  test("refuses three lenses that are one family", () => {
    const status = independenceOf(
      [
        on("debate", "opencode/glm-5.3-flash-free"),
        on("test-audit", "opencode-go/glm-5.3-flash"),
        on("code-review", "opencode/glm-5.3-flash-free"),
      ],
      author,
    );

    expect(status.allowed).toBe(false);
    expect(status.families).toBe(1);
  });

  test("allows lenses on two other families", () => {
    const status = independenceOf(
      [on("debate", "opencode/glm-5.3-flash-free"), on("test-audit", "opencode/mimo-v2.6-flash-free")],
      author,
    );

    expect(status.allowed).toBe(true);
    expect(status.families).toBe(2);
  });

  test("refuses a mixed round that includes the author's family", () => {
    const status = independenceOf(
      [on("debate", "opencode/glm-5.3-flash-free"), on("test-audit", "opencode-go/deepseek-v4.1-flash")],
      author,
    );

    expect(status.allowed).toBe(false);
    expect(status.sameFamily).toEqual(["test-audit"]);
  });

  test("the owner's recorded approval allows the author's family", () => {
    const status = independenceOf([on("debate", "opencode-go/deepseek-v4.1-flash")], author, {
      approvedBy: "owner",
      reason: "only DeepSeek is available this week",
    });

    expect(status.allowed).toBe(true);
  });

  test("a skipped lens does not count as a review", () => {
    const status = independenceOf(
      [
        on("debate", "opencode/glm-5.3-flash-free"),
        { ...on("test-audit", "opencode-go/deepseek-v4.1-flash"), skipped: "no test files" },
      ],
      author,
    );

    expect(status.allowed).toBe(true);
    expect(status.families).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The refusal layer: what stops a payload from becoming a clean review
// ---------------------------------------------------------------------------

const HEAD = "deadbeefcafe";
let reports = "";

beforeAll(() => {
  reports = mkdtempSync(join(tmpdir(), "reviewloop-"));
});

afterAll(() => {
  rmSync(reports, { recursive: true, force: true });
});

function save(name: string, text: string) {
  const path = join(reports, `${HEAD}-${name}.md`);
  writeFileSync(path, text);
  return path;
}

const header = (
  reviewer = "opencode/glm-5.3-flash-free",
  author = "pi/opencode-go/deepseek-v4.1-flash",
) => `Reviewer model: ${reviewer}\nAuthor model:   ${author}\n\n# report\n\nNothing to add.\n`;

const payload = (over: Partial<Payload> = {}): Payload => ({
  authorModel: "pi/opencode-go/deepseek-v4.1-flash",
  lenses: over.lenses ?? [
    { name: "debate", model: "opencode/glm-5.3-flash-free", report: save("debate", header()) },
    {
      name: "code-review",
      model: "opencode/beam-free",
      report: save("code-review", header("opencode/beam-free")),
    },
  ],
  summary: { impact: "Medium", what: "A change.", verdict: "" },
  findings: [],
  ...over,
});

const diff: Hunk[] = [{ path: "apps/api/src/main.ts", ranges: [[10, 20]] }];

describe("validate", () => {
  test("accepts a round that names the head and the models that ran", () => {
    expect(() => validate(payload(), "p.json", diff, HEAD)).not.toThrow();
  });

  const invalidSemantics: Array<[string, (p: Payload) => Payload, RegExp]> = [
    ["empty author", (p) => ({ ...p, authorModel: " " }), /authorModel is required/],
    ["empty lens model", (p) => ({ ...p, lenses: [{ name: "debate", model: " " }] }), /has no model/],
    ["missing report", (p) => ({ ...p, lenses: [{ name: "debate", model: "glm", report: join(reports, "missing.md") }] }), /has no report/],
    ["blank defect ID", (p) => ({ ...p, findings: [finding({ id: " " })] }), /id must not be blank/],
    ["backward range", (p) => ({ ...p, findings: [finding({ line: 15, endLine: 5 })] }), /at or after line/],
    ["missing P1 evidence", (p) => ({ ...p, findings: [finding({ severity: "P1", evidence: "" })] }), /evidence is required/],
    ["empty summary", (p) => ({ ...p, summary: { ...p.summary, what: " " } }), /summary.what is required/],
  ];
  test.each(invalidSemantics)("refuses semantic input error: %s", (_name, change, message) => {
    expect(() => validate(change(payload()), "p.json", diff, HEAD)).toThrow(message);
  });

  test("refuses a finding attributed to a skipped lens", () => {
    const p = payload({
      lenses: [
        { name: "debate", model: "opencode/glm-5.3-flash-free", report: save("debate", header()) },
        { name: "test-audit", model: "opencode/mimo-v2.6-flash-free", skipped: "no tests changed" },
      ],
      findings: [finding({ lens: "test-audit" })],
    });

    expect(() => validate(p, "p.json", diff, HEAD)).toThrow(/did not run/);
  });

  test("refuses a report from another head", () => {
    const stale = join(reports, "0000000000000000000000000000000000000000-debate.md");
    writeFileSync(stale, header());
    const p = payload({
      lenses: [{ name: "debate", model: "opencode/glm-5.3-flash-free", report: stale }],
    });

    expect(() => validate(p, "p.json", diff, HEAD)).toThrow(/not named for/);
  });

  test("refuses another lens's report even when its models and head match", () => {
    const p = payload({
      lenses: [{ name: "debate", model: "opencode/glm-5.3-flash-free", report: save("code-review", header()) }],
    });

    expect(() => validate(p, "p.json", diff, HEAD)).toThrow(/not named for/);
  });

  test.each([
    "Author model: pi/opencode-go/deepseek-v4.1-flash\nReviewer model: opencode/glm-5.3-flash-free\n",
    "Reviewer model: opencode/glm-5.3-flash-free\n\nAuthor model: pi/opencode-go/deepseek-v4.1-flash\n",
    "# report\nReviewer model: opencode/glm-5.3-flash-free\nAuthor model: pi/opencode-go/deepseek-v4.1-flash\n",
  ])("refuses model headers that are not the opening adjacent reviewer/author pair: %s", (text) => {
    const p = payload({ lenses: [{
      name: "debate", model: "opencode/glm-5.3-flash-free", report: save("debate", text),
    }] });
    expect(() => validate(p, "p.json", diff, HEAD)).toThrow(/two model lines/);
  });

  test("refuses a report with no model lines", () => {
    const p = payload({
      lenses: [
        { name: "debate", model: "opencode/glm-5.3-flash-free", report: save("debate", "# debate\n") },
      ],
    });

    expect(() => validate(p, "p.json", diff, HEAD)).toThrow(/two model lines/);
  });

  test("refuses a report whose reviewer is not the model the payload names", () => {
    const p = payload({
      lenses: [
        {
          name: "debate",
          model: "opencode/glm-5.3-flash-free",
          report: save("debate", header("opencode/mimo-v2.6-flash-free")),
        },
      ],
    });

    expect(() => validate(p, "p.json", diff, HEAD)).toThrow(/its report says/);
  });

  test("refuses a report reviewed for a different author", () => {
    const p = payload({
      lenses: [
        {
          name: "debate",
          model: "opencode/glm-5.3-flash-free",
          report: save("debate", header(undefined, "opencode/deepseek-v4.1-flash-free")),
        },
      ],
    });

    expect(() => validate(p, "p.json", diff, HEAD)).toThrow(/payload claims the author/);
  });

  test("refuses a round where every lens is skipped", () => {
    const p = payload({
      lenses: [
        { name: "debate", model: "opencode/glm-5.3-flash-free", skipped: "docs only" },
        { name: "test-audit", model: "opencode/mimo-v2.6-flash-free", skipped: "docs only" },
      ],
    });

    expect(() => validate(p, "p.json", diff, HEAD)).toThrow(/not a review/);
  });

  test("refuses a lens on the author's family", () => {
    const p = payload({
      lenses: [
        {
          name: "debate",
          model: "opencode-go/deepseek-v4.1-flash",
          report: save("debate", header("opencode-go/deepseek-v4.1-flash")),
        },
      ],
    });

    expect(() => validate(p, "p.json", diff, HEAD)).toThrow(/author's family/);
  });
});

describe("validateMerged", () => {
  test("refuses an empty verdict once agreement promotes a P2", () => {
    const p = payload({
      findings: [finding({ lens: "debate", line: 10 }), finding({ lens: "code-review", line: 10 })],
    });
    const merged = dedupe(p.findings.map((f) => ({ ...f, anchored: true })));

    expect(merged[0]?.severity).toBe("P1");
    expect(() => validateMerged(p, merged, "p.json")).toThrow(/promoted by lens agreement/);
  });

  test("accepts an empty verdict when nothing is promoted", () => {
    const p = payload({ findings: [finding({ lens: "debate", line: 10 })] });
    const merged = dedupe(p.findings.map((f) => ({ ...f, anchored: true })));

    expect(() => validateMerged(p, merged, "p.json")).not.toThrow();
  });

  test("refuses a promoted P2 that carries no evidence", () => {
    const p = payload({
      findings: [
        finding({ lens: "debate", line: 10, evidence: "" }),
        finding({ lens: "code-review", line: 10, evidence: "" }),
      ],
      summary: { impact: "Low", what: "A change.", verdict: "Agreement promoted this." },
    });
    const merged = dedupe(p.findings.map((f) => ({ ...f, anchored: true })));

    expect(merged[0]?.severity).toBe("P1");
    expect(() => validateMerged(p, merged, "p.json")).toThrow(/no evidence/);
  });
});

describe("scoreOverride", () => {
  test("lowers the rule with a reason", () => {
    const p = payload({ scoreOverride: { score: 2, reason: "two P1s are one root cause" } });

    expect(scoreOverride(p, 4)).toBe(2);
  });

  test("refuses to raise the rule", () => {
    const p = payload({ scoreOverride: { score: 5, reason: "feels fine" } });

    expect(() => scoreOverride(p, 3)).toThrow(/ceiling/);
  });
});

describe("parseDiff", () => {
  const diff = (...lines: string[]) => lines.join("\n");

  test("an added line becomes a one-line range", () => {
    const raw = diff(
      "diff --git a/a.txt b/a.txt",
      "index 111..222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,0 +2,1 @@",
      "+two",
    );

    expect(parseDiff(raw)).toEqual([{ path: "a.txt", ranges: [[2, 2]] }]);
  });

  test("header-shaped hunk content never changes the reviewed filename", () => {
    expect(parseDiff(diff(
      "diff --git a/query.sql b/query.sql",
      "--- a/query.sql",
      "+++ b/query.sql",
      "@@ -1,2 +1,2 @@",
      "--- removed comment",
      "--- a/fake-removed.txt",
      "+++ added comment",
      "+++ b/fake-added.txt",
    ))).toEqual([{ path: "query.sql", ranges: [[1, 2]] }]);
  });

  test("header-shaped deleted content remains in a deletion-only file", () => {
    expect(parseDiff(diff(
      "diff --git a/gone.sql b/gone.sql",
      "--- a/gone.sql",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "--- removed comment",
    ))).toEqual([{ path: "gone.sql", ranges: [] }]);
  });

  test("a multi-line hunk becomes one range", () => {
    const raw = diff(
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +2,3 @@",
      "+two",
      "+three",
      "+four",
    );

    expect(parseDiff(raw)).toEqual([{ path: "a.txt", ranges: [[2, 4]] }]);
  });

  test("a deletion-only file is still a reviewed path", () => {
    const raw = diff(
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "index 111..000",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-one",
    );

    expect(parseDiff(raw)).toEqual([{ path: "gone.txt", ranges: [] }]);
  });

  test("a rename-only file lists both paths once and anchors neither", () => {
    const raw = diff(
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
    );

    expect(parseDiff(raw)).toEqual([
      { path: "old.ts", ranges: [] },
      { path: "new.ts", ranges: [] },
    ]);
  });

  test("a rename with edits anchors the hunks on the new path, not a duplicate", () => {
    const raw = diff(
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -3,0 +4,2 @@",
      "+four",
      "+five",
    );

    expect(parseDiff(raw)).toEqual([
      { path: "old.ts", ranges: [] },
      { path: "new.ts", ranges: [[4, 5]] },
    ]);
  });

  test("a binary diff registers its path without added-line ranges", () => {
    expect(parseDiff(diff(
      "diff --git a/image.bin b/image.bin",
      "index 111..222 100644",
      "Binary files a/image.bin and b/image.bin differ",
    ))).toEqual([{ path: "image.bin", ranges: [] }]);
  });

  test("a mode-only change is a reviewed path with no hunks", () => {
    const raw = diff(
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
    );

    expect(parseDiff(raw)).toEqual([{ path: "run.sh", ranges: [] }]);
  });

  test("a spaced path's trailing tab does not split it into two entries", () => {
    const raw = diff(
      "diff --git a/with space.txt b/with space.txt",
      "--- a/with space.txt\t",
      "+++ b/with space.txt\t",
      "@@ -1,0 +2,1 @@",
      "+two",
    );

    expect(parseDiff(raw)).toEqual([{ path: "with space.txt", ranges: [[2, 2]] }]);
  });

  test("a path containing ' b/' does not register a phantom file", () => {
    const raw = diff(
      "diff --git a/notes b/draft.txt b/notes b/draft.txt",
      "--- a/notes b/draft.txt\t",
      "+++ b/notes b/draft.txt\t",
      "@@ -1,0 +2,1 @@",
      "+two",
    );

    expect(parseDiff(raw)).toEqual([{ path: "notes b/draft.txt", ranges: [[2, 2]] }]);
  });

  test("C-quoted UTF-8 paths keep their own hunks without leaking into the previous file", () => {
    const raw = diff(
      "diff --git a/plain.txt b/plain.txt",
      "--- a/plain.txt",
      "+++ b/plain.txt",
      "@@ -1,0 +2,1 @@",
      "+two",
      'diff --git "a/a\\303\\261o.txt" "b/a\\303\\261o.txt"',
      '--- "a/a\\303\\261o.txt"',
      '+++ "b/a\\303\\261o.txt"',
      "@@ -9 +9,2 @@",
      "-one",
      "+one",
      "+two",
    );

    expect(parseDiff(raw)).toEqual([
      { path: "plain.txt", ranges: [[2, 2]] },
      { path: "año.txt", ranges: [[9, 10]] },
    ]);
  });

  test("header-only paths containing ' b/' never create phantom entries", () => {
    expect(parseDiff(diff(
      "diff --git a/notes b/draft.txt b/notes b/draft.txt",
      "old mode 100644",
      "new mode 100755",
    ))).toEqual([{ path: "notes b/draft.txt", ranges: [] }]);
  });

  test("non-UTF-8 quoted paths refuse with a filename diagnostic", () => {
    expect(() => parseDiff(diff(
      'diff --git "a/\\377.txt" "b/\\377.txt"',
      "old mode 100644",
      "new mode 100755",
    ))).toThrow(/not a UTF-8 filename/);
  });

  test("a C-quoted header-only path is still reviewed", () => {
    expect(parseDiff(diff(
      'diff --git "a/odd\\\"name.txt" "b/odd\\\"name.txt"',
      "old mode 100644",
      "new mode 100755",
    ))).toEqual([{ path: 'odd"name.txt', ranges: [] }]);
  });

  test("a C-quoted rename registers decoded source and destination paths", () => {
    expect(parseDiff(diff(
      'diff --git "a/old\\tname" "b/new\\tname"',
      "similarity index 100%",
      'rename from "old\\tname"',
      'rename to "new\\tname"',
    ))).toEqual([
      { path: "old\tname", ranges: [] },
      { path: "new\tname", ranges: [] },
    ]);
  });

  test("one unreadable header refuses a mixed diff rather than dropping a reviewed path", () => {
    expect(() => parseDiff(diff(
      "diff --git a/good.txt b/good.txt",
      "old mode 100644",
      "new mode 100755",
      "diff --git unreadable",
      "old mode 100644",
      "new mode 100755",
    ))).toThrow(/header/);
  });

  test("an empty diff parses to nothing", () => {
    expect(parseDiff("")).toEqual([]);
  });

  test("two files keep their own ranges", () => {
    const raw = diff(
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,0 +2,1 @@",
      "+two",
      "diff --git a/b.txt b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -8,0 +9,2 @@",
      "+nine",
      "+ten",
    );

    expect(parseDiff(raw)).toEqual([
      { path: "a.txt", ranges: [[2, 2]] },
      { path: "b.txt", ranges: [[9, 10]] },
    ]);
  });
});

describe("isAnchored", () => {
  const hunks: Hunk[] = [{ path: "apps/api/src/main.ts", ranges: [[10, 20], [30, 34]] }];

  test.each([[9, false], [10, true], [20, true], [21, false]] as const)(
    "line %i has inclusive-hunk eligibility %s", (line, expected) => {
      expect(isAnchored(hunks, finding({ line }))).toBe(expected);
    },
  );

  test("a line inside a changed range goes inline", () => {
    expect(isAnchored(hunks, finding({ line: 15 }))).toBe(true);
  });

  test("a line in the gap between two hunks goes outside", () => {
    expect(isAnchored(hunks, finding({ line: 25 }))).toBe(false);
  });

  test("a multi-line range that leaves the hunk goes outside", () => {
    expect(isAnchored(hunks, finding({ line: 18, endLine: 22 }))).toBe(false);
    expect(isAnchored(hunks, finding({ line: 18, endLine: 20 }))).toBe(true);
  });

  test("a file the diff does not touch goes outside", () => {
    expect(isAnchored(hunks, finding({ path: "apps/web/src/app.tsx" }))).toBe(false);
  });
});

describe("renderBody", () => {
  const mergedFinding = (over: Partial<Finding> = {}) => ({
    ...finding(over),
    anchored: true,
    lenses: ["debate"],
  });
  const body = (over: Partial<Parameters<typeof renderBody>[0]> = {}) =>
    renderBody({ payload: payload(), head: HEAD, base: "develop", score: 5, findings: [], ...over });

  test("keeps the markers the gate greps for", () => {
    const text = body();

    expect(text).toContain("<!-- greptile_summary -->");
    expect(text).toContain("<h2>Confidence Score: 5/5</h2>");
    expect(text).toContain("<!-- greptile_confidence_score:5 -->");
    expect(text).toContain(`${HEAD}`);
  });

  test("makes the summary collapsible and open by default", () => {
    const p = payload();
    p.summary.summary = "Reviewed behavior summary.";
    p.summary.checks = "Focused checks passed.";
    const text = body({ payload: p });

    expect(text).toContain(
      '<details open><summary><h3>Summary</h3></summary>\n\nReviewed behavior summary.',
    );
    const summary = text.slice(text.indexOf('<details open><summary><h3>Summary</h3>'));
    expect(summary).toContain("Checks: Focused checks passed.\n\n</details>");
    expect(text.indexOf("Confidence Score: 5/5")).toBeLessThan(text.indexOf("<h3>Summary</h3>"));
  });

  test("wraps supplied Mermaid source in the diagram section", () => {
    const p = payload();
    p.summary.diagram = "flowchart TD\n  Input --> Decision\n  Decision --> Output";
    const text = body({ payload: p });

    expect(text).toContain(
      '<details open><summary><h3>Diagram</h3></summary>\n\n```mermaid\n' +
      p.summary.diagram + "\n```\n</details>",
    );
    expect(text).toContain("<!-- greptile_confidence_score:5 -->");
    expect(text).toMatch(/<h3>Summary<\/h3>[\s\S]*?<\/details>\n\n<details open><summary><h3>Diagram/);
  });

  test("omits the diagram section when no source is supplied", () => {
    const text = body();

    expect(text).not.toContain("<h3>Diagram</h3>");
    expect(text).not.toContain("```mermaid");
    expect(text).toContain("<!-- greptile_confidence_score:5 -->");
  });

  test("names the score it was given, not a score of its own", () => {
    expect(body({ score: 3 })).toContain("<h2>Confidence Score: 3/5</h2>");
  });

  test("an override equal to the rule does not claim the score was lowered", () => {
    const p = payload({ scoreOverride: { score: 5, reason: "rule retained" } });
    const text = body({ payload: p });

    expect(text).not.toContain("lowered");
    expect(text).toContain("rule retained");
  });

  test("override reasons render as text, not HTML", () => {
    const p = payload({ scoreOverride: { score: 5, reason: '</sub><h2>"fake" & override</h2>' } });
    const text = body({ payload: p });
    expect(text).toContain("&lt;/sub&gt;&lt;h2&gt;&quot;fake&quot; &amp; override&lt;/h2&gt;");
    expect(text).not.toContain('</sub><h2>"fake"');
  });

  test("permalink query values cannot break the HTML attribute", () => {
    const text = body({ findings: [mergedFinding({ permalink: 'https://example.invalid/review?q="quoted"&next=<tag>' })] });
    expect(text).toContain('href="https://example.invalid/review?q=%22quoted%22&amp;next=%3Ctag%3E"');
    expect(text).not.toContain('q="quoted"');
  });

  test.each([
    'javascript:alert(1)', 'data:text/html,<h2>fake</h2>', 'file:///tmp/review',
    '//example.invalid/review', 'not a URL',
  ])("unsafe or invalid permalink %s falls back to the encoded blob link", (permalink) => {
    const text = body({ findings: [mergedFinding({ permalink, path: "folder/a#b.ts" })] });
    expect(text).toContain(`/blob/${HEAD}/folder/a%23b.ts#L10`);
    expect(text).not.toContain(`href="${permalink}"`);
  });

  test("permalink credentials are not published", () => {
    const text = body({ findings: [mergedFinding({ permalink: "https://fixture-user:fixture-secret@example.invalid/review" })] });
    expect(text).toContain('href="https://example.invalid/review"');
    expect(text).not.toContain("fixture-secret");
  });

  test("records an independence exception in the body", () => {
    const p = payload({
      independence: { approvedBy: "owner", reason: "no other family left this week" },
    });

    expect(body({ payload: p })).toContain("<!-- reviewloop_independence_exception -->");
  });

  test("puts an unanchored finding in the outside-diff list", () => {
    const f = { ...mergedFinding({ severity: "P1" }), anchored: false };

    expect(body({ findings: [f] })).toContain("<!-- greptile_outside_diff -->");
    expect(body({ findings: [mergedFinding({ severity: "P1" })] })).not.toContain(
      "<!-- greptile_outside_diff -->",
    );
  });

  test.each([6, 10, 15])("a %i-backtick run cannot close the five-backtick prompt fence", (length) => {
    const text = body({ findings: [mergedFinding({ body: "`".repeat(length) })] });
    expect(text).toContain("\n````\n");
  });

  test("blob links encode reserved filename characters", () => {
    const text = body({ findings: [mergedFinding({ path: "folder/a#b?c%.ts" })] });
    expect(text).toContain("/folder/a%23b%3Fc%25.ts#L10");
  });

  test("renders a finding with its badge and its file", () => {
    const text = body({ findings: [mergedFinding({ severity: "P1" })] });

    expect(text).toContain("p1.svg");
    expect(text).toContain("apps/api/src/main.ts");
  });
});

// ---------------------------------------------------------------------------
// The exit code: what `guard` and the merge gate actually read
// ---------------------------------------------------------------------------

describe("the CLI contract", () => {
  // A throwaway repository, so the cases do not depend on this checkout's
  // history being deep enough for `HEAD~1`.
  const script = join(
    execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
    "tools",
    "reviewloop",
    "render.ts",
  );
  const issue = `cli-test-${process.pid}`;
  let work = "";
  let head = "";
  let dir = "";

  const gitIn = (...cmd: string[]) =>
    execFileSync("git", cmd, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "reviewloop-cli-"));
    dir = join(work, ".scratch", "reviews", issue);
    gitIn("init", "-q");
    gitIn("config", "user.email", "test@example.invalid");
    gitIn("config", "user.name", "reviewloop test");
    writeFileSync(join(work, "a.txt"), "one\n");
    gitIn("add", "a.txt");
    gitIn("commit", "-q", "-m", "first");
    writeFileSync(join(work, "a.txt"), "one\ntwo\n");
    gitIn("commit", "-q", "-am", "second");
    head = gitIn("rev-parse", "HEAD");
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  function fixture(findings: Finding[] = [], verdict = "", repo = { work, head, dir }) {
    mkdirSync(repo.dir, { recursive: true });
    const report = (name: string, model: string) => {
      const path = join(repo.dir, `${repo.head}-${name}.md`);
      writeFileSync(path, header(model));
      return path;
    };
    writeFileSync(
      join(repo.dir, `${repo.head}-findings.json`),
      JSON.stringify({
        authorModel: "pi/opencode-go/deepseek-v4.1-flash",
        lenses: [
          {
            name: "debate",
            model: "opencode/glm-5.3-flash-free",
            report: report("debate", "opencode/glm-5.3-flash-free"),
          },
          {
            name: "code-review",
            model: "opencode/beam-free",
            report: report("code-review", "opencode/beam-free"),
          },
        ],
        summary: { impact: "Low", what: "A change.", verdict },
        findings,
      }),
    );
  }

  const run = (base: string, repo = { work, head, dir }) =>
    spawnSync(process.execPath, [script, "--issue", issue, "--base", base], {
      cwd: repo.work,
      encoding: "utf8",
    });

  const written = (name: string) => readFileSync(join(dir, `${head}-${name}`), "utf8");

  /** A private two-commit repository, for cases the shared fixture cannot shape. */
  function scratchRepo(prefix: string, quotePath = false) {
    const repoWork = mkdtempSync(join(tmpdir(), prefix));
    const gitAt = (...cmd: string[]) =>
      execFileSync("git", cmd, {
        cwd: repoWork,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    gitAt("init", "-q");
    gitAt("config", "user.email", "test@example.invalid");
    gitAt("config", "user.name", "reviewloop test");
    if (quotePath) gitAt("config", "core.quotePath", "true");
    return { repoWork, repoDir: join(repoWork, ".scratch", "reviews", issue), gitAt };
  }

  test("a clean payload exits 0 and writes the artifact the gate reads", () => {
    fixture();
    const result = run("HEAD~1");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("score      5/5");

    // SAFETY: this file was just written by the renderer from our own fixture.
    const artifact = JSON.parse(written("greptile-local.json")) as { body: string; created: string };
    expect(artifact.body).toContain("<!-- greptile_summary -->");
    expect(artifact.body).toContain("<!-- greptile_confidence_score:5 -->");
    expect(Number.isNaN(Date.parse(artifact.created))).toBe(false);
    expect(JSON.parse(written("inline.json"))).toEqual([]);
  });

  test("binds native review threads to the reviewed commit and changed line", () => {
    fixture([finding({ path: "a.txt", line: 2, severity: "P1" })], "Fix the changed line.");
    const result = run("HEAD~1");

    expect(result.status).toBe(1);
    const review: {
      commit_id: string;
      event: string;
      body: string;
      comments: Array<{ path: string; line: number; side: string; body: string }>;
    } = JSON.parse(written("review.json"));
    expect(review.commit_id).toBe(head);
    expect(review.event).toBe("COMMENT");
    expect(review.body).toContain("<!-- greptile_confidence_score:4 -->");
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({ path: "a.txt", line: 2, side: "RIGHT" });
    expect(review.comments[0]?.body).toContain("Why it is wrong.");
    expect(review.comments).toEqual(JSON.parse(written("inline.json")));
  });

  test("the CLI supports equals-form values without guessing a different head", () => {
    fixture();
    const result = spawnSync(process.execPath, [script, `--issue=${issue}`, "--base=HEAD~1", "--head=HEAD"], {
      cwd: work, encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const parent = gitIn("rev-parse", "HEAD~1");
    const other = spawnSync(process.execPath, [script, "--issue", issue, "--base", "HEAD~1", "--head=HEAD~1"], {
      cwd: work, encoding: "utf8",
    });
    expect(other.status).toBe(2);
    expect(other.stderr).toContain(`${parent}-findings.json`);
  });

  test.each([".", ".."])("issue %s cannot write outside its own reviews folder", (name) => {
    fixture();
    const unsafeDir = join(work, ".scratch", "reviews", name);
    writeFileSync(join(unsafeDir, `${head}-findings.json`), readFileSync(join(dir, `${head}-findings.json`)));
    const result = spawnSync(process.execPath, [script, "--issue", name, "--base", "HEAD~1"], {
      cwd: work, encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("plain folder name");
    expect(existsSync(join(unsafeDir, `${head}-greptile-local.json`))).toBe(false);
  });

  test("--head resolves a commit ref before naming the evidence", () => {
    fixture();
    const result = spawnSync(process.execPath, [script, "--issue", issue, "--base", "HEAD~1", "--head", "HEAD"], {
      cwd: work,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(written("greptile-local.md")).toContain(`/commit/${head}`);
    expect(written("greptile-local.md")).toContain("Last reviewed commit");
  });

  test("inline and summary artifacts omit a suggestion from an adjacent retained range", () => {
    const { repoWork, repoDir, gitAt } = scratchRepo("reviewloop-suggestion-range-");
    try {
      writeFileSync(join(repoWork, "a.txt"), "one\n");
      gitAt("add", "a.txt");
      gitAt("commit", "-q", "-m", "first");
      writeFileSync(join(repoWork, "a.txt"), "one\ntwo\nthree\n");
      gitAt("add", "a.txt");
      gitAt("commit", "-q", "-m", "add adjacent lines");
      const repoHead = gitAt("rev-parse", "HEAD");
      const repo = { work: repoWork, head: repoHead, dir: repoDir };
      const unsafeSuggestion = "```suggestion\nreplaceLineThree();\n```";

      fixture([
        finding({
          id: "same-defect",
          lens: "debate",
          severity: "P2",
          path: "a.txt",
          line: 2,
          title: "First report",
          body: "The first report points to line two.",
          evidence: "self-evident: the changed line is line two.",
        }),
        finding({
          id: "same-defect",
          lens: "code-review",
          severity: "P2",
          path: "a.txt",
          line: 3,
          title: "Longer report",
          body: "This longer explanation comes from the adjacent third line.",
          suggestion: unsafeSuggestion,
          evidence: "self-evident: the adjacent changed line is line three.",
        }),
      ], "Two lenses agree on one defect.", repo);
      const result = run("HEAD~1", repo);

      expect(result.status).toBe(1);
      // SAFETY: inline.json is generated from the two findings in this fixture.
      const inline = JSON.parse(
        readFileSync(join(repoDir, `${repoHead}-inline.json`), "utf8"),
      ) as Array<{ path: string; line: number; body: string }>;
      expect(inline).toHaveLength(1);
      expect(inline[0]?.path).toBe("a.txt");
      expect(inline[0]?.line).toBe(2);
      expect(inline[0]?.body).not.toContain(unsafeSuggestion);

      const summary = readFileSync(join(repoDir, `${repoHead}-greptile-local.md`), "utf8");
      expect(summary).toContain("Confidence Score: 4/5");
      expect(summary).toContain("Two lenses agree on one defect.");
      expect(summary).not.toContain(unsafeSuggestion);
    } finally {
      rmSync(repoWork, { recursive: true, force: true });
    }
  });

  test.each(["--print", "--json"])("%s exposes the rendered artifact on stdout", (option) => {
    fixture();
    const result = spawnSync(process.execPath, [script, "--issue", issue, "--base", "HEAD~1", option], {
      cwd: work,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    if (option === "--json") {
      // SAFETY: the renderer's JSON stdout is the public contract under test.
      const artifact = JSON.parse(result.stdout) as { body: string; created: string };
      expect(artifact.body).toBe(written("greptile-local.md"));
      expect(Number.isNaN(Date.parse(artifact.created))).toBe(false);
    } else {
      expect(result.stdout.trimEnd()).toBe(written("greptile-local.md").trimEnd());
    }
  });

  test("a lowered clean score exits 1 instead of certifying a 5/5", () => {
    fixture();
    const input = join(dir, `${head}-findings.json`);
    // SAFETY: fixture() just wrote a valid Payload to this file.
    const valid = JSON.parse(readFileSync(input, "utf8")) as Payload;
    valid.scoreOverride = { score: 4, reason: "reviewer requests another look" };
    writeFileSync(input, JSON.stringify(valid));
    const result = run("HEAD~1");

    expect(result.status).toBe(1);
    expect(written("greptile-local.md")).toContain("<!-- greptile_confidence_score:4 -->");
  });

  test("an open P1 exits 1 and posts it inline", () => {
    fixture(
      [
        finding({
          severity: "P1",
          path: "a.txt",
          line: 2,
          title: "The added line is unread",
          evidence: "self-evident: the added line is not read.",
          suggestion: "```suggestion\nreadAddedLine();\n```",
        }),
      ],
      "One P1 is open.",
    );
    const result = run("HEAD~1");

    expect(result.status).toBe(1);
    expect(written("greptile-local.md")).toContain("p1.svg");
    // SAFETY: the renderer wrote this array from the one P1 finding in the fixture.
    const inline = JSON.parse(written("inline.json")) as Array<{ path: string; line: number; body: string }>;
    expect(inline).toHaveLength(1);
    expect(inline[0]?.path).toBe("a.txt");
    expect(inline[0]?.line).toBe(2);
    expect(inline[0]?.body).toContain("```suggestion\nreadAddedLine();\n```");
  });

  test.each([
    "https://fixture-user:fixture-secret@github.com/test/repo.git",
    "ssh://git@github.com/test/repo.git",
    "git@github.com:test/repo.git",
  ])("rendered links use a public web URL for remote %s", (remote) => {
    fixture();
    gitIn("remote", "add", "origin", remote);
    try {
      expect(run("HEAD~1").status).toBe(0);
      const body = written("greptile-local.md");
      expect(body).toContain("https://github.com/test/repo/commit/");
      expect(body).not.toContain("fixture-secret");
      expect(body).not.toContain("ssh://");
    } finally {
      gitIn("remote", "remove", "origin");
    }
  });

  test("a base that cannot be read exits 2 instead of rendering clean", () => {
    fixture();
    const result = run("no-such-branch");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not a review");
  });

  test("an empty diff exits 2 instead of scoring a review of nothing", () => {
    fixture();
    const result = run("HEAD");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("is empty");
  });

  test("a deletion-only diff is a review, not an empty diff", () => {
    // The raw diff is non-empty but has no added line, so a guard keyed on
    // parsed hunks would refuse a legitimate commit.
    const { repoWork, repoDir, gitAt } = scratchRepo("reviewloop-delete-");
    try {
      writeFileSync(join(repoWork, "gone.txt"), "one\n");
      gitAt("add", "gone.txt");
      gitAt("commit", "-q", "-m", "first");
      rmSync(join(repoWork, "gone.txt"));
      gitAt("add", "-A");
      gitAt("commit", "-q", "-m", "delete it");
      const repoHead = gitAt("rev-parse", "HEAD");
      const repo = { work: repoWork, head: repoHead, dir: repoDir };

      fixture([finding({ path: "gone.txt", line: 1 })], "", repo);
      const result = run("HEAD~1", repo);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("score      5/5");
      expect(readFileSync(join(repoDir, `${repoHead}-greptile-local.md`), "utf8")).toContain("Comments Outside Diff");
      expect(JSON.parse(readFileSync(join(repoDir, `${repoHead}-inline.json`), "utf8"))).toEqual([]);
    } finally {
      rmSync(repoWork, { recursive: true, force: true });
    }
  });

  test("a non-ASCII filename is reviewed even when git would quote it", () => {
    // Quoted headers are unreadable to the parser, so `readDiff` pins
    // core.quotePath=false; without it this round exits 2 on a real change.
    const { repoWork, repoDir, gitAt } = scratchRepo("reviewloop-quoted-", true);
    try {
      writeFileSync(join(repoWork, "año.txt"), "one\n");
      gitAt("add", "año.txt");
      gitAt("commit", "-q", "-m", "first");
      writeFileSync(join(repoWork, "año.txt"), "one\ntwo\n");
      gitAt("add", "-A");
      gitAt("commit", "-q", "-m", "second");
      const repoHead = gitAt("rev-parse", "HEAD");
      const repo = { work: repoWork, head: repoHead, dir: repoDir };

      fixture([finding({ path: "año.txt", line: 2 })], "", repo);
      const result = run("HEAD~1", repo);

      expect(result.status).toBe(0);
      // SAFETY: the renderer wrote this array from the one finding in the fixture.
      const inline = JSON.parse(
        readFileSync(join(repoDir, `${repoHead}-inline.json`), "utf8"),
      ) as Array<{ path: string }>;
      expect(inline).toHaveLength(1);
      expect(inline[0]?.path).toBe("año.txt");
    } finally {
      rmSync(repoWork, { recursive: true, force: true });
    }
  });

  test("worktree mode refuses gate evidence and preserves the committed review", () => {
    fixture();
    expect(run("HEAD~1").status).toBe(0);
    const before = written("greptile-local.json");
    writeFileSync(join(work, "a.txt"), "one\ntwo\nuncommitted\n");
    try {
      const result = spawnSync(
        process.execPath,
        [script, "--issue", issue, "--base", "HEAD", "--worktree"],
        { cwd: work, encoding: "utf8" },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("commit");
      expect(written("greptile-local.json")).toBe(before);
    } finally {
      writeFileSync(join(work, "a.txt"), "one\ntwo\n");
    }
  });

  const invalidInputs: Array<[string, (p: Payload) => string]> = [
    ["null", () => "null"],
    ["array", () => "[]"],
    ["numeric author", (p) => JSON.stringify({ ...p, authorModel: 42 })],
    ["null lens", (p) => JSON.stringify({ ...p, lenses: [null] })],
    ["numeric model", (p) => JSON.stringify({ ...p, lenses: [{ ...p.lenses[0], model: 42 }] })],
    ["numeric report", (p) => JSON.stringify({ ...p, lenses: [{ ...p.lenses[0], report: 42 }] })],
    ["null summary", (p) => JSON.stringify({ ...p, summary: null })],
    ["numeric verdict", (p) => JSON.stringify({ ...p, summary: { ...p.summary, verdict: 42 } })],
    ["numeric bullet", (p) => JSON.stringify({ ...p, summary: { ...p.summary, bullets: [42] } })],
    ["null dismissal", (p) => JSON.stringify({ ...p, summary: { ...p.summary, dismissed: [null] } })],
    ["null finding", (p) => JSON.stringify({ ...p, findings: [null] })],
    ["numeric body", (p) => JSON.stringify({ ...p, findings: [{ ...finding({ path: "a.txt" }), body: 42 }] })],
    ["numeric approval", (p) => JSON.stringify({ ...p, independence: { approvedBy: 42, reason: "owner exception" } })],
    ["numeric override reason", (p) => JSON.stringify({ ...p, scoreOverride: { score: 4, reason: 42 } })],
  ];

  test.each(invalidInputs)("malformed payload %s exits 2, not 1", (_name, change) => {
    fixture();
    const input = join(dir, `${head}-findings.json`);
    // SAFETY: fixture() just wrote a valid Payload to this file.
    const valid = JSON.parse(readFileSync(input, "utf8")) as Payload;
    writeFileSync(input, change(valid));
    const result = run("HEAD~1");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("reviewloop:");
    expect(result.stderr).not.toContain("TypeError");
  });

  test("a directory report exits 2 instead of an uncaught filesystem error", () => {
    fixture();
    const input = join(dir, `${head}-findings.json`);
    // SAFETY: fixture() just wrote a valid Payload to this file.
    const valid = JSON.parse(readFileSync(input, "utf8")) as Payload;
    const lens = valid.lenses[0];
    if (!lens) throw new Error("fixture has no lens");
    const folder = join(dir, "not-a-file", `${head}-debate.md`);
    mkdirSync(folder, { recursive: true });
    lens.report = folder;
    writeFileSync(input, JSON.stringify(valid));

    expect(run("HEAD~1").status).toBe(2);
  });

  test("a findings file that is not JSON exits 2, not 1", () => {
    fixture();
    writeFileSync(join(dir, `${head}-findings.json`), "{ not json");
    const result = run("HEAD~1");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not valid JSON");
  });
});
