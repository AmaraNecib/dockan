import { useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { SupplierAdjustmentDirection } from "@dokan/contracts";
import { normalizeTextKey } from "@dokan/contracts";

import { Amount } from "@/components/ui/amount";
import { parseWholeAmount } from "@/components/ui/amount-percentage-input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

import { nowDateTimeText, parseDateTimeText } from "@/lib/dates";
import { tError } from "@/lib/i18n";
import { orpc } from "@/lib/rpc";

type RowDraft = { direction: SupplierAdjustmentDirection; amount: string };

/** The direction Selects render only these two values, so any string they hand
 * back is narrowed here instead of asserting it. */
const asDirection = (value: string | null): SupplierAdjustmentDirection => (value === "THEY_OWE" ? "THEY_OWE" : "WE_OWE");

/**
 * #176 — the bulk «رصيد افتتاحي» screen. One row per supplier (name + current
 * balance), an amount + direction per row, an inline new supplier, and one
 * shared date + reason. Saving writes one ACCOUNT-ONLY تسوية per filled row —
 * no invoice is ever touched. A row whose supplier already carries an account
 * entry asks for confirmation first.
 */
export function SupplierOpeningBalancePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const list = useQuery(orpc.suppliersList.queryOptions());

  const [dateDraft, setDateDraft] = useState(() => nowDateTimeText().slice(0, 10));
  const [reasonDraft, setReasonDraft] = useState(() => t("supplierAdjustPresetOpening"));
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [newName, setNewName] = useState("");
  const [newDirection, setNewDirection] = useState<SupplierAdjustmentDirection>("WE_OWE");
  const [newAmount, setNewAmount] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ created: number; accounts: Array<{ supplierId: string; name: string; balance: number }> } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const bulk = useMutation(orpc.suppliersOpeningBalances.mutationOptions());

  const suppliers = list.data?.items ?? [];
  const occurredAt = parseDateTimeText(dateDraft);
  const dateInvalid = dateDraft.trim() === "" || occurredAt === null;
  // typing the exact name of an existing supplier would create a SECOND account
  // for the same person (ADR-0007 allows duplicate names, so the server cannot
  // refuse), and that silently splits the opening balance; block it here and
  // point the owner at the existing row
  const newNameTrimmed = newName.trim();
  const newNameMatchesExisting =
    newNameTrimmed !== "" && suppliers.some((supplier) => normalizeTextKey(supplier.name) === normalizeTextKey(newNameTrimmed));

  const filledExisting = useMemo(
    () =>
      suppliers
        .map((supplier) => ({ supplier, draft: drafts[supplier.id] }))
        .filter((entry): entry is { supplier: (typeof suppliers)[number]; draft: RowDraft } => {
          if (entry.draft === undefined) return false;
          const amount = parseWholeAmount(entry.draft.amount);
          return amount !== null && amount > 0;
        }),
    [suppliers, drafts],
  );
  const newAmountValue = parseWholeAmount(newAmount);
  const newFilled = newNameTrimmed !== "" && !newNameMatchesExisting && newAmountValue !== null && newAmountValue > 0;
  const totalRows = filledExisting.length + (newFilled ? 1 : 0);
  // the confirmation only concerns rows whose supplier already has entries
  const needsConfirmation = filledExisting.some((entry) => (entry.supplier.accountEntryCount ?? 0) > 0);

  function setRow(supplierId: string, patch: Partial<RowDraft>) {
    setDrafts((current) => {
      const existing = current[supplierId] ?? { direction: "WE_OWE", amount: "" };
      return { ...current, [supplierId]: { ...existing, ...patch } };
    });
  }

  async function save(confirmExisting: boolean) {
    if (occurredAt === null) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await bulk.mutateAsync({
        occurredAt,
        reason: reasonDraft.trim() === "" ? undefined : reasonDraft.trim(),
        rows: [
          ...filledExisting.map((entry) => ({
            supplierId: entry.supplier.id,
            direction: entry.draft.direction,
            amount: parseWholeAmount(entry.draft.amount)!,
            confirmExisting: confirmExisting || undefined,
          })),
          ...(newFilled ? [{ newSupplierName: newName.trim(), direction: newDirection, amount: newAmountValue! }] : []),
        ],
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.suppliersList.queryKey() }),
        queryClient.invalidateQueries({ queryKey: ["debtsData"] }),
        queryClient.invalidateQueries({ queryKey: ["activitiesList"] }),
      ]);
      setSaved({ created: result.created, accounts: result.accounts });
      setConfirming(false);
    } catch (err) {
      // the confirmation is client-derived from a possibly stale list; when the
      // server refuses an unconfirmed existing account, surface the dialog so
      // the owner can still proceed instead of hitting a dead end
      if (!confirmExisting && err instanceof Error && err.message.includes("OPENING_BALANCE_EXISTS")) {
        setConfirming(true);
        await queryClient.invalidateQueries({ queryKey: orpc.suppliersList.queryKey() });
      }
      setError(tError(err instanceof Error ? err.message : undefined));
    } finally {
      // NOTE: do NOT reset `confirming` here — the catch may have just set it to
      // surface the dialog after a stale-expectation refusal. It is cleared on
      // success above and by the dialog's own cancel button.
      setSubmitting(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || bulk.isPending || dateInvalid) return;
    if (totalRows === 0) {
      setError(t("supplierOpeningNothing"));
      return;
    }
    if (needsConfirmation) {
      setConfirming(true);
      return;
    }
    await save(false);
  }

  return (
    <section data-testid="opening-balance-page">
      <Link to="/suppliers" className="text-sm text-muted-foreground underline-offset-4 hover:underline" data-testid="opening-balance-back">
        {t("supplierOpeningBack")}
      </Link>
      <h1 className="mt-3 text-xl font-bold">{t("supplierOpeningTitle")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t("supplierOpeningIntro")}</p>

      {saved !== null ? (
        <div className="mt-4 rounded border border-success/30 bg-success/10 p-4" data-testid="opening-balance-saved">
          <p className="font-semibold text-success" role="status">{t("supplierOpeningSaved")}</p>
          <ul className="mt-2 grid gap-1 text-sm">
            {saved.accounts.map((account) => (
              <li key={account.supplierId} className="flex items-center justify-between gap-3">
                <span>{account.name}</span>
                <span className="font-medium"><Amount value={Math.abs(account.balance)} /> {account.balance >= 0 ? t("supplierAdjustDirectionWeOwe") : t("supplierAdjustDirectionTheyOwe")}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => void navigate({ to: "/suppliers" })} data-testid="opening-balance-done">{t("supplierOpeningBack")}</Button>
          </div>
        </div>
      ) : (
        <form className="mt-4 grid gap-4" onSubmit={submit} data-testid="opening-balance-form">
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm">
              {t("supplierOpeningDate")}
              <input
                className="h-9 w-32 rounded-lg border border-input bg-background px-3 text-sm"
                inputMode="numeric"
                autoComplete="off"
                value={dateDraft}
                onChange={(event) => setDateDraft(event.target.value)}
                aria-invalid={dateInvalid}
                data-testid="opening-balance-date"
              />
            </label>
            <label className="grid flex-1 gap-1 text-sm">
              {t("supplierOpeningReason")}
              <input
                className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
                value={reasonDraft}
                onChange={(event) => setReasonDraft(event.target.value)}
                data-testid="opening-balance-reason"
              />
            </label>
          </div>

          {list.isPending ? (
            <div className="grid gap-2" data-testid="opening-balance-loading">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : list.isError ? (
            <p className="rounded border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive" role="alert" data-testid="opening-balance-error">
              {tError(list.error.message)}
            </p>
          ) : (
            <table className="w-full text-sm" data-testid="opening-balance-table">
              <thead>
                <tr className="border-b text-right text-muted-foreground">
                  <th scope="col" className="p-2 font-medium">{t("supplierOpeningColSupplier")}</th>
                  <th scope="col" className="p-2 font-medium">{t("supplierOpeningColBalance")}</th>
                  <th scope="col" className="p-2 font-medium">{t("supplierOpeningColDirection")}</th>
                  <th scope="col" className="p-2 font-medium">{t("supplierOpeningColAmount")}</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((supplier) => {
                  const draft = drafts[supplier.id] ?? { direction: "WE_OWE" as const, amount: "" };
                  const hasEntries = (supplier.accountEntryCount ?? 0) > 0;
                  return (
                    <tr key={supplier.id} className="border-b" data-testid="opening-balance-row">
                      <td className="p-2">
                        {supplier.name}
                        {hasEntries && <span className="ml-2 text-xs text-warning" data-testid="opening-balance-existing">{t("supplierOpeningExistingWarn")}</span>}
                      </td>
                      <td className="p-2" data-testid="opening-balance-current">
                        <Amount value={Math.abs(supplier.accountBalance ?? 0)} />{" "}
                        {supplier.accountBalance !== null && supplier.accountBalance !== undefined && supplier.accountBalance !== 0 && (
                          <span className="text-xs text-muted-foreground">
                            {supplier.accountBalance > 0 ? t("supplierAdjustDirectionWeOwe") : t("supplierAdjustDirectionTheyOwe")}
                          </span>
                        )}
                      </td>
                      <td className="p-2">
                        <Select value={draft.direction} onValueChange={(next) => setRow(supplier.id, { direction: asDirection(next) })}>
                          <SelectTrigger className="w-28" data-testid="opening-balance-direction">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="WE_OWE">{t("supplierAdjustDirectionWeOwe")}</SelectItem>
                            <SelectItem value="THEY_OWE">{t("supplierAdjustDirectionTheyOwe")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="p-2">
                        <input
                          className="h-9 w-32 rounded-lg border border-input bg-background px-3 text-sm"
                          inputMode="numeric"
                          autoComplete="off"
                          value={draft.amount}
                          onChange={(event) => setRow(supplier.id, { amount: event.target.value })}
                          aria-label={`${supplier.name}: ${t("supplierOpeningColAmount")}`}
                          data-testid="opening-balance-amount"
                        />
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-b bg-accent/40" data-testid="opening-balance-new">
                  <td className="p-2">
                    <input
                      className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
                      value={newName}
                      onChange={(event) => setNewName(event.target.value)}
                      placeholder={t("supplierOpeningNewRow")}
                      aria-label={t("supplierOpeningNewRow")}
                      aria-invalid={newNameMatchesExisting}
                      data-testid="opening-balance-new-name"
                    />
                    {newNameMatchesExisting && (
                      <p className="mt-1 text-xs text-destructive" role="alert" data-testid="opening-balance-name-exists">{t("supplierOpeningNameExists")}</p>
                    )}
                  </td>
                  <td className="p-2 text-muted-foreground">—</td>
                  <td className="p-2">
                    <Select value={newDirection} onValueChange={(next) => setNewDirection(asDirection(next))}>
                      <SelectTrigger className="w-28" data-testid="opening-balance-new-direction">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="WE_OWE">{t("supplierAdjustDirectionWeOwe")}</SelectItem>
                        <SelectItem value="THEY_OWE">{t("supplierAdjustDirectionTheyOwe")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="p-2">
                    <input
                      className="h-9 w-32 rounded-lg border border-input bg-background px-3 text-sm"
                      inputMode="numeric"
                      autoComplete="off"
                      value={newAmount}
                      onChange={(event) => setNewAmount(event.target.value)}
                      aria-label={t("supplierOpeningNewRow")}
                      data-testid="opening-balance-new-amount"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          )}

          {error !== null && (
            <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="opening-balance-form-error">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button type="submit" disabled={submitting || bulk.isPending || dateInvalid} data-testid="opening-balance-save">
              {t("supplierOpeningSave", { count: totalRows })}
            </Button>
            <Button type="button" variant="outline" onClick={() => void navigate({ to: "/suppliers" })} disabled={submitting || bulk.isPending} data-testid="opening-balance-cancel">
              {t("partyCancel")}
            </Button>
          </div>

          {confirming && (
            <div className="rounded border border-warning/40 bg-warning/10 p-4" role="alertdialog" aria-label={t("supplierOpeningConfirmTitle")} data-testid="opening-balance-confirm">
              <p className="font-semibold">{t("supplierOpeningConfirmTitle")}</p>
              <p className="mt-1 text-sm">{t("supplierOpeningConfirmBody")}</p>
              <ul className="mt-2 grid gap-1 text-sm">
                {filledExisting.filter((entry) => (entry.supplier.accountEntryCount ?? 0) > 0).map((entry) => (
                  <li key={entry.supplier.id}>{entry.supplier.name}</li>
                ))}
              </ul>
              <div className="mt-3 flex gap-2">
                <Button type="button" onClick={() => void save(true)} disabled={submitting || bulk.isPending} data-testid="opening-balance-confirm-save">
                  {t("supplierOpeningConfirmSave")}
                </Button>
                <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={submitting || bulk.isPending} data-testid="opening-balance-confirm-cancel">
                  {t("partyCancel")}
                </Button>
              </div>
            </div>
          )}
        </form>
      )}
    </section>
  );
}
