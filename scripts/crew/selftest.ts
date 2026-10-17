#!/usr/bin/env bun
// selftest.ts — the shared shape of every `--selftest` in this directory.
//
// Each script exports a `*Selftest()` that returns cases; the script's `--selftest`
// prints them, and `<script>.test.ts` asserts the same list is all `ok`. One case
// list per module means the operator's one-command proof cannot drift from what CI
// runs — a second copy of the cases is how a proof stops being a proof.

export type SelftestCase = { name: string; ok: boolean; detail: string };

export function check(name: string, ok: boolean, detail = ""): SelftestCase {
  return { name, ok, detail };
}

/** Print the cases and return the process exit code (non-zero if any failed). */
export function report(cases: SelftestCase[]): number {
  let failed = 0;
  for (const item of cases) {
    if (!item.ok) failed += 1;
    const suffix = item.detail === "" ? "" : ` — ${item.detail}`;
    console.log(`${item.ok ? "ok  " : "FAIL"} ${item.name}${suffix}`);
  }
  console.log(`${String(cases.length - failed)} pass / ${String(failed)} fail`);
  return failed === 0 ? 0 : 1;
}

/** A one-line explanation of a string mismatch, for a `check` detail. */
export function diff(actual: string, expected: string): string {
  if (actual === expected) return "";
  return `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}
