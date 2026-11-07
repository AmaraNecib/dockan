import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const OXLINT = resolve(ROOT, "node_modules/oxlint/bin/oxlint");

test("reports object parameters with stable names and bounded comment input", () => {
  const fixture = resolve(ROOT, `tools/no-object-parameters-${randomUUID()}.ts`);
  // A restored quadratic scan cannot finish this comment within the process budget.
  // Linear extraction leaves ample room for CLI startup on a loaded runner.
  const longWhitespaceComment = `/*${" ".repeat(1_000_000)}*/`;
  writeFileSync(
    fixture,
    [
      "type Payload = object;",
      "function ordinary({ value }: object): void { void value; }",
      "function aliased({ value }: Payload): void { void value; }",
      `function commented({ value } ${longWhitespaceComment} ${" ".repeat(60_000)}: object): void { void value; }`,
      "void ordinary;",
      "void aliased;",
      "void commented;",
    ].join("\n"),
  );

  try {
    const result = spawnSync(
      process.execPath,
      [OXLINT, "-c", "oxlint.config.ts", "-f", "json", fixture],
      { cwd: ROOT, encoding: "utf8", timeout: 10_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const diagnostics = JSON.parse(result.stdout).diagnostics;
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.map(({ code }) => code)).toEqual([
      "anti-slop(no-object-parameters)",
      "anti-slop(no-object-parameters)",
      "anti-slop(no-object-parameters)",
    ]);
    expect(diagnostics.map(({ message }) => message.replace(/\s+/gu, " "))).toEqual([
      "Parameter `{ value }` uses the broad `object` type. Accept a named owner type; parse external input at its boundary before calling this function.",
      "Parameter `{ value }: Payload` uses the broad `object` type. Accept a named owner type; parse external input at its boundary before calling this function.",
      "Parameter `{ value } /* */` uses the broad `object` type. Accept a named owner type; parse external input at its boundary before calling this function.",
    ]);
  } finally {
    rmSync(fixture, { force: true });
  }
}, 20_000);
