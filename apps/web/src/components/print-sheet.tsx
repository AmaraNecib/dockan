import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { formatPrintAmount } from "../lib/print-format";

/**
 * Printed documents — the shared A4 sheet frame (issue #121). One sheet is one
 * page: its store header is repeated on every page (model 1), and the footer is
 * pinned to the foot of the sheet with the page number and the document
 * number. The page split itself is decided by the caller (see
 * lib/receipt.ts#paginateReceipt) because CSS cannot write «صفحة X من Y».
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
              <span dir="ltr" className="print-sheet-n" data-testid={`${testIdPrefix}-phone`}>
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
        <span dir="ltr" className="print-sheet-n" data-testid={`${testIdPrefix}-ref`}>
          {documentRef}
        </span>
      </footer>
    </article>
  );
}

/**
 * A DZD amount as printed: Western grouped digits isolated LTR, then «دج» as
 * RTL text — which puts the currency to the LEFT of the amount on the sheet.
 * (The screen's `Amount` component keeps both inside one LTR span, which reads
 * the other way around.)
 */
export function PrintAmount({ value }: { value: number }) {
  const { t } = useTranslation();
  return (
    <>
      <span dir="ltr" className="print-sheet-n">
        {formatPrintAmount(value)}
      </span> <span className="print-sheet-cur">{t("dzd")}</span>
    </>
  );
}
