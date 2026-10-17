import { describe, expect, it } from "bun:test";

import { findBlanknessGates, numericReaderFiles, scanNumericDraftReaders } from "../tests/blankness-gates";

/**
 * #244 — the ratchet for raw-`.trim()` blankness gates on numeric drafts.
 *
 * #238 gave blankness one predicate (`draftBlank`) and converted four sites, but
 * left a HAND-MAINTAINED list of the remaining raw-`.trim()` gates. Review round
 * 1 on #243 found three more that the list missed. The defect is the
 * enumeration, not the three sites: a hand-written list cannot be trusted to be
 * complete, so every review round can find "three more" and "did we get them
 * all?" is unanswerable by inspection.
 *
 * This test answers it. It scans every numeric-draft reader (every non-test
 * source file that imports `amount-parse` / `numeric-input`, plus the two reader
 * modules) for DETECTED raw-`.trim()` blankness gates and fails on any detected
 * gate that is not in `CLASSIFIED`. A new detected gate is therefore red until its
 * author either converts it to `draftBlank` or writes the reason it must stay a
 * raw trim. It is not a claim about undetected gates: `blankness-gates.ts` states
 * the syntactic ceiling (truthiness tests, relational `.length`, call receivers)
 * and those forms are red in no suite here.
 *
 * The classification is a SET assertion, not a line count: line numbers drift
 * with every edit, the gate's own text does not. One limit is deliberate: a
 * *deliberate* edit that both converts a site and deletes its `raw` verdict is not
 * detected by these assertions (the pinned behaviour lives in each site's own
 * tests); what must never happen silently — a new raw gate, or a converted gate
 * coming back — is asserted and does redden.
 * The scanner lives in `src/tests/blankness-gates.ts`.
 */

/**
 * The whole enumeration. `raw` gates must stay raw (non-numeric text/date, or a
 * deliberate UX work-indicator); `draftBlank` gates were converted and must be
 * ABSENT — re-introducing one is the mutation this ratchet must catch.
 */
interface Classification {
  readonly verdict: "raw" | "draftBlank";
  readonly reason: string;
}

const TEXT = "text field, not a numeric draft: a mark-only paste is real content, not blank";
const DATE = "date field: a mark-only draft is still an unreadable date, never blank";
const BARCODE = "barcode is an identity code, not a numeric draft; a mark-only draft is content";
const DIRTY = "unsaved-work indicator, not a value decision: a pasted mark is work the discard warning must keep";

const CLASSIFIED = new Map<string, Classification>([
  ["components/parties/customer-settle-panel.tsx::value.amount.trim() !== \"\"", { verdict: "draftBlank", reason: "converted (#244): blank → no required-message; confirm stays disabled on the parsed-amount guard" }],
  ["components/parties/supplier-adjust-panel.tsx::dateDraft.trim() === \"\"", { verdict: "raw", reason: DATE }],
  ["components/parties/supplier-adjust-panel.tsx::amountDraft.trim() === \"\"", { verdict: "draftBlank", reason: "converted (#244): blank → no message; blocked on the parsed amount" }],
  ["components/parties/supplier-adjust-panel.tsx::reasonDraft.trim() === \"\"", { verdict: "raw", reason: TEXT }],
  ["components/parties/supplier-pay-panel.tsx::value.amount.trim() !== \"\"", { verdict: "draftBlank", reason: "converted (#244): blank → no required-message; confirm stays disabled on the parsed amount" }],
  ["components/parties/supplier-pay-panel.tsx::note.trim() === \"\"", { verdict: "raw", reason: TEXT }],
  ["components/parties/supplier-return-draft.ts::trimmed === \"\" [draft.trim()]", { verdict: "draftBlank", reason: "converted (#244): mark-only skips the return line and reads 0 cash-back" }],
  ["components/parties/supplier-return-panel.tsx::draft.trim() !== \"\"", { verdict: "draftBlank", reason: "converted (#244): blank → no invalid-draft banner" }],
  ["components/parties/supplier-return-panel.tsx::reason.trim() === \"\"", { verdict: "raw", reason: TEXT }],
  ["components/ui/amount-percentage-input.tsx::percentageDraft.trim() !== \"\"", { verdict: "draftBlank", reason: "converted (#244): blank → not the >100 clamp branch (outcome-neutral)" }],
  ["lib/numeric-input.ts::trimmed === \"\" [text.trim()]", { verdict: "draftBlank", reason: "converted (#244): blank → 0 on the plain path, required on the scan path" }],
  ["lib/supplier-opening-draft.ts::raw.trim() === \"\"", { verdict: "draftBlank", reason: "converted (#244): blank → untouched row" }],
  ["lib/supplier-opening-draft.ts::input.amount.trim() !== \"\"", { verdict: "draftBlank", reason: "converted (#244): blank amount → untouched / incomplete" }],
  ["lib/supplier-opening-draft.ts::name === \"\" [input.name.trim()]", { verdict: "raw", reason: TEXT }],
  ["pages/expenses.tsx::name === \"\" [newCategoryName.trim()]", { verdict: "raw", reason: TEXT }],
  ["pages/expenses.tsx::dateText === \"\" [occurredAt.trim()]", { verdict: "raw", reason: DATE }],
  ["pages/expenses.tsx::dateText !== \"\" [occurredAt.trim()]", { verdict: "raw", reason: DATE }],
  ["pages/expenses.tsx::note.trim() === \"\"", { verdict: "raw", reason: TEXT }],
  ["pages/invoice.tsx::note.trim() === \"\"", { verdict: "raw", reason: TEXT }],
  ["pages/invoice.tsx::trimmed === \"\" [draft.trim()]", { verdict: "draftBlank", reason: "converted (#244): returnQuantityError blank → null; customCashError blank → null (all-debt)" }],
  ["pages/invoice.tsx::(drafts[line.id] ?? \"\").trim() !== \"\"", { verdict: "draftBlank", reason: "converted (#244): blank → not an entered return line" }],
  ["pages/invoice.tsx::reason.trim() === \"\"", { verdict: "raw", reason: TEXT }],
  ["pages/invoice.tsx::notes.trim() === \"\"", { verdict: "raw", reason: TEXT }],
  ["pages/items.tsx::thresholdText === \"\" [threshold.trim()]", { verdict: "draftBlank", reason: "converted (#244): blank → the 5 default" }],
  ["pages/items.tsx::barcode.trim() !== \"\"", { verdict: "raw", reason: BARCODE }],
  ["pages/items.tsx::name === \"\" [draft.name.trim()]", { verdict: "raw", reason: TEXT }],
  ["pages/items.tsx::thresholdText !== \"\" [draft.threshold.trim()]", { verdict: "draftBlank", reason: "converted (#244): blank → leave the stored threshold alone" }],
  ["pages/purchase.tsx::supplier.name.trim() === \"\"", { verdict: "raw", reason: TEXT }],
  ["pages/purchase.tsx::notes.trim() === \"\"", { verdict: "raw", reason: TEXT }],
  ["pages/purchase.tsx::fields.barcode.trim() === \"\"", { verdict: "raw", reason: BARCODE }],
  ["pages/purchase.tsx::savedInvoice.counterpartyName.trim() === \"\"", { verdict: "raw", reason: TEXT }],
  ["pages/sale.tsx::quick.fields.name.trim() !== \"\"", { verdict: "raw", reason: TEXT }],
  ["pages/sale.tsx::quick.fields.barcode.trim() !== \"\"", { verdict: "raw", reason: BARCODE }],
  ["pages/sale.tsx::quick.fields.cost.trim() !== \"\"", { verdict: "raw", reason: DIRTY }],
  ["pages/sale.tsx::quick.fields.sell.trim() !== \"\"", { verdict: "raw", reason: DIRTY }],
  ["pages/sale.tsx::customer.name.trim() !== \"\"", { verdict: "raw", reason: TEXT }],
  ["pages/sale.tsx::discountValue.trim() !== \"\"", { verdict: "raw", reason: DIRTY }],
  ["pages/sale.tsx::payment.amount.trim() !== \"\"", { verdict: "raw", reason: DIRTY }],
  ["pages/sale.tsx::savedSale.counterpartyName.trim() !== \"\"", { verdict: "raw", reason: TEXT }],
  ["pages/sale.tsx::customer.name.trim() === \"\"", { verdict: "raw", reason: TEXT }],
  ["pages/sale.tsx::fields.name.trim() === \"\"", { verdict: "raw", reason: TEXT }],
  ["pages/sale.tsx::fields.barcode.trim() === \"\"", { verdict: "raw", reason: BARCODE }],
  ["pages/stock.tsx::unitCost.trim() !== \"\"", { verdict: "draftBlank", reason: "converted (#244): blank → no unit cost (api falls back to the known cost)" }],
  ["pages/supplier-opening-balance.tsx::dateDraft.trim() === \"\"", { verdict: "raw", reason: DATE }],
  ["pages/supplier-opening-balance.tsx::newName.trim() === \"\"", { verdict: "raw", reason: TEXT }],
  ["pages/supplier-opening-balance.tsx::reasonDraft.trim() === \"\"", { verdict: "raw", reason: TEXT }],
]);

describe("raw-.trim() blankness ratchet on numeric drafts (#244)", () => {
  const sources = numericReaderFiles();
  const gates = scanNumericDraftReaders();
  const present = new Map(gates.map((gate) => [gate.signature, gate]));

  it("scans the numeric-draft reader surface (non-vacuous)", () => {
    expect(sources).toContain("lib/amount-parse.ts");
    expect(sources).toContain("pages/invoice.tsx");
    expect(sources.length).toBeGreaterThan(10);
    expect(gates.length).toBeGreaterThan(20);
  });

  it("classifies every DETECTED gate, so a detected gate cannot slip in unclassified", () => {
    const unclassified = gates
      .filter((gate) => !CLASSIFIED.has(gate.signature))
      .map((gate) => `${gate.file}:${gate.line} ${gate.signature}`);
    expect(unclassified).toEqual([]);
  });

  it("keeps every raw verdict present in the source (a silent conversion reddens this)", () => {
    const missing = [...CLASSIFIED]
      .filter(([signature, classification]) => classification.verdict === "raw" && !present.has(signature))
      .map(([signature]) => signature);
    expect(missing).toEqual([]);
  });

  it("has every converted gate absent, so reverting one reddens this ratchet", () => {
    const regressed = [...CLASSIFIED]
      .filter(([signature, classification]) => classification.verdict === "draftBlank" && present.has(signature))
      .map(([signature]) => signature);
    expect(regressed).toEqual([]);
  });

  it("the scanner finds a synthetic unclassified gate (scanner self-test)", () => {
    const synthetic = [
      "export function f(draft: string) {",
      '  if (draft.trim() === "") return null;',
      "  return draft;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(synthetic, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::draft.trim() === ""',
    ]);
  });

  it("ignores gate text in a comment and does not match a call-expression receiver", () => {
    const synthetic = [
      '// if (draft.trim() === "") is discussed here',
      'export const blank = (draft: string) => normalizeArabicIndicDigits(draft).trim() === "";',
    ].join("\n");
    // A call-expression receiver is not one of the matched shapes (a receiver is
    // a member chain), so this is a stated ceiling rather than a matched-and-
    // skipped case. `draftBlankish.trim() === ""` IS caught: see the fixture in
    // the describe body.
    expect(findBlanknessGates(synthetic, "synthetic.ts")).toEqual([]);
  });

  it("catches a gate whose comparison is split across two lines (#244 round 2, finding 1)", () => {
    const synthetic = [
      "export function f(draft: string) {",
      "  if (draft.trim()",
      '    === "") return null;',
      "  return draft;",
      "}",
    ].join("\n");
    const [gate] = findBlanknessGates(synthetic, "synthetic.ts");
    expect(gate?.signature).toBe('synthetic.ts::draft.trim() === ""');
    expect(gate?.line).toBe(2);
  });

  it("catches a .trim() chain the formatter broke across lines (#244 round 2, same class)", () => {
    const splitBeforeTrim = ["export function f(draft: string) {", "  const a = draft", '    .trim() === "";', "  return a;", "}"].join("\n");
    expect(findBlanknessGates(splitBeforeTrim, "s.ts").map((gate) => gate.signature)).toEqual([
      's.ts::draft.trim() === ""',
    ]);
    const splitBeforeLength = ["export function f(draft: string) {", "  const a = draft.trim()", "    .length === 0;", "  return a;", "}"].join("\n");
    expect(findBlanknessGates(splitBeforeLength, "s.ts").map((gate) => gate.signature)).toEqual([
      "s.ts::draft.trim().length === 0",
    ]);
  });

  it("catches a declaration whose right-hand side holds a bracketed group (#244 round 2)", () => {
    const objectArgument = [
      "export function f(draft: string) {",
      "  const trimmed = parse({ raw: draft }).trim();",
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(objectArgument, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::trimmed === "" [parse({ raw: draft }).trim()]',
    ]);
    const templateArgument = [
      "export function f(draft: string) {",
      "  const trimmed = `${draft}`.trim();",
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(templateArgument, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::trimmed === "" [`${draft}`.trim()]',
    ]);
  });

  it("catches the two-step .length gate on a declared raw trim, pinning both operand orders (#244 round 2)", () => {
    const forward = [
      "export function f(draft: string) {",
      "  const trimmed = draft.trim();",
      "  if (trimmed.length === 0) return null;",
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(forward, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      "synthetic.ts::trimmed.length === 0 [draft.trim()]",
    ]);
    const reversed = [
      "export function f(draft: string) {",
      "  const trimmed = draft.trim();",
      "  if (0 === trimmed.length) return null;",
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(reversed, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      "synthetic.ts::0 === trimmed.length [draft.trim()]",
    ]);
  });

  it("catches the optional-chained .length forms (a `?.` before .length changes nothing)", () => {
    const twoStep = [
      "export function f(draft: string) {",
      "  const trimmed = draft.trim();",
      "  if (trimmed?.length === 0) return null;",
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(twoStep, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      "synthetic.ts::trimmed.length === 0 [draft.trim()]",
    ]);
    // `?.trim()?.length` canonicalises to `.trim().length`
    expect(findBlanknessGates("const a = draft?.trim()?.length === 0;", "s.ts").map((gate) => gate.signature)).toEqual([
      "s.ts::draft.trim().length === 0",
    ]);
  });

  it("scans the parenthesised nullish gate in both operand orders and with a non-literal fallback", () => {
    expect(
      findBlanknessGates('const a = (drafts[id] ?? "").trim() !== "";', "s.ts").map((gate) => gate.signature),
    ).toEqual(['s.ts::(drafts[id] ?? "").trim() !== ""']);
    expect(
      findBlanknessGates('const a = "" !== (drafts[id] ?? "").trim();', "s.ts").map((gate) => gate.signature),
    ).toEqual(['s.ts::"" !== (drafts[id] ?? "").trim()']);
    expect(
      findBlanknessGates('const a = (drafts[id] ?? fallback).trim() !== "";', "s.ts").map((gate) => gate.signature),
    ).toEqual(['s.ts::(drafts[id] ?? fallback).trim() !== ""']);
  });

  it("catches a type-annotated two-step declaration (#244 round 2)", () => {
    const synthetic = [
      "export function f(draft: string) {",
      "  const trimmed: string = draft.trim();",
      '  if (trimmed === "") return null;',
      "  let other: string | null = draft.trim();",
      '  if (other === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(synthetic, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::trimmed === "" [draft.trim()]',
      'synthetic.ts::other === "" [draft.trim()]',
    ]);
  });

  it("keeps a ?. chain receiver whole, including an optional subscript and a private field (#244 round 2)", () => {
    expect(findBlanknessGates('const a = box?.value.trim() === "";', "s.ts").map((gate) => gate.signature)).toEqual([
      's.ts::box?.value.trim() === ""',
    ]);
    expect(findBlanknessGates('const a = drafts?.[id].trim() === "";', "s.ts").map((gate) => gate.signature)).toEqual([
      's.ts::drafts?.[id].trim() === ""',
    ]);
    expect(findBlanknessGates('const a = this.#draft.trim() === "";', "s.ts").map((gate) => gate.signature)).toEqual([
      's.ts::this.#draft.trim() === ""',
    ]);
  });

  it("does not attribute a reversed property read to a visible raw declaration (#244 round 2, precision)", () => {
    const synthetic = [
      "export function f(draft: string) {",
      "  const trimmed = draft.trim();",
      '  if ("" === trimmed.suffix) return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(synthetic, "synthetic.ts")).toEqual([]);
  });

  it("keeps the two-step gate on a line that also holds an inline gate (#244 round 2, finding 1)", () => {
    const synthetic = [
      "export function f(draft: string, name: string) {",
      "  const trimmed = draft.trim();",
      '  if (name.trim() === "" || trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(synthetic, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::name.trim() === ""',
      'synthetic.ts::trimmed === "" [draft.trim()]',
    ]);
  });

  it("catches a declaration split across two lines (#244 round 2, finding 1 same class)", () => {
    const synthetic = [
      "export function f(draft: string) {",
      "  const trimmed =",
      "    draft.trim();",
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(synthetic, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::trimmed === "" [draft.trim()]',
    ]);
  });

  it("does not let an inner normalised declaration mask an outer raw gate (#244 round 2, finding 2)", () => {
    const synthetic = [
      "export function outer(draft: string) {",
      "  const trimmed = draft.trim();",
      "  {",
      "    const trimmed = normalizeArabicIndicDigits(draft).trim();",
      "    void trimmed;",
      "  }",
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(synthetic, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::trimmed === "" [draft.trim()]',
    ]);
  });

  it("pins both two-step branches and ignores a normalised declaration (#244 round 2, finding 4)", () => {
    const forward = [
      "export function f(draft: string) {",
      "  const trimmed = draft.trim();",
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(forward, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::trimmed === "" [draft.trim()]',
    ]);
    const reversed = [
      "export function f(draft: string) {",
      "  const trimmed = draft.trim();",
      '  if ("" === trimmed) return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(reversed, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::"" === trimmed [draft.trim()]',
    ]);
    const normalisedDeclaration = [
      "export function f(draft: string) {",
      "  const trimmed = normalizeArabicIndicDigits(draft).trim();",
      '  if (trimmed === "" || "" !== trimmed) return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(normalisedDeclaration, "synthetic.ts")).toEqual([]);
  });

  it("catches the reversed .length gate (#244 round 2, same class as finding 1)", () => {
    expect(findBlanknessGates("const a = 0 === draft.trim().length;", "s.ts").map((gate) => gate.signature)).toEqual([
      "s.ts::0 === draft.trim().length",
    ]);
  });

  it("does not skip a raw gate whose receiver name merely contains a normaliser name", () => {
    const synthetic = [
      "export function f(draft: string) {",
      "  const draftBlankish = draft.trim();",
      '  if (draftBlankish.trim() === "") return null;',
      "  return draftBlankish;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(synthetic, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::draftBlankish.trim() === ""',
    ]);
  });

  it("does not attribute a property read to a visible raw declaration (#244 round 2, precision)", () => {
    const synthetic = [
      "export function f(draft: string, other: { trimmed: string }) {",
      "  const trimmed = draft.trim();",
      '  if (other.trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(synthetic, "synthetic.ts")).toEqual([]);
  });

  it("names only files inside the scanned scope (a scope shrink reddens this)", () => {
    const classifiedFiles = [...new Set([...CLASSIFIED.keys()].map((signature) => signature.split("::")[0]!))];
    expect(classifiedFiles.filter((file) => !sources.includes(file))).toEqual([]);
  });

  it("scans the reversed, .length, parenthesised and optional-chained gate forms", () => {
    expect(findBlanknessGates('const a = "" === draft.trim();', "s.ts").map((gate) => gate.signature)).toEqual([
      's.ts::"" === draft.trim()',
    ]);
    expect(findBlanknessGates("const a = draft.trim().length === 0;", "s.ts").map((gate) => gate.signature)).toEqual([
      "s.ts::draft.trim().length === 0",
    ]);
    expect(
      findBlanknessGates('const a = (drafts[line.id] ?? "").trim() !== "";', "s.ts").map((gate) => gate.signature),
    ).toEqual(['s.ts::(drafts[line.id] ?? "").trim() !== ""']);    // `?.trim()` is detected and canonicalised to the plain `.trim()` signature
    expect(findBlanknessGates('const a = draft?.trim() !== "";', "s.ts").map((gate) => gate.signature)).toEqual([
      's.ts::draft.trim() !== ""',
    ]);
  });

  it("treats a template expression as code: a comment inside it cannot hide a raw check (#244 round 3, finding 1)", () => {
    // the control (no comment) was detected before the fix; the commented form
    // returned [] because stripComments treated the whole template as text.
    const control = ["export function f(draft: string) {", '  return `${draft.trim() === ""}`;', "}"].join("\n");
    expect(findBlanknessGates(control, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::draft.trim() === ""',
    ]);
    const hidden = ["export function f(draft: string) {", '  return `${draft.trim() /* blank */ === ""}`;', "}"].join("\n");
    expect(findBlanknessGates(hidden, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::draft.trim() === ""',
    ]);
  });

  it("treats a template expression as code: an inner normalised declaration cannot hide an outer raw check (#244 round 3, finding 1)", () => {
    // the control hides the outer check with a plain inner block (round 2 already
    // caught this); the same hider inside `${...}` returned [] before the fix.
    const control = [
      "export function f(draft: string) {",
      "  const trimmed = draft.trim();",
      "  {",
      "    const trimmed = normalizeArabicIndicDigits(draft).trim();",
      "    void trimmed;",
      "  }",
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(control, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::trimmed === "" [draft.trim()]',
    ]);
    const hidden = [
      "export function f(draft: string) {",
      "  const trimmed = draft.trim();",
      '  const label = `${(() => { const trimmed = normalizeArabicIndicDigits(draft).trim(); return trimmed; })()}`;',
      '  if (trimmed === "") return null;',
      "  void label;",
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(hidden, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::trimmed === "" [draft.trim()]',
    ]);
  });

  it("keeps the code region open across an inner brace inside `${}` (#244 round 3 review)", () => {
    // an object literal or arrow body inside the interpolation must not end the
    // code region early, or the rest of the template is read as TEXT again
    const gateAfterNestedBlock = [
      "export function f(draft: string) {",
      '  return `${(() => { const o = {}; return draft.trim() /* blank */ === ""; })()}`;',
      "}",
    ].join("\n");
    expect(findBlanknessGates(gateAfterNestedBlock, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::draft.trim() === ""',
    ]);
    const maskAfterNestedBlock = [
      "export function f(draft: string) {",
      "  const trimmed = draft.trim();",
      '  const label = `${(() => { const o = {}; const trimmed = normalizeArabicIndicDigits(draft).trim(); return trimmed; })()}`;',
      '  if (trimmed === "") return null;',
      "  void label;",
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(maskAfterNestedBlock, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::trimmed === "" [draft.trim()]',
    ]);
  });

  it("does not read a brace inside a string subscript as a statement break (#244 round 3 review)", () => {
    const synthetic = [
      "export function f(d: Record<string, string>) {",
      '  const trimmed = d["}"].trim();',
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(synthetic, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::trimmed === "" [d["}"].trim()]',
    ]);
  });

  it("detects a raw value selected through a normalised key (#244 round 3, finding 2)", () => {
    // the equivalent inline check was (and is) detected; the two-step form
    // returned [] because the normaliser in the SUBSCRIPT skipped the whole
    // declaration even though the selected draft is still raw.
    expect(
      findBlanknessGates('const a = drafts[normalizeArabicIndicDigits(id)].trim() === "";', "s.ts").map(
        (gate) => gate.signature,
      ),
    ).toEqual(['s.ts::drafts[normalizeArabicIndicDigits(id)].trim() === ""']);
    const hidden = [
      "export function f(drafts: Record<string, string>, id: string) {",
      "  const trimmed = drafts[normalizeArabicIndicDigits(id)].trim();",
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(hidden, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::trimmed === "" [drafts[normalizeArabicIndicDigits(id)].trim()]',
    ]);
    // precision: a receiver whose VALUE is normalised is still ignored, and so is
    // a normaliser inside an argument (the trimmed value comes from the normaliser)
    const normalisedValue = [
      "export function f(draft: string) {",
      "  const trimmed = normalizeArabicIndicDigits(draft).trim();",
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(normalisedValue, "synthetic.ts")).toEqual([]);
    const normalisedArgument = [
      "export function f(drafts: Record<string, string>, id: string) {",
      "  const trimmed = normalizeArabicIndicDigits(drafts[id]).trim();",
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(normalisedArgument, "synthetic.ts")).toEqual([]);
    // ...but a normaliser that is only an ARGUMENT of another call does not
    // normalise the value the call returns, so that declaration is raw
    const wrappedArgument = [
      "export function f(id: string) {",
      "  const trimmed = parseIdentity(normalizeArabicIndicDigits(id)).trim();",
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(wrappedArgument, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::trimmed === "" [parseIdentity(normalizeArabicIndicDigits(id)).trim()]',
    ]);
  });

  it("does not skip a raw gate when the normaliser does not wrap the whole value (#244 round 4, finding 1)", () => {
    // BEFORE the fix this returned []: `NORMALISED_VALUE`'s `.*` consumed the
    // trailing `.concat(draft)`, so the prefix-only normalisation looked whole.
    const appended = [
      "export function f(prefix: string, draft: string) {",
      "  const trimmed = normalizeArabicIndicDigits(prefix).concat(draft).trim();",
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(appended, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::trimmed === "" [normalizeArabicIndicDigits(prefix).concat(draft).trim()]',
    ]);
    // precision: the normaliser's own result IS the whole value, so it is still
    // skipped; a `)` inside a string argument must not end the call early.
    const wholeValue = [
      "export function f(draft: string) {",
      "  const trimmed = normalizeArabicIndicDigits(draft).trim();",
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(wholeValue, "synthetic.ts")).toEqual([]);
    const stringArgument = [
      "export function f(draft: string) {",
      '  const trimmed = normalizeArabicIndicDigits(draft.replace(")", "")).trim();',
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(stringArgument, "synthetic.ts")).toEqual([]);
  });

  it("keeps a block comment as a token separator so the declaration survives (#244 round 4, finding 2)", () => {
    // BEFORE the fix the comment was removed with no separator, so
    // `const/* note */trimmed` became `consttrimmed`, `DECL` lost the
    // declaration, and the following `trimmed === ""` produced no gate.
    const joined = [
      "export function f(draft: string) {",
      "  const/* note */trimmed = draft.trim();",
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(joined, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::trimmed === "" [draft.trim()]',
    ]);
    // the spaced control already passed; it stays caught
    const spaced = [
      "export function f(draft: string) {",
      "  const /* note */ trimmed = draft.trim();",
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(spaced, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::trimmed === "" [draft.trim()]',
    ]);
    // a comment BETWEEN the receiver and `.trim()` must not become `. trim()`:
    // round 4 review found the always-a-space version lost this gate, a
    // regression on a shape the pre-fix scanner caught.
    const insideChain = [
      "export function f(draft: string) {",
      "  const trimmed = draft./* gap */trim();",
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(insideChain, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::trimmed === "" [draft.trim()]',
    ]);
    // a private-field receiver stays whole; a comment before `.trim()` is
    // trivia (the #244 source put the comment INSIDE the private name
    // `this.#/* gap */draft`, which is a syntax error — the regex tolerated it by
    // string surgery, a real parser cannot. Same receiver, same signature, valid
    // syntax).
    const privateField = [
      "class Box {",
      '  #draft = "";',
      "  blank() {",
      '    if (this.#draft./* gap */trim() === "") return true;',
      "    return false;",
      "  }",
      "}",
    ].join("\n");
    expect(findBlanknessGates(privateField, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::this.#draft.trim() === ""',
    ]);
  });

  it("does not read a `;` inside a nested template as a statement break (#244 round 4, finding 3)", () => {
    // BEFORE the fix `breaksStatement` treated backticks as flat quotes, so the
    // inner backtick closed the outer template and the `;` in its TEXT read as a
    // statement break: the declaration was discarded and the gate was lost.
    const nested = [
      "export function f(flag: boolean, draft: string) {",
      "  const trimmed = `${flag ? `;` : draft}`.trim();",
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(nested, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      'synthetic.ts::trimmed === "" [`${flag ? `;` : draft}`.trim()]',
    ]);
  });

  it("reads JSX child text inside a template expression as text, not code (#244 round 5, finding 1)", () => {
    // BEFORE the fix these returned []: round 4's `${}` frame stack read the JSX
    // child as code, so the unmatched `)` (or `]`) at bracket depth 0 looked like
    // the end of the statement, the declaration was discarded, and a raw gate
    // escaped. The round-3 scanner (flat backticks) caught both.
    const closingParen = [
      "export function f(flag: boolean, draft: string) {",
      "  const trimmed = `${flag ? <span>)</span> : draft}`.trim();",
      '  if (trimmed === "") return null;',
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(closingParen, "s.tsx").map((gate) => gate.signature)).toEqual([
      's.tsx::trimmed === "" [`${flag ? <span>)</span> : draft}`.trim()]',
    ]);
    const closingBracket = closingParen.replace("<span>)</span>", "<span>]</span>");
    expect(findBlanknessGates(closingBracket, "s.tsx").map((gate) => gate.signature)).toEqual([
      's.tsx::trimmed === "" [`${flag ? <span>]</span> : draft}`.trim()]',
    ]);
    // a `}` in JSX child text was already caught before this change (it closes
    // the interpolation early in both passes, and the rest of the template is
    // read as text); it stays caught
    const closingBrace = closingParen.replace("<span>)</span>", "<span>}</span>");
    expect(findBlanknessGates(closingBrace, "s.tsx").map((gate) => gate.signature)).toEqual([
      's.tsx::trimmed === "" [`${flag ? <span>}</span> : draft}`.trim()]',
    ]);
  });
});

/**
 * #249 — the AST walk replaces the regex scanner. Every fixture here is either
 * failing-first against the regex scanner (recorded in
 * `.scratch/reviews/249/ad8445f-before.log`) or a precision pin for a shape the
 * regex reported wrongly. The `#244` fixtures above are ported unchanged and must
 * keep passing: the whole value of the ratchet is that the classification set did
 * not move.
 */
describe("the AST blankness walk (#249)", () => {
  const signatures = (source: string) =>
    findBlanknessGates(source, "s.ts").map((gate) => gate.signature);

  it("sees a comment in any position as trivia, including inside a chain", () => {
    // already caught by #244 round 4; kept so the replacement cannot lose it
    expect(signatures(['const t = draft./* gap */trim();', 'const b = t === "";'].join("\n"))).toEqual([
      's.ts::t === "" [draft.trim()]',
    ]);
    expect(signatures(["const/* note */t = draft.trim();", 'const b = t === "";'].join("\n"))).toEqual([
      's.ts::t === "" [draft.trim()]',
    ]);
  });

  it("is not desynced by a regex literal holding a quote, a slash, or a backtick", () => {
    // BEFORE: `/"` opened a flat quote region for the rest of the file and
    // `/[/*]/` opened a block comment that HID every later gate.
    expect(signatures(['const re = /"/;', 'const b = draft.trim() === "";'].join("\n"))).toEqual([
      's.ts::draft.trim() === ""',
    ]);
    expect(
      signatures(["const re = /[/*]/;", "const t = draft.trim();", 'if (t === "") return;'].join("\n")),
    ).toEqual(['s.ts::t === "" [draft.trim()]']);
    expect(signatures('const re = /[//]/; const b = draft.trim() === "";')).toEqual([
      's.ts::draft.trim() === ""',
    ]);
    expect(signatures(["const re = /[`]/;", 'const b = draft.trim() === "";'].join("\n"))).toEqual([
      's.ts::draft.trim() === ""',
    ]);
  });

  it("does not invent a gate from gate-shaped TEXT in a string or template", () => {
    // BEFORE both reported a phantom `draft.trim() === ""` because string and
    // template TEXT was scanned as code. Text is now a literal node, not code.
    expect(signatures(`const s = 'draft.trim() === ""';`)).toEqual([]);
    expect(signatures('const s = `draft.trim() === ""`;')).toEqual([]);
  });

  it("still scans an interpolation as code and nests templates", () => {
    expect(signatures('const b = `${draft.trim() === ""}`;')).toEqual([
      's.ts::draft.trim() === ""',
    ]);
    expect(
      signatures(
        ["const t = `${flag ? `;` : draft}`.trim();", 'const b = t === "";'].join("\n"),
      ),
    ).toEqual(['s.ts::t === "" [`${flag ? `;` : draft}`.trim()]']);
  });

  it("sees a non-ASCII identifier binding the regex could not match", () => {
    // BEFORE: DECL/USE were `[A-Za-z_$][\w$]*`; `\w` excludes `é`, so the
    // declaration and the gate both vanished.
    expect(signatures(["const dé = draft.trim();", 'const b = dé === "";'].join("\n"))).toEqual([
      's.ts::dé === "" [draft.trim()]',
    ]);
  });

  it("catches an appended call on the normaliser, inline and two-step", () => {
    // the receiver IS the whole value, so a trailing `.concat(...)` is raw
    expect(
      signatures(
        [
          "const t = normalizeArabicIndicDigits(prefix).concat(draft).trim();",
          'const b = t === "";',
        ].join("\n"),
      ),
    ).toEqual(['s.ts::t === "" [normalizeArabicIndicDigits(prefix).concat(draft).trim()]']);
    // BEFORE: an inline call receiver did not match `CHAIN` at all
    expect(
      signatures('const b = normalizeArabicIndicDigits(prefix).concat(draft).trim() === "";'),
    ).toEqual(['s.ts::normalizeArabicIndicDigits(prefix).concat(draft).trim() === ""']);
  });

  it("resolves two-step declarations through real scopes, not brace guessing", () => {
    // the inner normalised `t` must not mask the outer raw one at the outer check
    const outer = [
      "const t = draft.trim();",
      "{",
      "  const t = normalizeArabicIndicDigits(draft).trim();",
      "  void t;",
      "}",
      'if (t === "") return;',
    ].join("\n");
    expect(signatures(outer)).toEqual(['s.ts::t === "" [draft.trim()]']);
    // ...and inside the inner block the normalised declaration is what is visible
    const inner = [
      "const t = draft.trim();",
      "{",
      "  const t = normalizeArabicIndicDigits(draft).trim();",
      '  if (t === "") return;',
      "}",
      "void t;",
    ].join("\n");
    expect(signatures(inner)).toEqual([]);
  });

  it("scopes a for-init binding to its loop, so it cannot mask an outer raw gate", () => {
    // BEFORE (Greptile #251 finding 1): `nearestScope` walked past the
    // ForStatement to the surrounding block, so the loop's normalised `t` was
    // treated as visible after the loop and the outer raw check vanished as a
    // silent []. A loop is the scope for its own `let`/`const` bindings.
    const source = [
      "const t = draft.trim();",
      "for (let t = normalizeArabicIndicDigits(other).trim(); keepGoing;) {}",
      'if (t === "") return;',
    ].join("\n");
    expect(signatures(source)).toEqual(['s.ts::t === "" [draft.trim()]']);
    // ...and inside the loop body the loop binding is the visible one, so its
    // normalised check is not a raw gate.
    const inner = [
      "const t = draft.trim();",
      "for (let t = normalizeArabicIndicDigits(other).trim(); keepGoing;) {",
      '  if (t === "") return;',
      "}",
    ].join("\n");
    expect(signatures(inner)).toEqual([]);
  });

  it("treats any receiver the parser gives exactly, not only a member chain", () => {
    // BEFORE these were the stated `CHAIN` ceiling and returned []
    expect(signatures('const b = f().trim() === "";')).toEqual(['s.ts::f().trim() === ""']);
    expect(signatures('const b = (draft as string).trim() === "";')).toEqual([
      's.ts::(draft as string).trim() === ""',
    ]);
    expect(signatures('const b = (draft).trim() === "";')).toEqual(['s.ts::(draft).trim() === ""']);
    expect(signatures('const b = draft!.trim() === "";')).toEqual(['s.ts::draft!.trim() === ""']);
    expect(signatures('const b = draft.trim().trim() === "";')).toEqual([
      's.ts::draft.trim().trim() === ""',
    ]);
  });

  it("sees a `var` binding and a second declarator on one line", () => {
    // BEFORE `var` was not collected at all and the second declarator was lost
    expect(signatures(["var t = draft.trim();", 'const b = t === "";'].join("\n"))).toEqual([
      's.ts::t === "" [draft.trim()]',
    ]);
    expect(
      signatures(["const t = draft.trim(), u = e.trim();", 'const b = t === "" || u === "";'].join("\n")),
    ).toEqual(['s.ts::t === "" [draft.trim()]', 's.ts::u === "" [e.trim()]']);
  });

  it("skips a receiver that IS the normaliser's own result and no other", () => {
    expect(signatures('const b = normalizeArabicIndicDigits(draft).trim() === "";')).toEqual([]);
    expect(signatures('const b = (normalizeArabicIndicDigits(draft)).trim() === "";')).toEqual([]);
    expect(signatures('const b = drafts[normalizeArabicIndicDigits(id)].trim() === "";')).toEqual([
      's.ts::drafts[normalizeArabicIndicDigits(id)].trim() === ""',
    ]);
  });

  it("refuses a truthiness test on a raw trim instead of skipping it", () => {
    // the failure mode this ticket exists to end: a blind spot that reports
    // nothing. An unhandled boolean shape is a loud refusal, not silence.
    expect(() => findBlanknessGates("if (!draft.trim()) return;", "s.ts")).toThrow(/unhandled/i);
    expect(() => findBlanknessGates("if (draft.trim()) return;", "s.ts")).toThrow(/unhandled/i);
    expect(() => findBlanknessGates("const b = draft.trim() ? 1 : 2;", "s.ts")).toThrow(/unhandled/i);
    expect(() => findBlanknessGates("const b = draft.trim() && other;", "s.ts")).toThrow(/unhandled/i);
  });

  it("follows a comma expression to its right-most operand, so a wrapped test is refused", () => {
    // BEFORE (Greptile #251 finding 2): `refuseIfTestPosition` stopped at the
    // comma BinaryExpression, so the wrapped truthiness test returned [] without
    // throwing. The tested value is the comma's right-most operand.
    expect(() => findBlanknessGates("if ((logDraft(), draft.trim())) return;", "s.ts")).toThrow(
      /unhandled/i,
    );
    expect(() => findBlanknessGates("const b = (logDraft(), draft.trim()) ? 1 : 2;", "s.ts")).toThrow(
      /unhandled/i,
    );
    // ...a discarded left operand is not the tested value, so it is not refused
    expect(signatures("if ((draft.trim(), logDraft())) return;")).toEqual([]);
  });

  it("refuses a relational trim test and an empty-template operand", () => {
    expect(() => findBlanknessGates("const b = draft.trim().length > 0;", "s.ts")).toThrow(/unhandled/i);
    expect(() => findBlanknessGates("const b = draft.trim().length >= 1;", "s.ts")).toThrow(/unhandled/i);
    expect(() => findBlanknessGates("const b = draft.trim() === ``;", "s.ts")).toThrow(/unhandled/i);
  });

  it("does not refuse a normalised trim in a boolean position (it is not a raw gate)", () => {
    expect(signatures('const b = !normalizeArabicIndicDigits(draft).trim();')).toEqual([]);
    expect(signatures('const b = normalizeArabicIndicDigits(draft).trim().length > 0;')).toEqual([]);
  });

  it("refuses a truthiness test on a raw trim's length, inline and two-step", () => {
    // the `.length` path was silently dropped before this: `x.trim().length`
    // truthiness is `!== 0` — the same blankness gate as the refused relational form.
    expect(() => findBlanknessGates("if (draft.trim().length) return;", "s.ts")).toThrow(/unhandled/i);
    expect(() => findBlanknessGates("const b = !draft.trim().length;", "s.ts")).toThrow(/unhandled/i);
    expect(() => findBlanknessGates("const b = draft.trim().length ? 1 : 2;", "s.ts")).toThrow(/unhandled/i);
    expect(() => findBlanknessGates("const b = draft.trim().length && other;", "s.ts")).toThrow(/unhandled/i);
    expect(() =>
      findBlanknessGates(["const t = draft.trim();", "if (t.length) return;"].join("\n"), "s.ts"),
    ).toThrow(/unhandled/i);
    // ...but a length VALUE (not a test) is a plain use
    expect(signatures("const n = draft.trim().length;")).toEqual([]);
  });

  it("sees the `draftBlank` normaliser as normalised too, not only `normalizeArabicIndicDigits`", () => {
    expect(signatures('const b = draftBlank(draft).trim() === "";')).toEqual([]);
    expect(signatures('const b = draftBlankish(draft).trim() === "";')).toEqual([
      's.ts::draftBlankish(draft).trim() === ""',
    ]);
  });

  it("hoists a `var` binding to the function, so a closed block does not hide it", () => {
    const source = ["{", "  var t = draft.trim();", "}", 'if (t === "") return;'].join("\n");
    expect(signatures(source)).toEqual(['s.ts::t === "" [draft.trim()]']);
  });

  it("pins the lexical-scope ceiling: a parameter shadowing a raw local is mis-attributed", () => {
    // stated ceiling (visibility is lexical, not typed): the parameter `t` hides
    // the outer raw declaration, yet the comparison is attributed to the outer
    // trim. Pinned so the ceiling cannot shift silently.
    const source = [
      "const t = draft.trim();",
      'function g(t: string) { return t === ""; }',
      "void g;",
    ].join("\n");
    expect(signatures(source)).toEqual(['s.ts::t === "" [draft.trim()]']);
  });

  it("accepts the empty source and a comment-only source, and counts lines with CRLF", () => {
    expect(findBlanknessGates("", "s.ts")).toEqual([]);
    expect(findBlanknessGates('// draft.trim() === ""\n', "s.ts")).toEqual([]);
    const [gate] = findBlanknessGates('const t = draft.trim();\r\nconst b = t === "";\r\n', "s.ts");
    expect(gate?.line).toBe(2);
  });

  it("canonicalises a single-quoted blank operand", () => {
    expect(signatures("const b = draft.trim() === '';")).toEqual(['s.ts::draft.trim() === ""']);
  });

  it("does not refuse an ordinary value use of a raw trim", () => {
    expect(signatures("setDebounced(query.trim());")).toEqual([]);
    expect(signatures("const label = `x ${draft.trim()} y`;")).toEqual([]);
    expect(signatures("const b = current.name.trim() === current.baseline.name;")).toEqual([]);
  });

  it("keeps a gate's identity when a comment moves into the receiver", () => {
    // a comment inside a chain is trivia, not canonical text: the signature must
    // match the uncommented form or a harmless comment edit invalidates a
    // CLASSIFIED entry (and quietly re-tightens the ratchet).
    expect(signatures('const b = draft./* gap */amount.trim() === "";')).toEqual([
      's.ts::draft.amount.trim() === ""',
    ]);
    expect(
      signatures(["const t = draft./* gap */amount.trim();", 'const b = t === "";'].join("\n")),
    ).toEqual(['s.ts::t === "" [draft.amount.trim()]']);
  });

  it('keeps the `trim() ?? ""` fallback binding the regex scanner reported', () => {
    // BEFORE this returned []: the initializer is a `??` expression, so `t` was
    // not collected and `t === ""` found no declaration — a gate the regex
    // scanner reported silently vanished instead of being refused.
    expect(signatures(["const t = draft?.trim() ?? \"\";", 'const b = t === "";'].join("\n"))).toEqual([
      's.ts::t === "" [draft.trim()]',
    ]);
    expect(signatures(["const t = draft.trim() ?? '';", 'if (t === "") return;'].join("\n"))).toEqual([
      's.ts::t === "" [draft.trim()]',
    ]);
  });

  it("refuses a truthiness test on a bound raw trim, not only on the call", () => {
    const bind = "const t = draft.trim();\n";
    expect(() => findBlanknessGates(`${bind}if (t) return;`, "s.ts")).toThrow(/unhandled/i);
    expect(() => findBlanknessGates(`${bind}if (!t) return;`, "s.ts")).toThrow(/unhandled/i);
    expect(() => findBlanknessGates(`${bind}const b = t ? 1 : 2;`, "s.ts")).toThrow(/unhandled/i);
    expect(() => findBlanknessGates(`${bind}const b = t && other;`, "s.ts")).toThrow(/unhandled/i);
    expect(() => findBlanknessGates(`${bind}while (t) {}`, "s.ts")).toThrow(/unhandled/i);
    // ...but a comparison is the classified gate, and a value use is not a test
    expect(signatures([bind, 'const b = t === "";'].join("\n"))).toEqual(['s.ts::t === "" [draft.trim()]']);
    expect(signatures([bind, "void t;"].join("\n"))).toEqual([]);
  });
});
