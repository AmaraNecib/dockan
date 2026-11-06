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
  const longWhitespaceComment = `/*${" ".repeat(60_000)}*/`;
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
      [OXLINT, "-c", "oxlint.config.ts", fixture],
      { cwd: ROOT, encoding: "utf8" },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "error anti-slop(no-object-parameters): Parameter `{ value }` uses the broad `object` type.",
    );
    expect(result.stdout).toContain(
      "error anti-slop(no-object-parameters): Parameter `{ value } /* */` uses the broad `object` type.",
    );
    expect(result.stdout).toContain(
      "error anti-slop(no-object-parameters): Parameter `{ value }: Payload` uses the broad `object` type.",
    );
    expect(result.stdout.match(/error anti-slop\(no-object-parameters\)/gu)).toHaveLength(3);
  } finally {
    rmSync(fixture, { force: true });
  }
});
