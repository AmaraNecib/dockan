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

// #369: every row asserts the WHOLE `ParseResult` — the false side is exactly
// `{ ok: false, message }`, the true side exactly `{ ok, switches, values }` —
// so a hollow stand-in of this module reds as `expect(undefined).toEqual(...)`
// (an AssertionError, the row's own reason) instead of a `TypeError` off
// `parsed.ok` dereferenced before any claim was made.
describe("parseFlags", () => {
  test("a switch and a separated value", () => {
    const parsed = parseFlags(["--dry-run", "--base", "develop"], SPECS);
    expect(parsed).toEqual({
      ok: true,
      switches: new Set(["--dry-run"]),
      values: new Map([["--base", ["develop"]]]),
    });
  });

  test("--flag=value is the same as --flag value", () => {
    // The spelling that used to work on tier 2 and fail on tier 1.
    const parsed = parseFlags(["--base=origin/develop", "--files=a.ts,b.ts"], SPECS);
    // The value is not split here: what a comma means is the script's business.
    expect(parsed).toEqual({
      ok: true,
      switches: new Set<string>(),
      values: new Map([
        ["--base", ["origin/develop"]],
        ["--files", ["a.ts,b.ts"]],
      ]),
    });
  });

  test("a switch refuses an attached value instead of ignoring it", () => {
    const parsed = parseFlags(["--dry-run=yes"], SPECS);
    expect(parsed).toEqual({ ok: false, message: "--dry-run takes no value" });
  });

  test("a value may not be the next flag", () => {
    // `--base --dry-run` used to take the flag as the ref, drop the dry run, and
    // run every package.
    for (const [argv, message] of [
      [["--base", "--dry-run"], "--base needs a value"],
      [["--files", "--dry-run"], "--files needs a value"],
      [["--files", "-x"], "--files needs a value"],
    ] as const) {
      expect(parseFlags(argv, SPECS)).toEqual({ ok: false, message });
    }
  });

  test("a value flag at the end of argv is a usage failure, not an empty value", () => {
    expect(parseFlags(["--base"], SPECS)).toEqual({ ok: false, message: "--base needs a value" });
    expect(parseFlags(["--files"], SPECS)).toEqual({ ok: false, message: "--files needs a value" });
  });

  test("an empty attached value is a usage failure too", () => {
    expect(parseFlags(["--base="], SPECS)).toEqual({
      ok: false,
      message: "--base needs a non-empty value",
    });
    expect(parseFlags(["--files="], SPECS)).toEqual({
      ok: false,
      message: "--files needs a non-empty value",
    });
  });

  test("an unknown flag and a stray argument are both refused, and named", () => {
    expect(parseFlags(["--nope"], SPECS)).toEqual({ ok: false, message: "unknown flag: --nope" });
    expect(parseFlags(["stray"], SPECS)).toEqual({
      ok: false,
      message: "unexpected argument: stray",
    });
  });

  test("a repeated single-use flag is refused rather than silently keeping the last", () => {
    expect(parseFlags(["--base", "a", "--base", "b"], SPECS)).toEqual({
      ok: false,
      message: "--base may only be given once",
    });
  });

  test("a repeatable flag collects every value in order", () => {
    const parsed = parseFlags(["--files", "a.ts", "--files", "b.ts"], [
      { name: "--files", kind: "value", repeat: true },
    ]);
    expect(parsed).toEqual({
      ok: true,
      switches: new Set<string>(),
      values: new Map([["--files", ["a.ts", "b.ts"]]]),
    });
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
