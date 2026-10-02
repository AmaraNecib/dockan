import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { ReturnVoucherView } from "@/components/return-voucher-view";

import { buildReturnVoucher } from "../lib/return-voucher";
import { tError } from "../lib/i18n";
import { orpc } from "../lib/rpc";

/**
 * Return voucher printing — print-only voucher screen
 * (/invoices/$invoiceId/returns/$returnId/print), the returns mirror of the
 * receipt route. Renders the voucher document from the stored return record
 * (rendered ON DEMAND, never a stored PDF), then opens the OS print dialog
 * via window.print(). No money math here: buildReturnVoucher projects the
 * snapshots the returnsCreate unit persisted.
 *
 * The auto-print fires exactly once per mount (StrictMode-safe ref gate) once
 * both reads land; a manual "print now" button is the escape hatch.
 */
export function ReturnVoucherPrintPage() {
  const { t } = useTranslation();
  const { invoiceId, returnId } = useParams({ from: "/invoices/$invoiceId/returns/$returnId/print" });

  const detail = useQuery(orpc.returnsGet.queryOptions({ input: { returnId } }));
  const settings = useQuery(orpc.settingsGet.queryOptions());

  const ready = detail.isSuccess && settings.isSuccess;
  // gate armed once per return: the manual button also arms it so a dialog
  // never fires twice for the same voucher
  const printTriggered = useRef<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      if (printTriggered.current === returnId) return;
      printTriggered.current = returnId;
      window.print();
    }, 300);
    return () => clearTimeout(timer);
  }, [ready, returnId]);

  if (detail.isPending || settings.isPending) {
    return <p className="text-sm text-muted-foreground" data-testid="return-voucher-loading">{t("expensesLoading")}</p>;
  }
  if (detail.isError || settings.isError || detail.data === undefined || settings.data === undefined) {
    const detailError = detail.error instanceof Error ? detail.error.message : undefined;
    const settingsError = settings.error instanceof Error ? settings.error.message : undefined;
    return (
      <section className="grid gap-4" data-testid="return-voucher-error">
        <h1 className="text-xl font-bold">{t("returnVoucherTitle")}</h1>
        <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="return-voucher-error-text">
          {tError(detailError ?? settingsError)}
        </p>
        <Link to="/invoices/$invoiceId" params={{ invoiceId }} className="text-sm underline">
          {t("invoiceBack")}
        </Link>
      </section>
    );
  }

  const voucher = buildReturnVoucher(detail.data, settings.data);

  return (
    <section className="print-page grid gap-3" data-testid="return-voucher-page">
      <div className="flex items-center justify-between print-hidden">
        <Link
          to="/invoices/$invoiceId"
          params={{ invoiceId }}
          className="rounded-lg border px-3 py-1 text-sm hover:bg-muted"
          data-testid="return-voucher-back"
        >
          {t("returnVoucherBack")}
        </Link>
        <button
          type="button"
          className="rounded-lg bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary/80"
          onClick={() => {
            printTriggered.current = returnId;
            window.print();
          }}
          data-testid="return-voucher-print-now"
        >
          {t("receiptPrintNow")}
        </button>
      </div>
      <ReturnVoucherView voucher={voucher} />
    </section>
  );
}