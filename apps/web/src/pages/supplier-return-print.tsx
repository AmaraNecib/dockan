import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { Amount } from "@/components/ui/amount";

import { formatDate } from "@/lib/dates";
import { tError } from "@/lib/i18n";
import { orpc } from "@/lib/rpc";

/**
 * #161 — the purchase-return voucher (/suppliers/$partyId/returns/$returnId/print).
 * A purchase return is auto-accepted, so the voucher is the plain document of
 * the recorded fact. Rendered on demand, never stored; auto-print fires once.
 */
export function SupplierReturnPrintPage() {
  const { t } = useTranslation();
  const { partyId, returnId } = useParams({ from: "/suppliers/$partyId/returns/$returnId/print" });

  const returns = useQuery(orpc.suppliersReturnsList.queryOptions({ input: { supplierId: partyId } }));
  const settings = useQuery(orpc.settingsGet.queryOptions());
  const record = returns.data?.items.find((item) => item.id === returnId);
  const ready = returns.isSuccess && settings.isSuccess;
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

  if (returns.isPending || settings.isPending) {
    return <p className="text-sm text-muted-foreground" data-testid="supplier-return-voucher-loading">{t("expensesLoading")}</p>;
  }
  if (returns.isError || settings.isError || settings.data === undefined || record === undefined) {
    const message = returns.error instanceof Error ? returns.error.message : settings.error instanceof Error ? settings.error.message : undefined;
    return (
      <section className="grid gap-4" data-testid="supplier-return-voucher-error">
        <h1 className="text-xl font-bold">{t("supplierReturnVoucher")}</h1>
        <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive">{tError(message)}</p>
        <Link to="/returns" className="text-sm underline">{t("returnsTitle")}</Link>
      </section>
    );
  }

  return (
    <section className="print-page grid gap-3" data-testid="supplier-return-voucher-page">
      <div className="flex items-center justify-between print-hidden">
        <Link to="/returns" className="rounded-lg border px-3 py-1 text-sm hover:bg-muted" data-testid="supplier-return-voucher-back">{t("returnsTitle")}</Link>
        <button
          type="button"
          className="rounded-lg bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary/80"
          onClick={() => { printTriggered.current = returnId; window.print(); }}
          data-testid="supplier-return-voucher-print-now"
        >
          {t("receiptPrintNow")}
        </button>
      </div>
      <div className="rounded border bg-card p-6">
        <h1 className="text-lg font-bold">{settings.data.storeName}</h1>
        <h2 className="mt-1 text-base font-semibold" data-testid="supplier-return-voucher-number">{t("supplierReturnVoucher")} <span dir="ltr">{record.returnNumber}</span></h2>
        <p className="mt-1 text-sm text-muted-foreground">{formatDate(record.occurredAt)}</p>
        <p className="text-sm text-muted-foreground" data-testid="supplier-return-voucher-supplier">
          {t("supplierReturnSupplier")}: <span data-testid="supplier-return-voucher-supplier-name">{record.supplierName ?? record.supplierId}</span>
        </p>
        {record.invoiceNumber !== null && (
          <p className="text-sm text-muted-foreground">{t("supplierReturnInvoiceLink")}: <span dir="ltr">{record.invoiceNumber}</span></p>
        )}
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="border-b text-right text-muted-foreground">
              <th className="p-2 font-medium">{t("itemsName")}</th>
              <th className="p-2 font-medium">{t("supplierReturnQty")}</th>
              <th className="p-2 font-medium">{t("saleActualPrice")}</th>
              <th className="p-2 font-medium">{t("saleLineTotal")}</th>
            </tr>
          </thead>
          <tbody>
            {record.lines.map((line) => (
              <tr key={line.id} className="border-b last:border-0">
                <td className="p-2">{line.description}</td>
                <td className="p-2">{line.quantity}</td>
                {/* a free-standing line's unitCost is the item's STOCK cost, not
                    the agreed return price, so it is omitted rather than
                    printed as if it were the agreed price */}
                <td className="p-2" data-testid="supplier-return-voucher-unit">
                  {record.kind === "FREE_STANDING" ? "—" : <Amount value={line.unitCost} />}
                </td>
                <td className="p-2"><Amount value={line.amount} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="mt-4 grid gap-1 text-sm">
          <div className="flex justify-between"><dt className="text-muted-foreground">{t("returnsRefundTotal")}</dt><dd className="font-semibold"><Amount value={record.amount} /></dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">{t("supplierReturnDebtReduction")}</dt><dd><Amount value={record.debtReduction} /></dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">{t("supplierReturnCredit")}</dt><dd><Amount value={record.credit} /></dd></div>
          {record.cashBack > 0 && <div className="flex justify-between"><dt className="text-muted-foreground">{t("supplierReturnCashBack")}</dt><dd><Amount value={record.cashBack} /></dd></div>}
        </dl>
        {record.reason !== null && <p className="mt-3 text-sm text-muted-foreground">{t("returnsReason")}: {record.reason}</p>}
      </div>
    </section>
  );
}
