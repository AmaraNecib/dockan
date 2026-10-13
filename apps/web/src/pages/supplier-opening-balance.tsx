import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { normalizeTextKey, type SupplierAdjustmentDirection } from "@dokan/contracts";

import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

import { nowDateTimeText, parseDateTimeText } from "@/lib/dates";
import { parseGroupedAmount } from "@/lib/amount-parse";
import { tError } from "@/lib/i18n";
import { DEBTS_BY_PARTY_QUERY_KEY, INVOICES_LIST_QUERY_KEY, ACTIVITIES_LIST_QUERY_KEY } from "@/lib/query-keys";
import { orpc } from "@/lib/rpc";
import { MAX_OPENING_BALANCE_ROWS, isOpeningBatchOverLimit, newOpeningRowStatus, openingRowStatus } from "@/lib/supplier-opening-draft";

type RowDraft = { direction: SupplierAdjustmentDirection; amount: string };

/** The direction Selects render only these two values, so any string they hand
 * back is narrowed here instead of asserting it. */
const asDirection = (value: string | null): SupplierAdjustmentDirection => (value === "THEY_OWE" ? "THEY_OWE" : "WE_OWE");

/** The existing supplier a typed new name folds to (the same normalization the
 * server uses), or undefined when the name is genuinely new. */
function matchByNormalizedName<T extends { name: string }>(suppliers: readonly T[], newName: string): T | undefined {
  const trimmed = newName.trim();
  if (trimmed === "") return undefined;
  const key = normalizeTextKey(trimmed);
  return suppliers.find((supplier) => normalizeTextKey(supplier.name) === key);
}

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

  // A filled row keeps its parsed amount; an invalid or incomplete draft BLOCKS
  // the save instead of being silently dropped (Greptile round 1: "1,000" was
  // rejected by the old reader and its row vanished from the batch).
  const existingRows = useMemo(
    () => suppliers.map((supplier) => ({ supplier, direction: drafts[supplier.id]?.direction ?? "WE_OWE", state: openingRowStatus(drafts[supplier.id]) })),
    [suppliers, drafts],
  );
  const filledExisting = existingRows.filter(
    (row): row is { supplier: (typeof suppliers)[number]; direction: SupplierAdjustmentDirection; state: { status: "filled"; amount: number } } => row.state.status === "filled",
  );
  const invalidExisting = existingRows.filter((row) => row.state.status === "invalid");

  const newRow = newOpeningRowStatus({ name: newName, amount: newAmount, existingNames: suppliers.map((supplier) => supplier.name) });
  const newFilled = newRow.status === "filled";
  const newRowError =
    newRow.status === "incomplete"
      ? t("supplierOpeningNewIncomplete")
      : newRow.status === "invalid"
        ? t("supplierOpeningRowInvalid")
        : newRow.status === "duplicate"
          ? t("supplierOpeningNameExists")
          : null;

  const totalRows = filledExisting.length + (newFilled ? 1 : 0);
  const overLimit = isOpeningBatchOverLimit(totalRows);
  // the save is blocked, and the reason shown, BEFORE the owner fills more rows
  const blockedReason = overLimit
    ? t("supplierOpeningTooManyRows", { max: MAX_OPENING_BALANCE_ROWS })
    : invalidExisting.length > 0
      ? t("supplierOpeningFixRows")
      : newRowError;
  const needsConfirmation = filledExisting.some((row) => (row.supplier.accountEntryCount ?? 0) > 0);

  function setRow(supplierId: string, patch: Partial<RowDraft>) {
    setDrafts((current) => {
      const existing = current[supplierId] ?? { direction: "WE_OWE", amount: "" };
      return { ...current, [supplierId]: { ...existing, ...patch } };
    });
  }

  /** The typed new-name row resolved for saving: the existing supplier it now
   * folds to (with the amount and direction preserved), or undefined when the
   * name is genuinely new. */
  function resolveNewNameRow(): { supplierId: string; direction: SupplierAdjustmentDirection; amount: number } | undefined {
    const match = matchByNormalizedName(suppliers, newName);
    if (match === undefined) return undefined;
    const amount = parseGroupedAmount(newAmount);
    if (amount === null || amount <= 0) return undefined;
    return { supplierId: match.id, direction: newDirection, amount };
  }

  // Greptile round 2 — the confirmation is client-derived from a possibly stale
  // list. When the typed new name now matches an existing supplier (a concurrent
  // create landed after this page loaded), move the draft onto that supplier's
  // row so the confirmed save sends it under the existing id instead of dropping
  // the row once the refreshed list turns it into a duplicate.
  useEffect(() => {
    if (!confirming) return;
    const match = matchByNormalizedName(suppliers, newName);
    if (match === undefined || parseGroupedAmount(newAmount) === null) return;
    setRow(match.id, { direction: newDirection, amount: newAmount });
    setNewName("");
    setNewAmount("");
  }, [confirming, suppliers, newName, newAmount, newDirection]);

  async function save(confirmExisting: boolean) {
    if (occurredAt === null) return;
    // the duplicate-name block is resolved by adopting the matching existing
    // row; the row cap and invalid existing rows still stop the save
    const resolved = resolveNewNameRow();
    if (blockedReason !== null && !(resolved !== undefined && !overLimit && invalidExisting.length === 0)) return;
    setError(null);
    setSubmitting(true);
    try {
      if (resolved !== undefined) {
        // keep the UI in step: the draft moves onto the existing supplier's row
        setRow(resolved.supplierId, { direction: newDirection, amount: newAmount });
        setNewName("");
        setNewAmount("");
      }
      const result = await bulk.mutateAsync({
        occurredAt,
        reason: reasonDraft.trim() === "" ? undefined : reasonDraft.trim(),
        rows: [
          ...filledExisting.map((row) => ({
            supplierId: row.supplier.id,
            direction: row.direction,
            amount: row.state.amount,
            confirmExisting: confirmExisting || undefined,
          })),
          ...(resolved !== undefined
            ? [{ supplierId: resolved.supplierId, direction: resolved.direction, amount: resolved.amount, confirmExisting: confirmExisting || undefined }]
            : newRow.status === "filled"
              ? [{ newSupplierName: newRow.name, direction: newDirection, amount: newRow.amount }]
              : []),
        ],
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.suppliersList.queryKey() }),
        queryClient.invalidateQueries({ queryKey: orpc.reportsDebts.queryKey() }),
        queryClient.invalidateQueries({ queryKey: DEBTS_BY_PARTY_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: orpc.dashboardSummary.queryKey() }),
        queryClient.invalidateQueries({ queryKey: ACTIVITIES_LIST_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: INVOICES_LIST_QUERY_KEY }),
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
    if (blockedReason !== null) {
      setError(blockedReason);
      return;
    }
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
                {existingRows.map((row) => {
                  const supplier = row.supplier;
                  const draft = drafts[supplier.id] ?? { direction: "WE_OWE" as const, amount: "" };
                  const hasEntries = (supplier.accountEntryCount ?? 0) > 0;
                  const invalid = row.state.status === "invalid";
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
                          aria-invalid={invalid}
                          data-testid="opening-balance-amount"
                        />
                        {invalid && (
                          <p className="mt-1 text-xs text-destructive" role="alert" data-testid="opening-balance-amount-error">{t("supplierOpeningRowInvalid")}</p>
                        )}
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
                      aria-invalid={newRow.status === "duplicate"}
                      data-testid="opening-balance-new-name"
                    />
                    {newRowError !== null && (
                      <p
                        className="mt-1 text-xs text-destructive"
                        role="alert"
                        data-testid={newRow.status === "duplicate" ? "opening-balance-name-exists" : "opening-balance-new-error"}
                      >
                        {newRowError}
                      </p>
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

          {blockedReason !== null && (
            <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="opening-balance-blocked">
              {blockedReason}
            </p>
          )}

          {error !== null && (
            <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="opening-balance-form-error">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button type="submit" disabled={submitting || bulk.isPending || dateInvalid || blockedReason !== null} data-testid="opening-balance-save">
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
