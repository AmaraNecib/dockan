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

  it("catches the two-step .length gate on a declared raw trim (#244 round 2)", () => {
    const synthetic = [
      "export function f(draft: string) {",
      "  const trimmed = draft.trim();",
      "  if (trimmed.length === 0) return null;",
      "  return trimmed;",
      "}",
    ].join("\n");
    expect(findBlanknessGates(synthetic, "synthetic.ts").map((gate) => gate.signature)).toEqual([
      "synthetic.ts::trimmed.length === 0 [draft.trim()]",
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
    ).toEqual(['s.ts::(drafts[line.id] ?? "").trim() !== ""']);
    // `?.trim()` is detected and canonicalised to the plain `.trim()` signature
    expect(findBlanknessGates('const a = draft?.trim() !== "";', "s.ts").map((gate) => gate.signature)).toEqual([
      's.ts::draft.trim() !== ""',
    ]);
  });
});
