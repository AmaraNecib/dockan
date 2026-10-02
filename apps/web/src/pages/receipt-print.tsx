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
 * the dialog captures the page. A manual "print now" button is the escape
 * hatch, and the document stays on screen behind the dialog for review.
 */
export function ReceiptPrintPage() {
  const { t } = useTranslation();
  const { invoiceId } = useParams({ from: "/invoices/$invoiceId/print" });

  const detail = useQuery(orpc.invoicesGet.queryOptions({ input: { id: invoiceId } }));
  const settings = useQuery(orpc.settingsGet.queryOptions());

  const ready = detail.isSuccess && settings.isSuccess;
  // gate armed once per invoice: the manual button also arms it so a
  // dialog never fires twice for the same receipt, and a later invoice
  // navigating to the same route re-arms for its own auto-print
  const printTriggered = useRef<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    // let the browser finish the first paint before the dialog captures it.
    // StrictMode double-mounts effects in dev (schedule → cleanup → schedule);
    // the ref gate lives INSIDE the timer callback so the second mount's timer
    // is the one that fires, exactly once. A fast unmount ahead of the timer
    // cancels the print via the cleanup.
    const timer = setTimeout(() => {
      if (printTriggered.current === invoiceId) return;
      printTriggered.current = invoiceId;
      window.print();
    }, 300);
    return () => clearTimeout(timer);
  }, [ready, invoiceId]);

  if (detail.isPending || settings.isPending) {
    return <p className="text-sm text-muted-foreground" data-testid="receipt-loading">{t("expensesLoading")}</p>;
  }
  if (detail.isError || settings.isError || detail.data === undefined || settings.data === undefined) {
    const detailError = detail.error instanceof Error ? detail.error.message : undefined;
    const settingsError = settings.error instanceof Error ? settings.error.message : undefined;
    return (
      <section className="grid gap-4" data-testid="receipt-error">
        <h1 className="text-xl font-bold">{t("invoiceTitle")}</h1>
        <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="receipt-error-text">
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
    <section className="print-page grid gap-3" data-testid="receipt-page">
      <div className="flex items-center justify-between print-hidden">
        <Link
          to="/invoices/$invoiceId"
          params={{ invoiceId }}
          className="rounded-lg border px-3 py-1 text-sm hover:bg-muted"
          data-testid="receipt-back"
        >
          {t("receiptBack")}
        </Link>
        <button
          type="button"
          className="rounded-lg bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary/80"
          onClick={() => {
            // a manual print arms the same gate: no double dialog if the
            // pending auto-print timer is still armed
            printTriggered.current = invoiceId;
            window.print();
          }}
          data-testid="receipt-print-now"
        >
          {t("receiptPrintNow")}
        </button>
      </div>
      <ReceiptView receipt={receipt} />
    </section>
  );
}