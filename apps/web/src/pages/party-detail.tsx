import { useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { Invoice, PartyDetail, PartyPayment, PartyRole } from "@dokan/contracts";

import { DeletePartyDialog, PartyForm } from "@/components/parties/party-forms";
import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { formatDate, formatDateTime } from "../lib/dates";
import { orpc } from "../lib/rpc";
import { tError } from "../lib/i18n";

type DetailTab = "invoices" | "payments" | "info";

const DETAIL_TABS: ReadonlyArray<{ id: DetailTab; labelKey: "partyTabsInvoices" | "partyTabsPayments" | "partyTabsInfo" }> = [
  { id: "invoices", labelKey: "partyTabsInvoices" },
  { id: "payments", labelKey: "partyTabsPayments" },
  { id: "info", labelKey: "partyTabsInfo" },
];

/** Invoice payment status, derived exactly like the invoices list filter. */
function invoiceStatusKey(invoice: Invoice): "invoicesStatusPaid" | "invoicesStatusUnpaid" | "invoicesStatusPartial" {
  if (invoice.remainingAmount === 0) return "invoicesStatusPaid";
  return invoice.paidAmount === 0 ? "invoicesStatusUnpaid" : "invoicesStatusPartial";
}

/**
 * Invoices tab row. Dates render exactly as the invoice page renders them —
 * raw Algeria-local strings — until the shared formatter lands in #119.
 */
function PartyInvoiceRow({ invoice }: { invoice: Invoice }) {
  const { t } = useTranslation();
  return (
    <tr data-testid="party-invoice-row">
      <td className="p-2" dir="ltr">
        <Link to="/invoices/$invoiceId" params={{ invoiceId: invoice.id }} className="underline-offset-4 hover:underline">
          {invoice.invoiceNumber}
        </Link>
      </td>
      {/* day-first per issue #119; no LTR wrapper — it would flip the runs */}
      <td className="p-2">{formatDate(invoice.invoiceDate)}</td>
      <td className="p-2"><Amount value={invoice.totalAmount} /></td>
      <td className="p-2"><Amount value={invoice.paidAmount} /></td>
      <td className="p-2 font-semibold"><Amount value={invoice.remainingAmount} /></td>
      <td className="p-2 text-sm text-muted-foreground">{t(invoiceStatusKey(invoice))}</td>
    </tr>
  );
}

function PartyPaymentRow({ payment }: { payment: PartyPayment }) {
  const { t } = useTranslation();
  return (
    <tr data-testid="party-payment-row">
      {/* day-first with 24-hour time per issue #119 */}
      <td className="p-2">{formatDateTime(payment.paidAt)}</td>
      <td className="p-2" dir="ltr">
        <Link to="/invoices/$invoiceId" params={{ invoiceId: payment.invoiceId }} className="underline-offset-4 hover:underline">
          {payment.invoiceNumber}
        </Link>
      </td>
      <td className="p-2"><Amount value={payment.amount} /></td>
      <td className="p-2 text-sm text-muted-foreground">{payment.method === "CASH" ? t("pmtMethod_CASH") : t("pmtMethod_BANK")}</td>
      <td className="p-2 text-sm text-muted-foreground">{payment.note ?? "—"}</td>
    </tr>
  );
}

function StatsStrip({ detail, role }: { detail: PartyDetail; role: PartyRole }) {
  const { t } = useTranslation();
  const cells: ReadonlyArray<{ labelKey: "partyStatsCount" | "partyStatsTotalSales" | "partyStatsTotalPurchases" | "partyStatsPaid" | "partyStatsRemaining"; value: number }> = [
    { labelKey: "partyStatsCount", value: detail.stats.invoiceCount },
    // money direction, not just "total": a customer's invoices are sales to
    // him, a supplier's are our purchases from him
    { labelKey: role === "customer" ? "partyStatsTotalSales" : "partyStatsTotalPurchases", value: detail.stats.totalAmount },
    { labelKey: "partyStatsPaid", value: detail.stats.paidAmount },
    { labelKey: "partyStatsRemaining", value: detail.stats.remainingAmount },
  ];
  return (
    <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="party-stats">
      {cells.map((cell) => (
        <div key={cell.labelKey} className="rounded border bg-card p-3" data-testid={`party-stat-${cell.labelKey}`}>
          <dt className="text-xs text-muted-foreground">{t(cell.labelKey)}</dt>
          <dd className="mt-1 text-lg font-bold">
            {cell.labelKey === "partyStatsCount" ? cell.value : <Amount value={cell.value} />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Customer/supplier detail (issue 120, Q7) — a full page, not a modal and not
 * an inline row: header with actions, the stats strip, and the three tabs
 * «الفواتير» / «الدفعات» / «المعلومات».
 */
export function PartyDetailPage({ role }: { role: PartyRole }) {
  const { t } = useTranslation();
  // SAFETY: both detail routes declare a $partyId segment; strict:false drops
  // the per-route generic, so the shape is asserted here from the route tree.
  const { partyId } = useParams({ strict: false }) as { partyId: string };
  const navigate = useNavigate();
  const customerDetail = useQuery({ ...orpc.customersGet.queryOptions({ input: { id: partyId } }), enabled: role === "customer" });
  const supplierDetail = useQuery({ ...orpc.suppliersGet.queryOptions({ input: { id: partyId } }), enabled: role === "supplier" });
  const detail = role === "customer" ? customerDetail : supplierDetail;

  const [tab, setTab] = useState<DetailTab>("invoices");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const backLabel = role === "customer" ? t("partyBackToCustomers") : t("partyBackToSuppliers");

  function onTabKeyDown(event: React.KeyboardEvent, index: number) {
    // RTL (Arabic is the only locale): APG inverts the horizontal mapping, so
    // ArrowLeft advances and ArrowRight goes back
    let next = index;
    if (event.key === "ArrowLeft") next = (index + 1) % DETAIL_TABS.length;
    else if (event.key === "ArrowRight") next = (index - 1 + DETAIL_TABS.length) % DETAIL_TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = DETAIL_TABS.length - 1;
    else return;
    event.preventDefault();
    const target = DETAIL_TABS[next];
    if (target === undefined) return;
    setTab(target.id);
    document.getElementById(`party-tab-${target.id}`)?.focus();
  }

  return (
    <section data-testid={`party-detail-${role}`}>
      <Link
        to={role === "customer" ? "/customers" : "/suppliers"}
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        data-testid="party-detail-back"
      >
        {backLabel}
      </Link>

      {detail.isPending ? (
        <div className="mt-4 grid gap-3" data-testid="party-detail-loading">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : detail.isError ? (
        <p className="mt-4 rounded border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive" role="alert" data-testid="party-detail-error">
          {tError(detail.error.message)}
        </p>
      ) : detail.data === undefined ? (
        <p className="mt-4 rounded border bg-card p-4 text-muted-foreground" data-testid="party-detail-missing">
          {t("PARTY_NOT_FOUND")}
        </p>
      ) : (
        <>
          <header className="mt-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold" data-testid="party-detail-name">{detail.data.party.name}</h1>
              <p className="mt-1 text-sm text-muted-foreground" dir="ltr" data-testid="party-detail-phone">
                {detail.data.party.phone ?? t("partyNoPhone")}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => { setTab("info"); setNotice(null); }} data-testid="party-detail-edit">
                {t("partyEdit")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => setDeleteOpen(true)}
                disabled={detail.data.stats.invoiceCount > 0}
                title={detail.data.stats.invoiceCount > 0 ? t("partyDeleteBlocked") : undefined}
                data-testid="party-detail-delete"
              >
                {t("partyDelete")}
              </Button>
            </div>
          </header>
          {detail.data.stats.invoiceCount > 0 && (
            <p className="mt-2 text-sm text-muted-foreground" data-testid="party-delete-blocked-hint">{t("partyDeleteBlockedHint")}</p>
          )}
          {notice !== null && (
            <p className="mt-3 rounded border border-success/30 bg-success/10 p-2 text-sm text-success" role="status" data-testid="party-detail-notice">
              {notice}
            </p>
          )}

          <StatsStrip detail={detail.data} role={role} />

          <div role="tablist" aria-label={detail.data.party.name} className="mt-6 flex gap-1 border-b border-border">
            {DETAIL_TABS.map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                id={`party-tab-${entry.id}`}
                aria-selected={tab === entry.id}
                aria-controls={`party-panel-${entry.id}`}
                tabIndex={tab === entry.id ? 0 : -1}
                onClick={() => setTab(entry.id)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
                data-testid={`party-tab-${entry.id}`}
                className={
                  tab === entry.id
                    ? "-mb-px rounded-t border-b-2 border-primary px-3 py-2 text-sm font-medium text-foreground transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    : "-mb-px rounded-t border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                }
              >
                {t(entry.labelKey)}
              </button>
            ))}
          </div>

          <div role="tabpanel" id="party-panel-invoices" aria-labelledby="party-tab-invoices" hidden={tab !== "invoices"} className="mt-4" data-testid="party-panel-invoices">
            {detail.data.invoices.length === 0 ? (
              <p className="rounded border bg-card p-4 text-sm text-muted-foreground" data-testid="party-invoices-empty">{t("partyInvoicesEmpty")}</p>
            ) : (
              <table className="w-full text-sm" data-testid="party-invoices">
                <thead>
                  <tr className="border-b text-right text-muted-foreground">
                    <th scope="col" className="p-2 font-medium">{t("debtsInvNumber")}</th>
                    <th scope="col" className="p-2 font-medium">{t("debtsInvDate")}</th>
                    <th scope="col" className="p-2 font-medium">{t("debtsInvTotal")}</th>
                    <th scope="col" className="p-2 font-medium">{t("invoicePaid")}</th>
                    <th scope="col" className="p-2 font-medium">{t("debtsInvRemaining")}</th>
                    <th scope="col" className="p-2 font-medium">{t("partyInvoiceStatus")}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.invoices.map((invoice) => (
                    <PartyInvoiceRow key={invoice.id} invoice={invoice} />
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div role="tabpanel" id="party-panel-payments" aria-labelledby="party-tab-payments" hidden={tab !== "payments"} className="mt-4" data-testid="party-panel-payments">
            {detail.data.payments.length === 0 ? (
              <p className="rounded border bg-card p-4 text-sm text-muted-foreground" data-testid="party-payments-empty">{t("partyPaymentsEmpty")}</p>
            ) : (
              <table className="w-full text-sm" data-testid="party-payments">
                <thead>
                  <tr className="border-b text-right text-muted-foreground">
                    <th scope="col" className="p-2 font-medium">{t("partyPaymentDate")}</th>
                    <th scope="col" className="p-2 font-medium">{t("partyPaymentInvoice")}</th>
                    <th scope="col" className="p-2 font-medium">{t("partyPaymentAmount")}</th>
                    <th scope="col" className="p-2 font-medium">{t("pmtMethod")}</th>
                    <th scope="col" className="p-2 font-medium">{t("partyPaymentNote")}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.payments.map((payment) => (
                    <PartyPaymentRow key={payment.id} payment={payment} />
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div role="tabpanel" id="party-panel-info" aria-labelledby="party-tab-info" hidden={tab !== "info"} className="mt-4 max-w-md" data-testid="party-panel-info">
            <div className="grid gap-3 rounded border bg-card p-4">
              <PartyForm
                key={detail.data.party.id}
                role={role}
                party={detail.data.party}
                onSaved={() => setNotice(t("partySaved"))}
              />
              <p className="text-sm text-muted-foreground">
                {t("partyCreatedAt")}:{" "}
                <span data-testid="party-created-at">{formatDateTime(detail.data.party.createdAt)}</span>
              </p>
            </div>
          </div>

          {deleteOpen && (
            <DeletePartyDialog
              role={role}
              party={detail.data.party}
              onClose={() => setDeleteOpen(false)}
              onDeleted={() => navigate({ to: role === "customer" ? "/customers" : "/suppliers" })}
            />
          )}
        </>
      )}
    </section>
  );
}
