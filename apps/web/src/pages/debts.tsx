import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronUp } from "lucide-react";

import type { DebtSummary } from "@dokan/contracts";

import { Skeleton } from "@/components/ui/skeleton";
import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

import { orpc } from "../lib/rpc";
import { tError } from "../lib/i18n";
import { formatDate } from "../lib/dates";

/** A party's debt identity: id for a known customer/supplier, typed name otherwise. */
type PartyIdentity = {
  kind: DebtSummary["kind"];
  counterpartyId: string | null;
  counterpartyName: string | null;
};

/** Stable per-party key used for React keys and the open-row state. */
function partySignature(party: Pick<PartyIdentity, "kind" | "counterpartyId" | "counterpartyName">): string {
  return `${party.kind}:${party.counterpartyId ?? party.counterpartyName}`;
}

/** HTML-id-safe form of the signature (typed names may contain spaces). */
function partyId(signature: string): string {
  return encodeURIComponent(signature);
}

function DebtPersonRow({ row, groupLabel, expanded, onToggle }: { row: DebtSummary; groupLabel: string; expanded: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const signature = partySignature(row);
  // #161 — a supplier row is the signed net balance (negative = we are ahead),
  // not the sum of its unpaid invoices. Customer rows keep the invoice total.
  const netBalance = row.kind === "PURCHASE" ? row.accountBalance : null;
  const displayAmount = netBalance ?? row.remainingTotal;

  // Per-row query gated on expansion: a freshly opened row shows its own
  // loading skeleton (never another party's cached invoices), while
  // re-opening the same row is served from the query cache instantly.
  const invoices = useQuery({
    ...orpc.debtsByParty.queryOptions({
      input: { kind: row.kind, counterpartyId: row.counterpartyId, counterpartyName: row.counterpartyName },
    }),
    enabled: expanded,
  });
  // supplier account movements behind the net balance (issue 161)
  const account = useQuery({
    ...orpc.suppliersGet.queryOptions({ input: { id: row.counterpartyId ?? "" } }),
    enabled: expanded && row.kind === "PURCHASE" && row.counterpartyId !== null,
  });

  return (
    <li className="px-1">
      <button
        type="button"
        data-testid="debts-person"
        aria-expanded={expanded}
        aria-controls={`${groupLabel}-${partyId(signature)}-invoices`}
        className="flex w-full items-center justify-between gap-3 px-3 py-3 text-right hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
        onClick={onToggle}
      >
        <span className="font-semibold" data-testid="debts-person-name">{row.counterpartyName ?? row.counterpartyId}</span>
        <span className="text-sm text-muted-foreground" data-testid="debts-person-count">{t("debtsInvoiceCount")}: {row.invoiceCount}</span>
        <span className={`font-semibold ${netBalance !== null && netBalance < 0 ? "text-success" : ""}`} data-testid="debts-person-total">{netBalance !== null && netBalance < 0 ? "− " : ""}<Amount value={Math.abs(displayAmount)} /></span>
        {expanded ? <ChevronUp size={14} className="text-muted-foreground" aria-hidden="true" /> : <ChevronDown size={14} className="text-muted-foreground" aria-hidden="true" />}
      </button>

      {expanded && (
        <div id={`${groupLabel}-${partyId(signature)}-invoices`} className="border-t bg-accent px-4 py-3">
          <h3 className="text-sm font-semibold text-muted-foreground">{t("debtsInvoicesTitle")}</h3>
          {invoices.isPending ? (
            <div className="mt-2 grid gap-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
            </div>
          ) : invoices.isError ? (
            <p className="mt-2 text-sm text-destructive" role="alert">{tError(invoices.error.message)}</p>
          ) : (invoices.data?.items ?? []).length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">{t("debtsEmpty")}</p>
          ) : (
            <table className="mt-2 w-full text-sm" data-testid="debts-invoices">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="p-2 text-right font-medium">{t("debtsInvNumber")}</th>
                  <th className="p-2 text-right font-medium">{t("debtsInvDate")}</th>
                  <th className="p-2 text-right font-medium">{t("debtsInvTotal")}</th>
                  <th className="p-2 text-right font-medium">{t("debtsInvRemaining")}</th>
                </tr>
              </thead>
              <tbody>
                {invoices.data?.items.map((invoice) => (
                  <tr key={invoice.id} data-testid="debts-invoice-row">
                    <td className="p-2">{invoice.invoiceNumber}</td>
                    <td className="p-2">{formatDate(invoice.invoiceDate)}</td>
                    <td className="p-2"><Amount value={invoice.totalAmount} /></td>
                    <td className="p-2 font-semibold"><Amount value={invoice.remainingAmount} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {row.kind === "PURCHASE" && row.counterpartyId !== null && account.isSuccess && (account.data.account?.entries.length ?? 0) > 0 && (
            <>
              <h3 className="mt-3 text-sm font-semibold text-muted-foreground">{t("debtsAccountMovements")}</h3>
              <table className="mt-2 w-full text-sm" data-testid="debts-account-entries">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="p-2 text-right font-medium">{t("supplierEntryDate")}</th>
                    <th className="p-2 text-right font-medium">{t("supplierEntryKind")}</th>
                    <th className="p-2 text-right font-medium">{t("supplierEntryAmount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {account.data.account?.entries.map((entry) => (
                    <tr key={entry.id} data-testid="debts-account-entry">
                      <td className="p-2">{formatDate(entry.occurredAt)}</td>
                      <td className="p-2">{t(`supplierEntry_${entry.kind}`)}</td>
                      <td className="p-2 font-semibold"><Amount value={entry.amount} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function DebtGroup({ title, rows, label, emptyLabel, emptyHint, emptyAction, openSignature, onToggle }: {
  title: string;
  rows: DebtSummary[];
  label: string;
  emptyLabel: string;
  emptyHint: string;
  emptyAction: ReactNode;
  openSignature: string | null;
  onToggle: (party: PartyIdentity) => void;
}) {
  const { t } = useTranslation();
  const groupTotal = rows.reduce((sum, row) => sum + (row.kind === "PURCHASE" ? (row.accountBalance ?? row.remainingTotal) : row.remainingTotal), 0);
  const groupCount = rows.reduce((sum, row) => sum + row.invoiceCount, 0);

  return (
    <section data-testid={label} aria-labelledby={`${label}-title`} className="rounded border bg-card">
      <header className="flex items-baseline justify-between border-b px-4 py-3">
        <h2 id={`${label}-title`} className="font-semibold">{title}</h2>
        {rows.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {t("debtsGroupTotal")}: <span data-testid={`${label}-total`} className="font-semibold text-foreground"><Amount value={groupTotal} /></span>
            {" · "}
            {t("debtsInvoiceCount")}: <span data-testid={`${label}-count`} className="font-semibold text-foreground">{groupCount}</span>
          </p>
        )}
      </header>

      {rows.length === 0 ? (
        <div data-testid={`${label}-empty`}>
          <EmptyState title={emptyLabel} hint={emptyHint} action={emptyAction} />
        </div>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => (
            <DebtPersonRow
              key={partySignature(row)}
              row={row}
              groupLabel={label}
              expanded={openSignature === partySignature(row)}
              onToggle={() => onToggle({ kind: row.kind, counterpartyId: row.counterpartyId, counterpartyName: row.counterpartyName })}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function DebtsPage() {
  const { t } = useTranslation();
  const debts = useQuery(orpc.reportsDebts.queryOptions());
  const [openParty, setOpenParty] = useState<PartyIdentity | null>(null);

  const toggleParty = (party: PartyIdentity) =>
    setOpenParty((current) => (current !== null && partySignature(current) === partySignature(party) ? null : party));

  const owedToUs = debts.data?.owedToUs ?? [];
  const weOwe = debts.data?.weOwe ?? [];

  return (
    <section data-testid="debts-page">
      <h1 className="text-xl font-bold">{t("debtsTitle")}</h1>

      {debts.isPending || !debts.data ? (
        <div className="mt-4 grid gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : debts.isError ? (
        <p className="mt-4 rounded border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          {tError(debts.error.message)}
        </p>
      ) : (
        <div className="mt-4 grid gap-6">
          <DebtGroup
            title={t("debtsOwedToUs")}
            label="debts-group-owed"
            rows={owedToUs}
            emptyLabel={t("debtsEmpty")}
            emptyHint={t("debtsEmptyOwedHint")}
            emptyAction={
              <Button asChild size="lg">
                <Link to="/sale" data-testid="debts-empty-sale">{t("saleNew")}</Link>
              </Button>
            }
            openSignature={openParty !== null ? partySignature(openParty) : null}
            onToggle={toggleParty}
          />
          <DebtGroup
            title={t("debtsWeOwe")}
            label="debts-group-weowe"
            rows={weOwe}
            emptyLabel={t("debtsEmpty")}
            emptyHint={t("debtsEmptyWeOweHint")}
            emptyAction={
              <Button asChild size="lg">
                <Link to="/purchase" data-testid="debts-empty-purchase">{t("purchasesTitle")}</Link>
              </Button>
            }
            openSignature={openParty !== null ? partySignature(openParty) : null}
            onToggle={toggleParty}
          />
        </div>
      )}
    </section>
  );
}