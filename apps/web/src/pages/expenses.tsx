import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { ReportRangePreset } from "@dokan/contracts";

import { tError } from "../lib/i18n";
import { orpc } from "../lib/rpc";
import { Amount } from "@/components/ui/amount";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * Ticket 31 — expenses (/expenses). Record a raw expense against one of the
 * seeded (or owner-created) expense categories with an Algeria-local moment;
 * the history table filters by category, window (default: current month) and
 * sort order. Owner-withdrawal rows are visually distinct because the profit
 * report keeps them out of operating expenses. Window boundaries are resolved
 * on the api (report-ranges.ts), never re-derived in the browser.
 */

const PRESET_KEYS: ReportRangePreset[] = ["24H", "7D", "28D", "30D", "CURRENT_MONTH", "3M", "6M", "CURRENT_YEAR", "LAST_YEAR", "CUSTOM"];

function toPreset(value: string): ReportRangePreset {
  for (const preset of PRESET_KEYS) {
    if (value === preset) return preset;
  }
  return "CURRENT_MONTH";
}

/** datetime-local gives "YYYY-MM-DDTHH:mm"; the api wants seconds. */
function withSeconds(value: string): string | undefined {
  if (value === "") return undefined;
  return value.length === 16 ? `${value}:00` : value;
}

/** The shop PC is in Algeria, so device-local now is Algeria-local now. */
function nowLocalInput(): string {
  const d = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ExpensesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const categories = useQuery(orpc.expenseCategoriesList.queryOptions());

  // record form
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [occurredAt, setOccurredAt] = useState(nowLocalInput());
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // history filters — default: current month, newest first, all categories
  const [preset, setPreset] = useState<ReportRangePreset>("CURRENT_MONTH");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<"occurredAt" | "amount">("occurredAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const createExpense = useMutation(
    orpc.expensesCreate.mutationOptions({
      onSuccess: () => {
        setSaved(true);
        setAmount("");
        setNote("");
        setError(null);
        setOccurredAt(nowLocalInput());
        // the expense list, profit report and activity log all derive from the
        // new raw row; refetching the app's few active queries keeps them honest
        void queryClient.invalidateQueries();
      },
      onError: (err) => setError(tError(err.message)),
    }),
  );

  const history = useQuery(
    orpc.expensesList.queryOptions({
      input: {
        preset,
        customFrom: withSeconds(customFrom),
        customTo: withSeconds(customTo),
        categoryIds: selectedCategoryIds.size > 0 ? [...selectedCategoryIds] : undefined,
        sortBy,
        sortDir,
      },
    }),
  );

  const toggleCategory = (id: string) => {
    setSelectedCategoryIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const parsed = Number(amount);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      setError(t("expenseInvalidAmount"));
      return;
    }
    if (categoryId === "") {
      setError(t("CATEGORY_NOT_FOUND"));
      return;
    }
    void createExpense.mutate({
      categoryId,
      amount: parsed,
      note: note.trim() === "" ? undefined : note.trim(),
      occurredAt: withSeconds(occurredAt) ?? undefined,
    });
  }

  return (
    <section data-testid="expenses-page">
      <h1 className="text-xl font-bold">{t("expensesTitle")}</h1>

      <form className="mt-4 grid gap-4 rounded border bg-card p-4" onSubmit={submit} data-testid="expense-form">
        <h2 className="font-semibold">{t("expensesRecordTitle")}</h2>
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1">
            {t("expenseCategory")}
            <Select
              value={categoryId}
              onValueChange={(value) => setCategoryId(value ?? "")}
              items={[
                { value: "", label: "—" },
                ...(categories.data?.items.map((category) => ({
                  value: category.id,
                  label: `${category.name}${category.isOwnerWithdrawal ? ` (${t("expensesWithdrawalBadge")})` : ""}`,
                })) ?? []),
              ]}
            >
              <SelectTrigger className="w-full" data-testid="expense-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">—</SelectItem>
                {categories.data?.items.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                    {category.isOwnerWithdrawal ? ` (${t("expensesWithdrawalBadge")})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1">
            {t("expenseAmount")}
            <input className="rounded border px-3 py-2" inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} data-testid="expense-amount" />
          </label>
          <label className="grid gap-1">
            {t("expenseNote")}
            <input className="rounded border px-3 py-2" value={note} onChange={(event) => setNote(event.target.value)} data-testid="expense-note" />
          </label>
          <label className="grid gap-1">
            {t("expenseOccurredAt")}
            <input type="datetime-local" className="rounded border px-3 py-2" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} data-testid="expense-date" />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" disabled={createExpense.isPending} data-testid="expense-save">
            {t("expenseSave")}
          </button>
          {saved && <span className="text-sm text-success" data-testid="expense-saved">{t("expenseSaved")}</span>}
        </div>
        {error && <p className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" role="alert" data-testid="expense-error">{error}</p>}
      </form>

      <div className="mt-6 grid gap-4">
        <h2 className="font-semibold">{t("expensesHistoryTitle")}</h2>
        <div className="grid gap-3 rounded border bg-card p-4" data-testid="expense-filters">
          <div className="grid grid-cols-3 gap-3">
            <label className="grid gap-1">
              {t("expensesRange")}
              <Select
                value={preset}
                onValueChange={(value) => setPreset(toPreset(value ?? ""))}
                items={PRESET_KEYS.map((key) => ({ value: key, label: t(`rangePreset_${key}`) }))}
              >
                <SelectTrigger className="w-full" data-testid="expense-range-preset">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRESET_KEYS.map((key) => <SelectItem key={key} value={key}>{t(`rangePreset_${key}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1">
              {t("expensesSortBy")}
              <Select
                value={sortBy}
                onValueChange={(value) => setSortBy(value === "amount" ? "amount" : "occurredAt")}
                items={[
                  { value: "occurredAt", label: t("expensesSortByDate") },
                  { value: "amount", label: t("expensesSortByAmount") },
                ]}
              >
                <SelectTrigger className="w-full" data-testid="expense-sort-by">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="occurredAt">{t("expensesSortByDate")}</SelectItem>
                  <SelectItem value="amount">{t("expensesSortByAmount")}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1">
              {t("expensesRange")}
              <Select
                value={sortDir}
                onValueChange={(value) => setSortDir(value === "asc" ? "asc" : "desc")}
                items={[
                  { value: "desc", label: t("expensesSortDesc") },
                  { value: "asc", label: t("expensesSortAsc") },
                ]}
              >
                <SelectTrigger className="w-full" data-testid="expense-sort-dir">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="desc">{t("expensesSortDesc")}</SelectItem>
                  <SelectItem value="asc">{t("expensesSortAsc")}</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>
          {preset === "CUSTOM" && (
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1">
                {t("expensesCustomFrom")}
                <input type="datetime-local" className="rounded border px-3 py-2" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} data-testid="expense-custom-from" />
              </label>
              <label className="grid gap-1">
                {t("expensesCustomTo")}
                <input type="datetime-local" className="rounded border px-3 py-2" value={customTo} onChange={(event) => setCustomTo(event.target.value)} data-testid="expense-custom-to" />
              </label>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`rounded-full border px-3 py-1 text-sm ${selectedCategoryIds.size === 0 ? "bg-primary text-primary-foreground" : "bg-card text-foreground"}`}
              onClick={() => setSelectedCategoryIds(new Set())}
              data-testid="expense-filter-all"
            >
              {t("expensesAllCategories")}
            </button>
            {categories.data?.items.map((category) => {
              const active = selectedCategoryIds.has(category.id);
              return (
                <button
                  key={category.id}
                  type="button"
                  className={`rounded-full border px-3 py-1 text-sm ${active ? "bg-primary text-primary-foreground" : "bg-card text-foreground"}`}
                  onClick={() => toggleCategory(category.id)}
                  data-testid={`expense-filter-${category.id}`}
                >
                  {category.name}
                </button>
              );
            })}
          </div>
        </div>

        {history.isPending ? (
          <p className="rounded border bg-card p-4 text-muted-foreground" data-testid="expenses-loading">{t("expensesLoading")}</p>
        ) : history.data === undefined || history.data.items.length === 0 ? (
          <p className="rounded border bg-card p-4 text-muted-foreground" data-testid="expenses-empty">{t("expensesEmpty")}</p>
        ) : (
          <table className="w-full rounded border bg-card" data-testid="expense-history">
            <thead>
              <tr className="border-b text-right text-sm text-muted-foreground">
                <th className="p-3">{t("expenseColDate")}</th>
                <th className="p-3">{t("expenseColCategory")}</th>
                <th className="p-3">{t("expenseColNote")}</th>
                <th className="p-3">{t("expenseColAmount")}</th>
              </tr>
            </thead>
            <tbody>
              {history.data.items.map((entry) => {
                const category = categories.data?.items.find((row) => row.id === entry.categoryId);
                const withdrawal = category?.isOwnerWithdrawal === true;
                return (
                  <tr key={entry.id} className={`border-b last:border-0 ${withdrawal ? "bg-warning/10" : ""}`} data-testid="expense-row">
                    <td className="p-3 text-sm whitespace-nowrap text-muted-foreground" dir="ltr">{entry.occurredAt}</td>
                    <td className="p-3">
                      {category?.name ?? entry.categoryId.slice(0, 8)}
                      {withdrawal && <span className="mr-2 rounded bg-warning/20 px-2 py-0.5 text-xs text-warning">{t("expensesWithdrawalBadge")}</span>}
                    </td>
                    <td className="p-3 text-sm text-muted-foreground" data-testid="expense-row-note">{entry.note ?? "—"}</td>
                    <td className="p-3 font-semibold"><Amount value={entry.amount} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}