import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { DebtSummary } from "@dokan/contracts";

import { Skeleton } from "@/components/ui/skeleton";

import { orpc } from "../lib/rpc";
import { tError } from "../lib/i18n";

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

  // Per-row query gated on expansion: a freshly opened row shows its own
  // loading skeleton (never another party's cached invoices), while
  // re-opening the same row is served from the query cache instantly.
  const invoices = useQuery({
    ...orpc.debtsByParty.queryOptions({
      input: { kind: row.kind, counterpartyId: row.counterpartyId, counterpartyName: row.counterpartyName },
    }),
    enabled: expanded,
  });

  return (
    <li key={signature} className="px-1">
      <button
        type="button"
        data-testid="debts-person"
        aria-expanded={expanded}
        aria-controls={`${groupLabel}-${partyId(signature)}-invoices`}
        className="flex w-full items-center justify-between gap-3 px-3 py-3 text-right hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-stone-400"
        onClick={onToggle}
      >
        <span className="font-semibold" data-testid="debts-person-name">{row.counterpartyName ?? row.counterpartyId}</span>
        <span className="text-sm text-stone-500" data-testid="debts-person-count">{t("debtsInvoiceCount")}: {row.invoiceCount}</span>
        <span className="font-semibold" data-testid="debts-person-total">{row.remainingTotal} دج</span>
        <span className="text-xs text-stone-400" aria-hidden="true">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div id={`${groupLabel}-${partyId(signature)}-invoices`} className="border-t bg-stone-50 px-4 py-3">
          <h3 className="text-sm font-semibold text-stone-600">{t("debtsInvoicesTitle")}</h3>
          {invoices.isPending ? (
            <div className="mt-2 grid gap-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
            </div>
          ) : invoices.isError ? (
            <p className="mt-2 text-sm text-red-600" role="alert">{tError(invoices.error.message)}</p>
          ) : (invoices.data?.items ?? []).length === 0 ? (
            <p className="mt-2 text-sm text-stone-500">{t("debtsEmpty")}</p>
          ) : (
            <table className="mt-2 w-full text-sm" data-testid="debts-invoices">
              <thead>
                <tr className="border-b text-stone-500">
                  <th className="p-2 text-right font-medium">{t("debtsInvNumber")}</th>
                  <th className="p-2 text-right font-medium">{t("debtsInvDate")}</th>
                  <th className="p-2 text-right font-medium">{t("debtsInvTotal")}</th>
                  <th className="p-2 text-right font-medium">{t("debtsInvRemaining")}</th>
                </tr>
              </thead>
              <tbody>
                {invoices.data?.items.map((invoice) => (
                  <tr key={invoice.id} data-testid="debts-invoice-row">
                    <td className="p-2" dir="ltr">{invoice.invoiceNumber}</td>
                    <td className="p-2">{invoice.invoiceDate}</td>
                    <td className="p-2">{invoice.totalAmount} دج</td>
                    <td className="p-2 font-semibold">{invoice.remainingAmount} دج</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </li>
  );
}

function DebtGroup({ title, rows, label, emptyLabel, openSignature, onToggle }: {
  title: string;
  rows: DebtSummary[];
  label: string;
  emptyLabel: string;
  openSignature: string | null;
  onToggle: (party: PartyIdentity) => void;
}) {
  const { t } = useTranslation();
  const groupTotal = rows.reduce((sum, row) => sum + row.remainingTotal, 0);
  const groupCount = rows.reduce((sum, row) => sum + row.invoiceCount, 0);

  return (
    <section data-testid={label} aria-labelledby={`${label}-title`} className="rounded border bg-white">
      <header className="flex items-baseline justify-between border-b px-4 py-3">
        <h2 id={`${label}-title`} className="font-semibold">{title}</h2>
        {rows.length > 0 && (
          <p className="text-sm text-stone-500">
            {t("debtsGroupTotal")}: <span data-testid={`${label}-total`} className="font-semibold text-stone-900">{groupTotal} دج</span>
            {" · "}
            {t("debtsInvoiceCount")}: <span data-testid={`${label}-count`} className="font-semibold text-stone-900">{groupCount}</span>
          </p>
        )}
      </header>

      {rows.length === 0 ? (
        <p className="px-4 py-4 text-sm text-stone-500" data-testid={`${label}-empty`}>{emptyLabel}</p>
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
        <p className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
          {tError(debts.error.message)}
        </p>
      ) : (
        <div className="mt-4 grid gap-6">
          <DebtGroup
            title={t("debtsOwedToUs")}
            label="debts-group-owed"
            rows={owedToUs}
            emptyLabel={t("debtsEmpty")}
            openSignature={openParty !== null ? partySignature(openParty) : null}
            onToggle={toggleParty}
          />
          <DebtGroup
            title={t("debtsWeOwe")}
            label="debts-group-weowe"
            rows={weOwe}
            emptyLabel={t("debtsEmpty")}
            openSignature={openParty !== null ? partySignature(openParty) : null}
            onToggle={toggleParty}
          />
        </div>
      )}
    </section>
  );
}