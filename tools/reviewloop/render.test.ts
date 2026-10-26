import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("keeps two defects two lines apart separate", () => {
    const merged = dedupe([at({ line: 10 }), at({ line: 12 })]);

    expect(merged).toHaveLength(2);
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

  test("keeps the longest body, so the merge does not lose the explanation", () => {
    const merged = dedupe([
      at({ lens: "debate", body: "short", line: 10 }),
      at({ lens: "code-review", body: "a much longer explanation", line: 10 }),
    ]);

    const [first] = merged;
    expect(first?.body).toBe("a much longer explanation");
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
  lenses: [
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

  test("refuses a report with no model lines", () => {
    const p = payload({
      lenses: [
        { name: "debate", model: "opencode/glm-5.3-flash-free", report: save("bare", "# debate\n") },
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
          report: save("debate-reviewer", header("opencode/mimo-v2.6-flash-free")),
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
          report: save("debate-author", header(undefined, "opencode/deepseek-v4.1-flash-free")),
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
          report: save("deepseek", header("opencode-go/deepseek-v4.1-flash")),
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

  test("a quoted path the parser cannot read does not leak hunks into the previous file", () => {
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

    expect(parseDiff(raw)).toEqual([{ path: "plain.txt", ranges: [[2, 2]] }]);
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

  test("names the score it was given, not a score of its own", () => {
    expect(body({ score: 3 })).toContain("<h2>Confidence Score: 3/5</h2>");
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

  test("an open P1 exits 1 and posts it inline", () => {
    fixture(
      [
        finding({
          severity: "P1",
          path: "a.txt",
          line: 2,
          title: "The added line is unread",
          evidence: "self-evident: the added line is not read.",
        }),
      ],
      "One P1 is open.",
    );
    const result = run("HEAD~1");

    expect(result.status).toBe(1);
    expect(written("greptile-local.md")).toContain("p1.svg");
    // SAFETY: the renderer wrote this array from the one P1 finding in the fixture.
    const inline = JSON.parse(written("inline.json")) as Array<{ path: string; line: number }>;
    expect(inline).toHaveLength(1);
    expect(inline[0]?.path).toBe("a.txt");
    expect(inline[0]?.line).toBe(2);
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

      fixture([], "", repo);
      const result = run("HEAD~1", repo);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("score      5/5");
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

  test("a findings file that is not JSON exits 2, not 1", () => {
    fixture();
    writeFileSync(join(dir, `${head}-findings.json`), "{ not json");
    const result = run("HEAD~1");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not valid JSON");
  });
});
