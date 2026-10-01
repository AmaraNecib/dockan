import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { formatPrintAmount } from "../lib/print-format";

/**
 * Printed documents — the shared A4 sheet primitives (issue #121). One sheet is
 * one page: its store header is repeated on every page (model 1), and the
 * footer is pinned to the foot of the sheet with the page number and the
 * document number. The page split itself is decided by the caller (see
 * lib/receipt.ts#paginateReceipt) because CSS cannot write the page counter.
 *
 * Paper colours and sizes live in index.css (.print-sheet …): sizing in rem,
 * the sheet in mm, borders in px.
 */
export function PrintSheet({
  testIdPrefix,
  storeName,
  storePhone,
  storeAddress,
  pageNumber,
  pageCount,
  documentRef,
  children,
}: {
  /** test ids follow the document: `<prefix>-sheet`, `<prefix>-store`, … */
  testIdPrefix: string;
  storeName: string;
  storePhone: string | null;
  storeAddress: string | null;
  pageNumber: number;
  pageCount: number;
  /** invoice or return number, printed at the left of the foot */
  documentRef: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <article className="print-sheet" data-testid={`${testIdPrefix}-sheet`}>
      <header>
        <div className="print-sheet-store" data-testid={`${testIdPrefix}-store`}>
          {storeName}
        </div>
        <div className="print-sheet-contacts">
          <span>
            <span className="print-sheet-label">{t("invoicePrintPhone")}</span>
            {storePhone === null ? (
              <span>—</span>
            ) : (
              <span dir="ltr" className="print-sheet-ltr" data-testid={`${testIdPrefix}-phone`}>
                {storePhone}
              </span>
            )}
          </span>
          <span>
            <span className="print-sheet-label">{t("invoicePrintAddress")}</span>
            {storeAddress === null ? <span>—</span> : <span data-testid={`${testIdPrefix}-address`}>{storeAddress}</span>}
          </span>
        </div>
        <hr className="print-sheet-rule" />
      </header>
      {children}
      <footer className="print-sheet-foot">
        <span>{storeName}</span>
        <span className="print-sheet-page" data-testid={`${testIdPrefix}-page-num`}>
          {t("invoicePrintPageOf", { page: pageNumber, total: pageCount })}
        </span>
        <span dir="ltr" className="print-sheet-ltr" data-testid={`${testIdPrefix}-ref`}>
          {documentRef}
        </span>
      </footer>
    </article>
  );
}

/**
 * A DZD amount as printed: Western grouped digits isolated LTR, then the DZD
 * currency from i18n as RTL text — which puts the currency to the LEFT of the
 * amount on the sheet.
 * (The screen's `Amount` component keeps both inside one LTR span, which reads
 * the other way around.)
 */
export function PrintAmount({ value }: { value: number }) {
  const { t } = useTranslation();
  return (
    <>
      <span dir="ltr" className="print-sheet-ltr">
        {formatPrintAmount(value)}
      </span>{" "}
      <span className="print-sheet-cur">{t("dzd")}</span>
    </>
  );
}

/** The columns every printed items table shares: a name and a quantity. */
export interface PrintItemRow {
  description: string;
  quantity: number;
}

/**
 * The items table, shared by the invoice and the return voucher. Column widths
 * live in index.css; the money columns are named by the caller because a
 * refund and a sale price read differently.
 */
export function PrintItemTable<T extends PrintItemRow>({
  title,
  titleTestId,
  tableTestId,
  rowTestId,
  unitPriceLabel,
  lineTotalLabel,
  lines,
  unitPrice,
  lineTotal,
}: {
  title?: string;
  titleTestId?: string;
  tableTestId: string;
  rowTestId: string;
  unitPriceLabel: string;
  lineTotalLabel: string;
  lines: readonly T[];
  unitPrice: (line: T) => number;
  lineTotal: (line: T) => number;
}) {
  const { t } = useTranslation();

  return (
    <table className="print-sheet-items" data-testid={tableTestId}>
      {title !== undefined && (
        <caption className="print-sheet-items-title" data-testid={titleTestId}>
          {title}
        </caption>
      )}
      <thead>
        <tr>
          <th scope="col">{t("itemsName")}</th>
          <th scope="col">{t("saleQuantity")}</th>
          <th scope="col">{unitPriceLabel}</th>
          <th scope="col">{lineTotalLabel}</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line, index) => (
          <tr key={`${line.description}-${index}`} data-testid={rowTestId}>
            <td>{line.description}</td>
            <td dir="ltr" className="print-sheet-ltr">
              {line.quantity}
            </td>
            <td className="print-sheet-money">
              <PrintAmount value={unitPrice(line)} />
            </td>
            <td className="print-sheet-money">
              <PrintAmount value={lineTotal(line)} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One totals-block row: a label and a DZD amount. The `grand` row is the
 * emphasized one and draws the divider above it only when rows precede it. */
export interface PrintTotalRow {
  label: string;
  amount: number;
  grand?: boolean;
  /** test id on the row (label + amount), for rows asserted as a unit */
  rowTestId?: string;
  /** test id on the amount span alone */
  valueTestId?: string;
}

export function PrintTotals({ rows, testId }: { rows: readonly PrintTotalRow[]; testId?: string }) {
  return (
    <div className="print-sheet-totals" data-testid={testId}>
      {rows.map((row, index) => (
        <div
          key={row.rowTestId ?? row.valueTestId ?? index}
          className={row.grand === true ? "print-sheet-grand" : undefined}
          data-testid={row.rowTestId}
        >
          <span className={row.grand === true ? undefined : "print-sheet-label"}>{row.label}</span>
          <span data-testid={row.valueTestId}>
            <PrintAmount value={row.amount} />
          </span>
        </div>
      ))}
    </div>
  );
}
