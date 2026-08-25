import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { ReceiptView } from "@/components/receipt-view";

import { buildReceipt } from "../lib/receipt";
import { tError } from "../lib/i18n";
import { orpc } from "../lib/rpc";

/**
 * Receipt printing — print-only receipt screen (/invoices/$invoiceId/print). Renders
 * the receipt document from the same invoice detail + settings reads the
 * invoice screen uses, then opens the OS print dialog via window.print()
 * (WebView2 in the Tauri shell shows the system dialog / Save-as-PDF).
 * Never any money math here: buildReceipt projects the authoritative totals.
 *
 * The auto-print fires exactly once per mount (StrictMode-safe ref gate) once
 * both reads land, with a short settle delay so fonts/layout are ready before
 * the dialog captures the page. A manual "طباعة الآن" button is the escape
 * hatch, and the document stays on screen behind the dialog for review.
 */
export function ReceiptPrintPage() {
  const { t } = useTranslation();
  const { invoiceId } = useParams({ from: "/invoices/$invoiceId/print" });

  const detail = useQuery(orpc.invoicesGet.queryOptions({ input: { id: invoiceId } }));
  const settings = useQuery(orpc.settingsGet.queryOptions());

  const ready = detail.isSuccess && settings.isSuccess;
  const printTriggered = useRef(false);

  useEffect(() => {
    if (!ready) return;
    // let the browser finish the first paint before the dialog captures it.
    // StrictMode double-mounts effects in dev (schedule → cleanup → schedule);
    // the ref gate lives INSIDE the timer callback so the second mount's timer
    // is the one that fires, exactly once. A fast unmount ahead of the timer
    // cancels the print via the cleanup.
    const timer = setTimeout(() => {
      if (printTriggered.current) return;
      printTriggered.current = true;
      window.print();
    }, 300);
    return () => clearTimeout(timer);
  }, [ready]);

  if (detail.isPending || settings.isPending) {
    return <p className="text-sm text-stone-500">{t("activityError")}</p>;
  }
  if (detail.isError || settings.isError || detail.data === undefined || settings.data === undefined) {
    const detailError = detail.error instanceof Error ? detail.error.message : undefined;
    const settingsError = settings.error instanceof Error ? settings.error.message : undefined;
    return (
      <section className="grid gap-4" data-testid="receipt-error">
        <h1 className="text-xl font-bold">{t("invoiceTitle")}</h1>
        <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700" data-testid="receipt-error-text">
          {tError(detailError ?? settingsError)}
        </p>
        <Link to="/invoices/$invoiceId" params={{ invoiceId }} className="text-sm underline">
          {t("invoiceBack")}
        </Link>
      </section>
    );
  }

  const receipt = buildReceipt(detail.data, settings.data);

  return (
    <section className="grid gap-3" data-testid="receipt-page">
      <div className="flex items-center justify-between print-hidden">
        <Link
          to="/invoices/$invoiceId"
          params={{ invoiceId }}
          className="rounded-lg border px-3 py-1 text-sm hover:bg-stone-100"
          data-testid="receipt-back"
        >
          {t("receiptBack")}
        </Link>
        <button
          type="button"
          className="rounded-lg bg-stone-900 px-3 py-1 text-sm text-white hover:bg-stone-700"
          onClick={() => window.print()}
          data-testid="receipt-print-now"
        >
          {t("receiptPrintNow")}
        </button>
      </div>
      <ReceiptView receipt={receipt} />
    </section>
  );
}