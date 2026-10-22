/**
 * Tests for `readModuleSurface`, the one reader of a module's surface.
 *
 * The gate used to answer "what does this module export" from five separate
 * walks over the same AST, each with its own selection rules and none of them
 * written down beside the others. That drift cost two #350 review rounds — a
 * destructured `export const { value } = obj` contributed no name to two
 * readers and produced a false pass, and `export type { value }` counted as a
 * runtime name. This file pins the rules once, at the seam the readers project
 * from, so a drift is a red here instead of a false verdict in the gate.
 *
 * The rules under test:
 *
 *   1. which shapes TypeScript erases before the module runs;
 *   2. how a binding pattern names what it exports;
 *   3. which script kind an extension is read with;
 *   4. what a bare `export *` names (a specifier, not a resolved name).
 */

import { describe, expect, test } from "bun:test";

import {
  augmentModuleSource,
  declaredExportNames,
  readModuleSurface,
  runtimeExportNames,
  topLevelBindingNames,
} from "./red-on-parent";

describe("readModuleSurface: the shapes TypeScript erases", () => {
  // One module carrying every erased spelling beside runtime controls, so a
  // rule that stops erasing a shape shows up as that name in `runtime` rather
  // than as a silent pass on a list nobody looked at.
  const SOURCE = `
export interface ErasedInterface {
  a: number;
}
export type ErasedAlias = string;
export type { ErasedList } from "./types";
export type * from "./type-star";
export { type ErasedSpecifier, Kept } from "./values";
export declare const erasedAmbient: number;
export declare function erasedAmbientFunction(): void;
export enum RuntimeEnum {
  A,
}
export const runtimeConst = 1;
export function runtimeFunction() {}
export class RuntimeClass {}
export namespace RuntimeNamespace {}
export * as runtimeNamespaceExport from "./ns";
`;

  const ERASED = [
    "ErasedAlias",
    "ErasedInterface",
    "ErasedList",
    "ErasedSpecifier",
    "erasedAmbient",
    "erasedAmbientFunction",
  ];

  test("an erased shape is in declared and absent from runtime", () => {
    const surface = readModuleSurface("module.ts", SOURCE);

    expect(surface.runtime).toEqual([
      "Kept",
      "RuntimeClass",
      "RuntimeEnum",
      "RuntimeNamespace",
      "runtimeConst",
      "runtimeFunction",
      "runtimeNamespaceExport",
    ]);
    expect(surface.declared).toEqual(
      [
        "ErasedAlias",
        "ErasedInterface",
        "ErasedList",
        "ErasedSpecifier",
        "Kept",
        "RuntimeClass",
        "RuntimeEnum",
        "RuntimeNamespace",
        "erasedAmbient",
        "erasedAmbientFunction",
        "runtimeConst",
        "runtimeFunction",
        "runtimeNamespaceExport",
      ].sort(),
    );
  });

  test("the erased set is exactly the difference between the two lists", () => {
    const surface = readModuleSurface("module.ts", SOURCE);

    expect(surface.declared.filter((name) => !surface.runtime.includes(name))).toEqual(ERASED);
    // And nothing is invented on the runtime side: runtime is a subset of
    // declared, which is what makes "the module declares X" answerable.
    expect(surface.runtime.every((name) => surface.declared.includes(name))).toBe(true);
  });

  test("a type-only star export names nothing at all", () => {
    const surface = readModuleSurface("module.ts", `export type * from "./type-star";\n`);

    expect(surface.declared).toEqual([]);
    expect(surface.runtime).toEqual([]);
    expect(surface.stars).toEqual([]);
  });
});

describe("readModuleSurface: a binding pattern names what it exports", () => {
  // One module per spelling, because a case carrying two patterns cannot tell a
  // reader that names the property from one that names the binding: the wrong
  // answer would be in the list either way.
  const cases: Array<{ pattern: string; names: string[] }> = [
    { pattern: "export const { a } = source;", names: ["a"] },
    // The BINDING name, not the property name. `a` must not appear.
    { pattern: "export const { a: b } = source;", names: ["b"] },
    // The hole binds nothing, and the element after it still names its own.
    { pattern: "export const [first, , third] = list;", names: ["first", "third"] },
    // A nested pattern recurses, rather than stopping at the outer key.
    { pattern: "export const { outer: { inner } } = nested;", names: ["inner"] },
  ];

  for (const { pattern, names } of cases) {
    test(`\`${pattern}\` exports ${names.join(", ")}`, () => {
      const surface = readModuleSurface("module.ts", `${pattern}\n`);

      expect({ pattern, declared: surface.declared }).toEqual({ pattern, declared: names });
      // A pattern binds a value, so every one of those names runs.
      expect({ pattern, runtime: surface.runtime }).toEqual({ pattern, runtime: names });
      expect({ pattern, bindings: surface.bindings }).toEqual({ pattern, bindings: names });
    });
  }

  test("a pattern in a declaration that is not exported is a top-level binding only", () => {
    const surface = readModuleSurface("module.ts", `const { local } = source;\n`);

    expect(surface.bindings).toEqual(["local"]);
    expect(surface.declared).toEqual([]);
    expect(surface.runtime).toEqual([]);
  });

  test("a destructured export is looked up as the declaration it is, not reported missing", () => {
    const parent = `export const other = 1;\n`;
    const change = `export const { value } = { value: 7 };\nexport const other = 1;\n`;
    const augmented = augmentModuleSource(parent, change, "scripts/mod.ts", ["value"], new Map());

    // Still refused: a stand-in cannot evaluate `{ value: 7 }`, so the name has
    // no declaration to mirror. What changes is WHY. The old lookup matched
    // identifiers only, so it answered "the change composes `value` in a way this
    // gate cannot read as one declaration" — the same drift that read a real
    // export as no export, and the sentence an author had to act on was wrong
    // about the module they had written.
    expect({ ok: augmented.ok }).toEqual({ ok: false });
    if (augmented.ok) return;
    expect(augmented.refusal).toContain("scripts/mod.ts");
    expect(augmented.refusal).toContain("destructured");
  });
});

describe("readModuleSurface: the script kind comes from the extension", () => {
  // A type assertion is TypeScript grammar. Read as TypeScript, the parser takes
  // `<string>b` as an assertion and keeps going, so the statement after it is
  // still a statement. Read as JavaScript it is not grammar at all, and the
  // parser stops there — which is exactly the observable a script-kind assertion
  // needs: it cannot pass if `.js` is read with the TypeScript kind.
  const ASSERTION = `export const a = <string>b;\nexport const c = 3;\n`;

  test("a .js and a .mjs module are read as JavaScript, not as TypeScript", () => {
    const asTs = readModuleSurface("module.ts", ASSERTION);
    const asJs = readModuleSurface("module.js", ASSERTION);
    const asMjs = readModuleSurface("module.mjs", ASSERTION);

    expect(asTs.declared).toEqual(["a", "c"]);
    expect({ js: asJs.declared }).toEqual({ js: ["a"] });
    // The same text, the same JavaScript reading: the mapping is the extension's,
    // not one `.js`-shaped special case.
    expect(asMjs).toEqual(asJs);
    expect(asJs).not.toEqual(asTs);
  });

  test("an ordinary JavaScript module reads its exports and its patterns the same way", () => {
    // Whatever the kind, a module written in the syntax JavaScript also accepts
    // must read identically — that is the half that would break if the script
    // kind were chosen for the wrong reason.
    const SOURCE = `export const a = 1;\nexport function f() {}\nexport const { x } = o;\n`;

    expect(readModuleSurface("module.js", SOURCE)).toEqual({
      bindings: ["a", "f", "x"],
      declared: ["a", "f", "x"],
      runtime: ["a", "f", "x"],
      stars: [],
    });
    expect(readModuleSurface("module.mjs", SOURCE)).toEqual(readModuleSurface("module.ts", SOURCE));
  });
});

describe("readModuleSurface: what a star names", () => {
  const SOURCE = `export * from "./a";\nexport * as ns from "./b";\nexport type * from "./c";\nexport * from "./d";\n`;

  test("a bare export * reports its specifier, in source order", () => {
    const surface = readModuleSurface("module.ts", SOURCE);

    // Specifiers, not the names the targets supply: resolving those means
    // reading other files out of the parent's checkout, which `starExportNames`
    // does and this reader must not attempt. Source order is kept because the
    // first specifier that reaches a name is the one a refusal names.
    expect(surface.stars).toEqual(["./a", "./d"]);
  });

  test("a star invents no name, and `export * as ns` is not a star", () => {
    const surface = readModuleSurface("module.ts", SOURCE);

    // `export * as ns from "./b"` binds a namespace object, so it names `ns`
    // itself. Nothing else on the module is an export name, which is the whole
    // problem a resolved chain causes — see `starExportNames`.
    expect(surface.declared).toEqual(["ns"]);
    expect(surface.runtime).toEqual(["ns"]);
    expect(surface.bindings).toEqual([]);
  });
});

describe("the named readers are projections of readModuleSurface", () => {
  // This pins delegation, not behaviour: it fails only if a reader grows a rule of
  // its own again, which is the drift this seam exists to end. The behaviour is
  // pinned by the three suites above.
  const SOURCE = `
import { readFileSync } from "node:fs";
import * as fs from "node:fs";
import type { OnlyAType } from "./types";
const local = readFileSync;
export const { value } = source;
export type { OnlyAType };
export interface ErasedInterface {}
export function kept(): void {}
export * from "./base";
`;

  test("each reader returns its field of the one shape", () => {
    const surface = readModuleSurface("module.ts", SOURCE);

    expect(declaredExportNames("module.ts", SOURCE)).toEqual(surface.declared);
    expect(runtimeExportNames("module.ts", SOURCE)).toEqual(surface.runtime);
    expect(topLevelBindingNames("module.ts", SOURCE)).toEqual(surface.bindings);
    // And the shape is not empty, or the three assertions above would hold for a
    // reader that answered nothing at all.
    expect(surface.declared.length).toBeGreaterThan(0);
    expect(surface.runtime.length).toBeGreaterThan(0);
    expect(surface.bindings.length).toBeGreaterThan(0);
  });
});
