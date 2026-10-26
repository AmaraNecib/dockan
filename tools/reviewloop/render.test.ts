import { describe, expect, test } from "bun:test";
import {
  computeScore,
  dedupe,
  independenceOf,
  modelFamily,
  worse,
  type Finding,
  type Lens,
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

const at = (over: Partial<Finding> = {}) => ({ ...finding(over), anchored: false });

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
});

describe("modelFamily", () => {
  test("free and paid DeepSeek are one family", () => {
    expect(modelFamily("opencode/deepseek-v4.1-flash-free")).toBe("deepseek");
    expect(modelFamily("opencode-go/deepseek-v4.1-flash")).toBe("deepseek");
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
