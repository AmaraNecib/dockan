import { describe, expect, test } from "bun:test";

import { parseFlags, usageFailure, type FlagSpec } from "./args";

// One parser for both verification-tier scripts.
//
// `e2e-changed.ts` supported `--base=ref` and `test-affected.ts` did not, so
// `bun run test:affected --base=origin/develop --dry-run` exited 2 while the
// same spelling on tier 2 worked. Two hand-rolled loops is how that happens, and
// the fix is one loop with one contract: a flag may take a value, a value may be
// attached with `=`, a switch may not take one, a value may not be the next flag,
// and anything unrecognised is a usage failure rather than a guess.
const SPECS: FlagSpec[] = [
  { name: "--dry-run", kind: "switch" },
  { name: "--base", kind: "value" },
  { name: "--files", kind: "value" },
];

describe("parseFlags", () => {
  test("a switch and a separated value", () => {
    const parsed = parseFlags(["--dry-run", "--base", "develop"], SPECS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect([...parsed.switches]).toEqual(["--dry-run"]);
    expect(parsed.values.get("--base")).toEqual(["develop"]);
    expect(parsed.values.get("--files")).toBeUndefined();
  });

  test("--flag=value is the same as --flag value", () => {
    // The spelling that used to work on tier 2 and fail on tier 1.
    const parsed = parseFlags(["--base=origin/develop", "--files=a.ts,b.ts"], SPECS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.values.get("--base")).toEqual(["origin/develop"]);
    expect(parsed.values.get("--files")).toEqual(["a.ts,b.ts"]);
    // The value is not split here: what a comma means is the script's business.
    expect(parsed.values.get("--files")).toEqual(["a.ts,b.ts"]);
  });

  test("a switch refuses an attached value instead of ignoring it", () => {
    const parsed = parseFlags(["--dry-run=yes"], SPECS);
    expect({ ok: parsed.ok }).toEqual({ ok: false });
    if (parsed.ok) return;
    expect(parsed.message).toContain("--dry-run");
    expect(parsed.message).toContain("no value");
  });

  test("a value may not be the next flag", () => {
    // `--base --dry-run` used to take the flag as the ref, drop the dry run, and
    // run every package.
    for (const argv of [
      ["--base", "--dry-run"],
      ["--files", "--dry-run"],
      ["--files", "-x"],
    ]) {
      const parsed = parseFlags(argv, SPECS);
      expect({ argv, ok: parsed.ok }).toEqual({ argv, ok: false });
    }
  });

  test("a value flag at the end of argv is a usage failure, not an empty value", () => {
    for (const argv of [["--base"], ["--files"]]) {
      const parsed = parseFlags(argv, SPECS);
      expect({ argv, ok: parsed.ok }).toEqual({ argv, ok: false });
    }
  });

  test("an empty attached value is a usage failure too", () => {
    expect(parseFlags(["--base="], SPECS).ok).toBe(false);
    expect(parseFlags(["--files="], SPECS).ok).toBe(false);
  });

  test("an unknown flag and a stray argument are both refused, and named", () => {
    const unknown = parseFlags(["--nope"], SPECS);
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.message).toContain("unknown flag: --nope");

    const stray = parseFlags(["stray"], SPECS);
    expect(stray.ok).toBe(false);
    if (stray.ok) return;
    expect(stray.message).toContain("unexpected argument: stray");
  });

  test("a repeated single-use flag is refused rather than silently keeping the last", () => {
    const parsed = parseFlags(["--base", "a", "--base", "b"], SPECS);
    expect({ ok: parsed.ok }).toEqual({ ok: false });
    if (parsed.ok) return;
    expect(parsed.message).toContain("--base");
  });

  test("a repeatable flag collects every value in order", () => {
    const parsed = parseFlags(["--files", "a.ts", "--files", "b.ts"], [
      { name: "--files", kind: "value", repeat: true },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.values.get("--files")).toEqual(["a.ts", "b.ts"]);
  });
});

describe("usageFailure", () => {
  test("prints the message and the usage to stderr and answers 2", () => {
    // The exit code is the contract both scripts share. It is a function so the
    // two call sites cannot disagree about it, and so it can be asserted without
    // capturing a subprocess.
    const written: string[] = [];
    const original = console.error;
    console.error = (line: string) => written.push(line);
    try {
      expect(usageFailure("unknown flag: --nope", "usage: bun scripts/x.ts")).toBe(2);
    } finally {
      console.error = original;
    }
    expect(written).toEqual(["unknown flag: --nope", "usage: bun scripts/x.ts"]);
  });
});
