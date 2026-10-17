import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { Pager } from "@/components/ui/pager";
import { EmptyState } from "@/components/ui/empty-state";

import { orpc } from "../lib/rpc";
import { usePagination } from "../hooks/use-pagination";
import { formatDateTime } from "../lib/dates";
import { adjustmentDirectionKey } from "../lib/supplier-entry-display";

/** Keep entity references compact, but retain a useful backup filename.
 * Backup refs are local filesystem paths; showing only the basename avoids
 * leaking the data directory while still identifying the exported file.
 */
function formatActivityReference(type: string, ref: string): string {
  if (type === "BACKUP_CREATED") {
    return ref.split(/[\\/]/).filter(Boolean).at(-1) ?? ref;
  }
  return ref.slice(0, 8);
}

/** The detail route one activity row's `ref` points at, or null when the row
 * has no detail screen (a return voucher, an expense, a backup file).
 *
 * The summary TAG decides, never the activity type: several types carry more
 * than one tag with DIFFERENT refs — `STOCK_ADJUSTED` is a stock tweak on an
 * item but also `STOCK_LINKED` on an invoice, and `PAYMENT_RECORDED` is both an
 * invoice payment and the `SUPPLIER_*` moves whose ref is a supplier. Keying on
 * the type would link the wrong record. (#253)
 */
export type ActivityRefTarget =
  | { to: "/invoices/$invoiceId"; params: { invoiceId: string } }
  | { to: "/items/$itemId/history"; params: { itemId: string } }
  | { to: "/customers/$partyId"; params: { partyId: string } }
  | { to: "/suppliers/$partyId"; params: { partyId: string } };

export function activityRefLink(entry: { summary: string; ref: string | null }): ActivityRefTarget | null {
  const ref = entry.ref;
  if (ref === null || ref === "") return null;
  const [tag, role] = entry.summary.split(" ");
  if (tag === "ITEM_CREATED" || tag === "ITEM_UPDATED" || tag === "ITEM_COST_CORRECTED" || tag === "STOCK_ADJUSTED" || tag === "PURCHASE_CORRECTED") {
    return { to: "/items/$itemId/history", params: { itemId: ref } };
  }
  if (tag === "STOCK_LINKED" || tag === "SALE_CREATED" || tag === "PURCHASE_CREATED" || tag === "PAYMENT_RECORDED") {
    return { to: "/invoices/$invoiceId", params: { invoiceId: ref } };
  }
  if (tag === "SUPPLIER_PAYMENT" || tag === "SUPPLIER_REFUND" || tag === "SUPPLIER_ADJUSTMENT" || tag === "SUPPLIER_OPENING_BALANCE") {
    return { to: "/suppliers/$partyId", params: { partyId: ref } };
  }
  if (tag === "PARTY_CREATED" || tag === "PARTY_UPDATED" || tag === "PARTY_DELETED") {
    return role === "SUPPLIER"
      ? { to: "/suppliers/$partyId", params: { partyId: ref } }
      : { to: "/customers/$partyId", params: { partyId: ref } };
  }
  return null;
}

/** A linked ref. The union is switched on `to` so TypeScript correlates the
 * params with the route instead of widening them. */
function ActivityRef({ target, children }: { target: ActivityRefTarget; children: ReactNode }) {
  switch (target.to) {
    case "/invoices/$invoiceId":
      return <Link to={target.to} params={target.params} className="underline hover:text-foreground" data-testid="activity-ref-link">{children}</Link>;
    case "/items/$itemId/history":
      return <Link to={target.to} params={target.params} className="underline hover:text-foreground" data-testid="activity-ref-link">{children}</Link>;
    case "/customers/$partyId":
      return <Link to={target.to} params={target.params} className="underline hover:text-foreground" data-testid="activity-ref-link">{children}</Link>;
    case "/suppliers/$partyId":
      return <Link to={target.to} params={target.params} className="underline hover:text-foreground" data-testid="activity-ref-link">{children}</Link>;
  }
}

/** The reference cell: a link to the record when one exists, the compact id or
 * safe backup filename otherwise, and an em dash when the row has no ref. */
function ActivityRefCell({ entry }: { entry: { type: string; summary: string; ref: string | null } }) {
  if (entry.ref === null || entry.ref === "") return <>—</>;
  const label = formatActivityReference(entry.type, entry.ref);
  const target = activityRefLink(entry);
  if (target === null) return <>{label}</>;
  return <ActivityRef target={target}>{label}</ActivityRef>;
}

/** Translate the locale-neutral activity summaries the api stores: a stable
 * ASCII tag followed by positional data fields (`CATEGORY_CREATED <name>`,
 * `RETURN_RECORDED <rtn> <amount> <invoice> <debt>`, ...). Unknown/legacy
 * summaries (pre-token Arabic rows) render raw exactly as before. The api
 * stays locale-neutral; this page owns the copy.
 */
export function activitySummaryText(t: TFunction, summary: string): string {
  const tokens = summary.split(" ");
  const tag = tokens[0];
  // locale-neutral tokens emitted by the api: the tag is the action and the
  // remaining fields are data, with the single free-text field (a name or
  // filename) always last so embedded spaces survive the split.
  if (tag === "STORE_SETUP" && tokens.length >= 2) {
    // the store name is free text, so everything after the token is the name
    return t("activityStoreSetup", { name: tokens.slice(1).join(" ") });
  }
  if (tag === "CATEGORY_CREATED" && tokens.length >= 2) return t("activityCategoryCreated", { name: tokens.slice(1).join(" ") });
  if (tag === "ITEM_CREATED_WITH_STOCK" && tokens.length >= 3) return t("activityItemCreatedWithStock", { name: tokens.slice(2).join(" "), stock: tokens[1] });
  if (tag === "ITEM_CREATED" && tokens.length >= 2) return t("activityItemCreated", { name: tokens.slice(1).join(" ") });
  if (tag === "ITEM_UPDATED" && tokens.length >= 2) return t("activityItemUpdated", { name: tokens.slice(1).join(" ") });
  // locale-neutral cost correction: cost then the free-text name last
  if (tag === "ITEM_COST_CORRECTED" && tokens.length >= 3) return t("activityItemCostCorrected", { cost: tokens[1], name: tokens.slice(2).join(" ") });
  // issue 120: party rows carry a role token, then the free-text name
  if ((tag === "PARTY_CREATED" || tag === "PARTY_UPDATED" || tag === "PARTY_DELETED") && tokens.length >= 3) {
    const role = tokens[1] === "SUPPLIER" ? t("partySupplier") : t("partyCustomer");
    const name = tokens.slice(2).join(" ");
    if (tag === "PARTY_CREATED") return t("activityPartyCreated", { role, name });
    if (tag === "PARTY_UPDATED") return t("activityPartyUpdated", { role, name });
    return t("activityPartyDeleted", { role, name });
  }
  if (tag === "STOCK_ADJUSTED" && tokens.length >= 2) return t("activityStockAdjusted", { name: tokens.slice(1).join(" ") });
  if (tag === "STOCK_LINKED" && tokens.length >= 2) return t("activityStockLinked", { number: tokens[1] });
  if (tag === "PURCHASE_CORRECTED" && tokens.length >= 2) return t("activityPurchaseCorrected", { name: tokens.slice(1).join(" ") });
  if (tag === "SALE_CREATED" && tokens.length >= 2) return t("activitySaleCreated", { number: tokens[1] });
  if (tag === "PURCHASE_CREATED" && tokens.length >= 2) {
    const party = tokens.length >= 3 ? tokens.slice(2).join(" ") : t("activitySupplierDefault");
    return t("activityPurchaseCreated", { number: tokens[1], party });
  }
  if (tag === "PAYMENT_RECORDED" && tokens.length >= 3) return t("activityPaymentRecorded", { number: tokens[2], amount: tokens[1] });
  // issue 161: supplier-account actions (amount then the free-text name last)
  if (tag === "SUPPLIER_PAYMENT" && tokens.length >= 3) return t("activitySupplierPayment", { amount: tokens[1], name: tokens.slice(2).join(" ") });
  if (tag === "SUPPLIER_RETURN" && tokens.length >= 4) return t("activitySupplierReturn", { number: tokens[1], amount: tokens[2], name: tokens.slice(3).join(" ") });
  if (tag === "SUPPLIER_REFUND" && tokens.length >= 3) return t("activitySupplierRefund", { amount: tokens[1], name: tokens.slice(2).join(" ") });
  // #253 — the two supplier-account tags that shipped without a branch, so the
  // audit log showed `SUPPLIER_OPENING_BALANCE THEY_OWE 100000 …` verbatim.
  // The direction word comes from the supplier-account labels (one mapping).
  if (tag === "SUPPLIER_ADJUSTMENT" && tokens.length >= 4) {
    return t("activitySupplierAdjustment", { direction: t(adjustmentDirectionKey(tokens[1] ?? null)), amount: tokens[2], name: tokens.slice(3).join(" ") });
  }
  if (tag === "SUPPLIER_OPENING_BALANCE" && tokens.length >= 4) {
    return t("activitySupplierOpeningBalance", { direction: t(adjustmentDirectionKey(tokens[1] ?? null)), amount: tokens[2], name: tokens.slice(3).join(" ") });
  }
  // the pre-unlock vault failures are stored as `<event> <timestamp>`
  if (tag === "VAULT_UNLOCK_FAILED" && tokens.length >= 2) return t("activityVaultUnlockFailed", { at: tokens.slice(1).join(" ") });
  if (tag === "VAULT_RECOVERY_FAILED" && tokens.length >= 2) return t("activityVaultRecoveryFailed", { at: tokens.slice(1).join(" ") });
  if (tag === "VAULT_CHANGE_PASSPHRASE_FAILED" && tokens.length >= 2) return t("activityVaultChangePassphraseFailed", { at: tokens.slice(1).join(" ") });
  if (tag === "VAULT_RECOVERY_RESET_FAILED" && tokens.length >= 2) return t("activityVaultRecoveryResetFailed", { at: tokens.slice(1).join(" ") });
  if (tag === "EXPENSE_CATEGORY_CREATED" && tokens.length >= 3) {
    const name = tokens.slice(2).join(" ");
    return tokens[1] === "WITHDRAWAL"
      ? t("activityExpenseCategoryCreatedWithdrawal", { name })
      : t("activityExpenseCategoryCreated", { name });
  }
  if (tag === "EXPENSE_RECORDED" && tokens.length >= 2) return t("activityExpenseRecorded", { amount: tokens[1] });
  if (tag === "SETTINGS_UPDATED") return t("activitySettingsUpdated");
  if (tag === "BACKUP_CREATED" && tokens.length >= 2) return t("activityBackupCreated", { file: tokens.slice(1).join(" ") });
  if (tag === "DAILY_BACKUP" && tokens.length >= 2) return t("activityDailyBackup", { file: tokens.slice(1).join(" ") });
  if (tag === "PASSWORD_RESET" && tokens.length >= 2) return t("activityPasswordReset", { phone: tokens.slice(1).join(" ") });
  if (tag === "RETURN_RECORDED" && tokens.length >= 5) {
    const [, number, amount, invoice, debt] = tokens;
    return Number(debt) > 0
      ? t("activityReturnRecordedDebt", { number, amount, invoice, debt })
      : t("activityReturnRecorded", { number, amount, invoice });
  }
  if (tag === "RETURN_REVIEWED" && tokens.length >= 4) {
    const [, number, action, amount] = tokens;
    return t("activityReturnReviewed", { number, action: t(action === "ACCEPTED" ? "returnsAcceptBtn" : "returnsRejectBtn"), amount });
  }
  return summary;
}

/**
 * Ticket 12 — activity log (shop trace). Read-only view over the append-only
 * activities table; newest first, Algeria-local timestamps, Arabic labels.
 * The api owns ordering and the limit clamp; the page stays a pure projection.
 */

export function ActivityLogPage() {
  const { t } = useTranslation();
  const pager = usePagination();
  const activities = useQuery(orpc.activitiesList.queryOptions({ input: { ...pager.pagination } }));

  return (
    <section>
      <h1 className="text-xl font-bold">{t("activityTitle")}</h1>

      {activities.isError ? (
        <div className="mt-4 flex items-center justify-between rounded border bg-destructive/10 p-3 text-sm text-destructive">
          <span>{t("activityError")}</span>
          <button type="button" className="underline" onClick={() => void activities.refetch()}>
            {t("itemsSearchRetry")}
          </button>
        </div>
      ) : activities.isPending || !activities.data ? (
        <div className="mt-4 grid gap-3 rounded border bg-card p-3">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-6 w-full" />
          ))}
        </div>
      ) : activities.data.total === 0 ? (
        <EmptyState
          testId="activity-empty"
          card
          className="mt-4"
          title={t("activityEmpty")}
          hint={t("activityEmptyHint")}
        />
      ) : (
        <>
        <table className="mt-4 w-full rounded border bg-card" data-testid="activity-table">
          <thead>
            <tr className="border-b text-right text-sm text-muted-foreground">
              <th className="p-3">{t("historyDate")}</th>
              <th className="p-3">{t("activityType")}</th>
              <th className="p-3">{t("activitySummary")}</th>
              <th className="p-3">{t("activityRef")}</th>
            </tr>
          </thead>
          <tbody>
            {activities.data.items.map((entry) => (
              <tr key={entry.id} className="border-b last:border-0">
                <td className="p-3 whitespace-nowrap text-sm text-muted-foreground">
                  {formatDateTime(entry.at)}
                </td>
                <td className="p-3">
                  <span className="rounded bg-muted px-2 py-0.5 text-xs text-foreground">{t(`activityType_${entry.type}`)}</span>
                </td>
                <td className="p-3">{activitySummaryText(t, entry.summary)}</td>
                {/* Entity refs are compact; backup refs display their safe local filename.
                    #253 — a ref with a detail screen is a link, so the column answers
                    "what is this?" instead of printing an opaque id. */}
                <td className="p-3 cell-ltr font-mono text-xs text-muted-foreground" data-testid="activity-ref">
                  <ActivityRefCell entry={entry} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager
          total={activities.data.total}
          pageSize={pager.pageSize}
          offset={pager.offset}
          onOffsetChange={pager.setOffset}
          onPageSizeChange={pager.setPageSize}
          testId="activity-pager"
        />
        </>
      )}
    </section>
  );
}
