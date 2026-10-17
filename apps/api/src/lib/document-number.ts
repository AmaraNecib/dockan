import type { InvoiceKind } from "@dokan/contracts";

/**
 * #258 — the document number carries the kind of document: the owner calls the
 * number out over the counter, so the eye separates a sale from a supplier
 * purchase from a return without reaching for a filter.
 *
 * `Record<InvoiceKind, string>` is the guard: a new invoice kind in the
 * contracts enum fails typecheck until it is given a prefix here.
 */
export const invoiceNumberPrefixes = {
  SALE: "INV",
  PURCHASE: "SUP",
} as const satisfies Record<InvoiceKind, string>;

/** Customer returns. Supplier purchase returns keep their own PRT series. */
export const RETURN_NUMBER_PREFIX = "RET";

/** Every prefix is four characters (`XXX-`); the counter SQL slices the number
 * off with `substr(invoice_number, 5)`, so a longer one would mis-parse. */
export const DOCUMENT_NUMBER_PREFIX_LENGTH = 4;

/** The prefix of one invoice kind. Throws rather than minting a prefix-less
 * number when a kind reached here through a cast. */
export function invoiceNumberPrefixFor(kind: InvoiceKind): string {
  const prefix: string | undefined = invoiceNumberPrefixes[kind];
  if (prefix === undefined) throw new Error(`unknown invoice kind: ${String(kind)}`);
  return prefix;
}

/** `PREFIX-NNNN` — four digits is a floor, not a cap (10000 → `INV-10000`). */
export function formatDocumentNumber(prefix: string, sequence: number): string {
  return `${prefix}-${String(sequence).padStart(4, "0")}`;
}

export function invoiceNumberFor(kind: InvoiceKind, sequence: number): string {
  return formatDocumentNumber(invoiceNumberPrefixFor(kind), sequence);
}

export function returnNumberFor(sequence: number): string {
  return formatDocumentNumber(RETURN_NUMBER_PREFIX, sequence);
}

/**
 * The trailing digits of any document number, so a legacy `INV-0001` and a new
 * `SUP-0002` order by the number the shop knows rather than by the prefix. A
 * non-numeric legacy number (`INV-LEGACY`) reads as 0 and keeps its place ahead
 * of the numbered ones — the pre-#258 reading, unchanged.
 */
export function documentNumberSequence(documentNumber: string): number {
  const digits = /(\d+)\s*$/u.exec(documentNumber);
  return digits === null ? 0 : Number(digits[1]);
}

/**
 * The sequence of a numbered `PREFIX-NNNN` document, or undefined when the
 * value is not one — a display-only number such as the tests' `INV-RENAME-1`,
 * or digits beyond the safe range. Sorting wants the tolerant
 * `documentNumberSequence`; a reader that answers "what is the last invoice
 * number" must not let an unnumbered label win on its timestamp suffix.
 */
export function numberedDocumentSequence(documentNumber: string): number | undefined {
  const match = /^[A-Z]{3}-(\d+)$/u.exec(documentNumber);
  if (match === null) return undefined;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : undefined;
}

/** The SQL GLOB matching this prefix's numbered rows, so a counter can never
 * reissue a number that already exists (manually inserted rows included). */
export function documentNumberGlob(prefix: string): string {
  return `${prefix}-[0-9]*`;
}
