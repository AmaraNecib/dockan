import { useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { Invoice, PartyDetail, PartyPayment, PartyRole, SupplierAccountEntry } from "@dokan/contracts";
import { displayAlgerianPhone } from "@dokan/contracts";

import { CustomerSettlePanel } from "@/components/parties/customer-settle-panel";
import { SupplierAdjustPanel } from "@/components/parties/supplier-adjust-panel";
import { SupplierPayPanel } from "@/components/parties/supplier-pay-panel";
import { SupplierRefundPanel } from "@/components/parties/supplier-refund-panel";
import { SupplierReturnPanel } from "@/components/parties/supplier-return-panel";
import { unpaidInvoices, unpaidTotal } from "@/components/parties/party-settle";
import { DeletePartyDialog, PartyForm } from "@/components/parties/party-forms";
import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { Pager } from "@/components/ui/pager";
import { Skeleton } from "@/components/ui/skeleton";

import { formatDate, formatDateTime } from "../lib/dates";
import { PARTY_INVOICES_QUERY_KEY, PARTY_PAYMENTS_QUERY_KEY, SUPPLIER_ENTRIES_QUERY_KEY } from "../lib/query-keys";
import { usePagination } from "../hooks/use-pagination";
import { orpc } from "../lib/rpc";
import { tError } from "../lib/i18n";
import { supplierEntryDirectionKey, supplierEntrySignLabel } from "../lib/supplier-entry-display";

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
      <td className="p-2 cell-ltr">
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
      <td className="p-2 cell-ltr">
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

/** #161/#176 — one signed supplier-account entry. The amount is shown with the
 * direction its kind implies (a purchase/refund adds to what we owe, a
 * payment/return reduces it, an adjustment follows its own direction). */
function SupplierAccountRow({ entry }: { entry: SupplierAccountEntry }) {
  const { t } = useTranslation();
  const sign = supplierEntrySignLabel(entry);
  const directionKey = supplierEntryDirectionKey(entry);
  const directionLabel = directionKey === null ? null : t(directionKey);
  return (
    <tr data-testid="supplier-account-row">
      <td className="p-2">{formatDateTime(entry.occurredAt)}</td>
      <td className="p-2 text-sm" data-testid={`supplier-entry-kind-${entry.kind}`}>
        {t(`supplierEntry_${entry.kind}`)}
        {directionLabel !== null && <span className="text-muted-foreground" data-testid="supplier-entry-direction"> · {directionLabel}</span>}
      </td>
      <td className="p-2 cell-ltr">
        {entry.invoiceId === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <Link to="/invoices/$invoiceId" params={{ invoiceId: entry.invoiceId }} className="underline-offset-4 hover:underline">
            {entry.invoiceNumber ?? entry.invoiceId}
          </Link>
        )}
      </td>
      <td className="p-2 font-medium" data-testid="supplier-entry-amount">
        {sign} <Amount value={entry.amount} />
      </td>
      <td className="p-2 text-sm text-muted-foreground">{entry.ref ?? entry.note ?? "—"}</td>
    </tr>
  );
}

/** The supplier's signed balance header: what we owe (positive) or the credit
 * we hold (negative). */
function SupplierBalanceHeader({ balance }: { balance: number }) {
  const { t } = useTranslation();
  const owed = balance >= 0;
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded border bg-card p-4" data-testid="supplier-balance">
      <div>
        <p className="text-xs text-muted-foreground">{owed ? t("supplierBalanceOwed") : t("supplierBalanceCredit")}</p>
        <p className={`mt-1 text-2xl font-bold ${owed ? "" : "text-success"}`} data-testid="supplier-balance-value">
          <Amount value={Math.abs(balance)} />
        </p>
      </div>
    </div>
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
  const queryClient = useQueryClient();
  const customerDetail = useQuery({ ...orpc.customersGet.queryOptions({ input: { id: partyId } }), enabled: role === "customer" });
  const supplierDetail = useQuery({ ...orpc.suppliersGet.queryOptions({ input: { id: partyId } }), enabled: role === "supplier" });
  const detail = role === "customer" ? customerDetail : supplierDetail;

  const [tab, setTab] = useState<DetailTab>("invoices");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // #164 (customer half) — the invoices tab opens on what is still owed, with
  // an in-page settle action. Supplier-account behaviour is #161.
  const customerScope = role === "customer";
  const [unpaidOnly, setUnpaidOnly] = useState(true);
  const [settleOpen, setSettleOpen] = useState(false);
  // #161 — supplier account actions (pay / return / refund / adjust) open in place.
  const [supplierAction, setSupplierAction] = useState<"pay" | "return" | "refund" | "adjust" | null>(null);
  const account = detail.data?.account ?? null;
  const allInvoices = detail.data?.invoices ?? [];
  const unpaid = unpaidInvoices(allInvoices);
  const showUnpaidOnly = customerScope && unpaidOnly;
  // the settle cap and the distribution both walk the invoice rows, so the
  // reference is their sum too — never a second, potentially divergent stat
  const unpaidAmount = unpaidTotal(allInvoices);

  // #174 — the TABS page. The settle/pay panels, the unpaid total, and the
  // delete guard keep reading the FULL `detail.data` above; only these reads
  // are paginated.
  const invoicePager = usePagination();
  const paymentPager = usePagination();
  const invoiceList = useQuery({
    ...orpc.partyInvoices.queryOptions({
      input: { role, id: partyId, unpaidOnly: showUnpaidOnly, ...invoicePager.pagination },
    }),
    enabled: detail.data !== undefined,
  });
  const paymentList = useQuery({
    ...orpc.partyPayments.queryOptions({ input: { role, id: partyId, ...paymentPager.pagination } }),
    enabled: detail.data !== undefined && role === "customer",
  });
  const entryList = useQuery({
    ...orpc.supplierEntries.queryOptions({ input: { id: partyId, ...paymentPager.pagination } }),
    enabled: detail.data !== undefined && role === "supplier",
  });

  // the shared panels invalidate customersGet/suppliersGet; the tab queries
  // carry their own keys, so refresh them here after money moves. The constants
  // are the double-nested oRPC path prefix (a string-first key is a no-op).
  function refreshTabQueries() {
    void queryClient.invalidateQueries({ queryKey: PARTY_INVOICES_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: PARTY_PAYMENTS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: SUPPLIER_ENTRIES_QUERY_KEY });
  }

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
                {detail.data.party.phone === null ? t("partyNoPhone") : displayAlgerianPhone(detail.data.party.phone)}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => { setTab("info"); setNotice(null); }} data-testid="party-detail-edit">
                {t("partyEdit")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => setDeleteOpen(true)}
                disabled={detail.data.stats.invoiceCount > 0 || (account?.entries.length ?? 0) > 0}
                title={detail.data.stats.invoiceCount > 0 || (account?.entries.length ?? 0) > 0 ? t("partyDeleteBlocked") : undefined}
                data-testid="party-detail-delete"
              >
                {t("partyDelete")}
              </Button>
            </div>
          </header>
          {(detail.data.stats.invoiceCount > 0 || (account?.entries.length ?? 0) > 0) && (
            <p className="mt-2 text-sm text-muted-foreground" data-testid="party-delete-blocked-hint">{t("partyDeleteBlockedHint")}</p>
          )}
          {notice !== null && (
            <p className="mt-3 rounded border border-success/30 bg-success/10 p-2 text-sm text-success" role="status" data-testid="party-detail-notice">
              {notice}
            </p>
          )}

          <StatsStrip detail={detail.data} role={role} />

          {role === "supplier" && account !== null && (
            <>
              <SupplierBalanceHeader balance={account.balance} />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={() => { setSupplierAction("pay"); setNotice(null); }} data-testid="supplier-action-pay">{t("supplierActionPay")}</Button>
                <Button variant="outline" onClick={() => { setSupplierAction("adjust"); setNotice(null); }} data-testid="supplier-action-adjust">{t("supplierActionAdjust")}</Button>
                <Button variant="outline" onClick={() => { setSupplierAction("return"); setNotice(null); }} data-testid="supplier-action-return">{t("supplierActionReturn")}</Button>
                {account.balance < 0 && (
                  <Button variant="outline" onClick={() => { setSupplierAction("refund"); setNotice(null); }} data-testid="supplier-action-refund">{t("supplierActionRefund")}</Button>
                )}
              </div>
              {supplierAction !== null && (
                <div className="mt-4">
                  {supplierAction === "pay" && (
                    <SupplierPayPanel
                      supplierId={partyId}
                      balance={account.balance}
                      invoices={detail.data.invoices}
                      onDone={() => { refreshTabQueries(); setSupplierAction(null); setNotice(t("supplierPayRecorded")); }}
                      onCancel={() => setSupplierAction(null)}
                    />
                  )}
                  {supplierAction === "return" && (
                    <SupplierReturnPanel
                      supplierId={partyId}
                      invoices={detail.data.invoices}
                      onDone={() => { refreshTabQueries(); setSupplierAction(null); setNotice(t("supplierReturnRecorded")); }}
                      onCancel={() => setSupplierAction(null)}
                    />
                  )}
                  {supplierAction === "adjust" && (
                    <SupplierAdjustPanel
                      supplierId={partyId}
                      supplierName={detail.data.party.name}
                      balance={account.balance}
                      invoices={detail.data.invoices}
                      onDone={() => { refreshTabQueries(); setSupplierAction(null); setNotice(t("supplierAdjustRecorded")); }}
                      onCancel={() => setSupplierAction(null)}
                    />
                  )}
                  {supplierAction === "refund" && (
                    <SupplierRefundPanel
                      supplierId={partyId}
                      availableCredit={Math.max(0, -account.balance)}
                      onDone={() => { refreshTabQueries(); setSupplierAction(null); setNotice(t("supplierRefundRecorded")); }}
                      onCancel={() => setSupplierAction(null)}
                    />
                  )}
                </div>
              )}
            </>
          )}

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
            {customerScope && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={unpaidOnly}
                    onChange={(event) => {
                      setUnpaidOnly(event.target.checked);
                      // a filter change invalidates the old offset: page 1
                      invoicePager.reset();
                    }}
                    data-testid="party-unpaid-filter"
                  />
                  {t("partyUnpaidOnly")}
                </label>
                <span className="text-sm text-muted-foreground" data-testid="party-unpaid-total">
                  {t("partyUnpaidTotal")}: <Amount value={unpaidAmount} />
                </span>
              </div>
            )}
            {customerScope && unpaid.length > 0 && !settleOpen && (
              <div className="mb-3 flex justify-end">
                <Button onClick={() => { setSettleOpen(true); setNotice(null); }} data-testid="party-settle">{t("partySettle")}</Button>
              </div>
            )}
            {customerScope && settleOpen && (
              <div className="mb-4">
                <CustomerSettlePanel
                  partyId={partyId}
                  invoices={detail.data.invoices}
                  unpaid={unpaidAmount}
                  onDone={() => { refreshTabQueries(); setSettleOpen(false); setNotice(t("partySettleRecorded")); }}
                  onCancel={() => setSettleOpen(false)}
                />
              </div>
            )}
            {invoiceList.isPending ? (
              <div className="grid gap-2" data-testid="party-invoices-loading">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
              </div>
            ) : (invoiceList.data?.total ?? 0) === 0 ? (
              <p className="rounded border bg-card p-4 text-sm text-muted-foreground" data-testid="party-invoices-empty">
                {showUnpaidOnly ? t("partyNoUnpaid") : t("partyInvoicesEmpty")}
              </p>
            ) : (
              <>
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
                    {(invoiceList.data?.items ?? []).map((invoice) => (
                      <PartyInvoiceRow key={invoice.id} invoice={invoice} />
                    ))}
                  </tbody>
                </table>
                <Pager
                  total={invoiceList.data?.total ?? 0}
                  pageSize={invoicePager.pageSize}
                  offset={invoicePager.offset}
                  onOffsetChange={invoicePager.setOffset}
                  onPageSizeChange={invoicePager.setPageSize}
                  testId="party-invoices-pager"
                />
              </>
            )}
          </div>

          <div role="tabpanel" id="party-panel-payments" aria-labelledby="party-tab-payments" hidden={tab !== "payments"} className="mt-4" data-testid="party-panel-payments">
            {role === "supplier" && account !== null ? (
              entryList.isPending ? (
                <div className="grid gap-2" data-testid="supplier-account-loading">
                  <Skeleton className="h-6 w-full" />
                  <Skeleton className="h-6 w-full" />
                </div>
              ) : (entryList.data?.total ?? 0) === 0 ? (
                <p className="rounded border bg-card p-4 text-sm text-muted-foreground" data-testid="supplier-account-empty">{t("supplierAccountEmpty")}</p>
              ) : (
                <>
                  <table className="w-full text-sm" data-testid="supplier-account-entries">
                    <thead>
                      <tr className="border-b text-right text-muted-foreground">
                        <th scope="col" className="p-2 font-medium">{t("supplierEntryDate")}</th>
                        <th scope="col" className="p-2 font-medium">{t("supplierEntryKind")}</th>
                        <th scope="col" className="p-2 font-medium">{t("supplierEntryInvoice")}</th>
                        <th scope="col" className="p-2 font-medium">{t("supplierEntryAmount")}</th>
                        <th scope="col" className="p-2 font-medium">{t("supplierEntryNote")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(entryList.data?.items ?? []).map((entry) => (
                        <SupplierAccountRow key={entry.id} entry={entry} />
                      ))}
                    </tbody>
                  </table>
                  <Pager
                    total={entryList.data?.total ?? 0}
                    pageSize={paymentPager.pageSize}
                    offset={paymentPager.offset}
                    onOffsetChange={paymentPager.setOffset}
                    onPageSizeChange={paymentPager.setPageSize}
                    testId="supplier-entries-pager"
                  />
                </>
              )
            ) : paymentList.isPending ? (
              <div className="grid gap-2" data-testid="party-payments-loading">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
              </div>
            ) : (paymentList.data?.total ?? 0) === 0 ? (
              <p className="rounded border bg-card p-4 text-sm text-muted-foreground" data-testid="party-payments-empty">{t("partyPaymentsEmpty")}</p>
            ) : (
              <>
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
                    {(paymentList.data?.items ?? []).map((payment) => (
                      <PartyPaymentRow key={payment.id} payment={payment} />
                    ))}
                  </tbody>
                </table>
                <Pager
                  total={paymentList.data?.total ?? 0}
                  pageSize={paymentPager.pageSize}
                  offset={paymentPager.offset}
                  onOffsetChange={paymentPager.setOffset}
                  onPageSizeChange={paymentPager.setPageSize}
                  testId="party-payments-pager"
                />
              </>
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
