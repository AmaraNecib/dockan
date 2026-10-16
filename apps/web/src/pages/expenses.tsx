import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ExpenseCategory, ReportRangePreset } from "@dokan/contracts";
import { Tags } from "lucide-react";

import { tError } from "../lib/i18n";
import { parseGroupedAmount } from "@/lib/amount-parse";
import { Pager } from "@/components/ui/pager";
import { DateField } from "@/components/ui/date-field";
import { inputClass } from "@/components/ui/input";
import { orpc } from "../lib/rpc";
import { usePagination } from "../hooks/use-pagination";
import { editDateBound, formatDateTime, nowDateTimeText, OPEN_BOUND, parseDateTimeText, type DateBound } from "../lib/dates";
import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * Ticket 31 — expenses (/expenses). Record a raw expense against one of the
 * seeded (or owner-created) expense categories with an Algeria-local moment;
 * the history table filters by category, window (default: current month) and
 * sort order. Owner-withdrawal rows are visually distinct because the profit
 * report keeps them out of operating expenses. Window boundaries are resolved
 * on the api (report-ranges.ts), never re-derived in the browser.
 *
 * Issue #99 — a category is required, so the owner can create one from here
 * (the same inline quick-add the purchase screen uses) and an empty category
 * list is a teaching state instead of a save-time CATEGORY_NOT_FOUND.
 */

const PRESET_KEYS: ReportRangePreset[] = ["24H", "7D", "28D", "30D", "CURRENT_MONTH", "3M", "6M", "CURRENT_YEAR", "LAST_YEAR", "CUSTOM"];

function toPreset(value: string): ReportRangePreset {
  for (const preset of PRESET_KEYS) {
    if (value === preset) return preset;
  }
  return "CURRENT_MONTH";
}

/** The record form's error, tagged with the control it belongs to so a field
 * action (the Now button) clears only its own field refusal. */
type RecordError = { message: string; field: "amount" | "category" | "date" | "save" };

export function ExpensesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const categories = useQuery(orpc.expenseCategoriesList.queryOptions());

  // record form
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [occurredAt, setOccurredAt] = useState(nowDateTimeText());
  const [error, setError] = useState<RecordError | null>(null);
  /** the date field's own invalid marker, so the form-level alert is wired to it */
  const [dateInvalid, setDateInvalid] = useState(false);
  const [saved, setSaved] = useState(false);

  // issue #99 — inline expense-category create, mirroring the purchase quick-add
  const [categoryFormOpen, setCategoryFormOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);
  /** the category created here: kept until the list confirms it, so the owner
   * can still record against it when the refetch that follows it fails */
  const [createdCategory, setCreatedCategory] = useState<ExpenseCategory | null>(null);
  /** the confirmation line for that create; cleared when the form reopens */
  const [categoryNotice, setCategoryNotice] = useState<string | null>(null);
  /** which quick-add attempt a pending create belongs to. A response that lands
   * after the form was cancelled and reopened must not take the screen over. */
  const categoryAttemptRef = useRef(0);

  // history filters — default: current month, newest first, all categories
  const [preset, setPreset] = useState<ReportRangePreset>("CURRENT_MONTH");
  const [customFrom, setCustomFrom] = useState<DateBound>(OPEN_BOUND);
  const [customTo, setCustomTo] = useState<DateBound>(OPEN_BOUND);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<"occurredAt" | "amount">("occurredAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const pager = usePagination();

  const createExpense = useMutation(
    orpc.expensesCreate.mutationOptions({
      onSuccess: () => {
        setSaved(true);
        setAmount("");
        setNote("");
        setError(null);
        setDateInvalid(false);
        setOccurredAt(nowDateTimeText());
        // the expense list, profit report and activity log all derive from the
        // new raw row; refetching the app's few active queries keeps them honest
        void queryClient.invalidateQueries();
      },
      onError: (err) => setError({ message: tError(err.message), field: "save" }),
    }),
  );

  const createCategory = useMutation(orpc.expenseCategoriesCreate.mutationOptions());

  const history = useQuery(
    orpc.expensesList.queryOptions({
      input: {
        preset,
        customFrom: customFrom.bound,
        customTo: customTo.bound,
        categoryIds: selectedCategoryIds.size > 0 ? [...selectedCategoryIds] : undefined,
        sortBy,
        sortDir,
        ...pager.pagination,
      },
    }),
  );

  const toggleCategory = (id: string) => {
    pager.reset();
    setSelectedCategoryIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** a non-default window or any category filter means a new expense recorded
   * now may not land in the view; the empty state must say so (issue #96) */
  const historyFiltersActive = preset !== "CURRENT_MONTH" || selectedCategoryIds.size > 0;

  function clearHistoryFilters(): void {
    pager.reset();
    setPreset("CURRENT_MONTH");
    setCustomFrom(OPEN_BOUND);
    setCustomTo(OPEN_BOUND);
    setSelectedCategoryIds(new Set());
  }

  /**
   * Fold a typed range-bound edit into its state and reset the list only when
   * the *applied* moment actually moved. A half-typed or impossible value keeps
   * the previous bound (editDateBound), so an unconditional reset would jump a
   * later history page back to page one for a filter that never changed
   * (Greptile round 1, finding 2). `previous` is read from the render the
   * handler was created in, which is current because each edit is one discrete,
   * synchronously flushed event — never two `onValueChange` calls in one batch.
   */
  function applyBoundEdit(
    previous: DateBound,
    text: string,
    setBound: (next: DateBound) => void,
  ): void {
    const next = editDateBound(previous, text);
    setBound(next);
    if (next.bound !== previous.bound) pager.reset();
  }

  /**
   * Apply a preset/sort filter and reset the list to page one — but only when
   * the filter actually moved. Re-picking the option that is already selected
   * is not a filter change, so resetting then would throw a later page back for
   * nothing (the same class as finding 2).
   */
  function applyFilterChange<T>(next: T, current: T, set: (value: T) => void): void {
    if (next === current) return;
    set(next);
    pager.reset();
  }

  // what the owner can record against: whatever the server sent, plus a
  // category created here that the refetch has not confirmed yet
  const categoryOptions = [...(categories.data?.items ?? [])];
  if (createdCategory !== null && !categoryOptions.some((option) => option.id === createdCategory.id)) {
    categoryOptions.push(createdCategory);
  }
  /** no category to record against yet */
  const categoryListEmpty = categoryOptions.length === 0;
  /** the list has never produced data: nothing to record against, and nothing
   * to show as an option list either */
  const categoriesUnavailable = categories.data === undefined;
  /** the list loaded and is genuinely empty (distinct from a failed/pending read) */
  const noExpenseCategories = !categoriesUnavailable && categoryListEmpty;

  // the list now carries it, so the grace entry has done its job
  useEffect(() => {
    if (createdCategory === null) return;
    if (categories.data?.items.some((row) => row.id === createdCategory.id) === true) setCreatedCategory(null);
  }, [categories.data, createdCategory]);

  function openCategoryForm() {
    categoryAttemptRef.current += 1;
    setCategoryNotice(null);
    setCategoryError(null);
    setCategoryFormOpen(true);
  }

  function submitCategory(event: React.FormEvent) {
    event.preventDefault();
    setCategoryError(null);
    const name = newCategoryName.trim();
    if (name === "") {
      setCategoryError(t("expenseCategoryNameRequired"));
      return;
    }
    const attempt = categoryAttemptRef.current;
    createCategory.mutate(
      { name },
      {
        onSuccess: (category) => {
          // the category exists either way, so the option and the confirmation
          // are unconditional…
          setCreatedCategory(category);
          setCategoryNotice(category.name);
          // the record form's refusal goes with the message node it names, so a
          // refused date cannot leave a dangling aria-describedby (issue #123)
          setError(null);
          setDateInvalid(false);
          // …but only the attempt still on screen may select it and close
          if (attempt === categoryAttemptRef.current) {
            setCategoryId(category.id);
            setNewCategoryName("");
            setCategoryError(null);
            setCategoryFormOpen(false);
          }
          void queryClient.invalidateQueries({ queryKey: orpc.expenseCategoriesList.queryKey() });
        },
        onError: (err) => {
          // an abandoned attempt's failure belongs to the abandoned draft
          if (attempt === categoryAttemptRef.current) setCategoryError(tError(err.message));
        },
      },
    );
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setDateInvalid(false);
    const parsed = parseGroupedAmount(amount);
    if (parsed === null || parsed <= 0) {
      setError({ message: t("expenseInvalidAmount"), field: "amount" });
      return;
    }
    if (categoryId === "") {
      setError({ message: t("expenseChooseCategory"), field: "category" });
      return;
    }
    // the field teaches `DD/MM/YYYY HH:mm`; a bare date means midnight, and an
    // empty field means "record it now" (the api's default), as before
    const dateText = occurredAt.trim();
    const occurredAtIso = dateText === "" ? undefined : parseDateTimeText(dateText);
    if (dateText !== "" && occurredAtIso === null) {
      setDateInvalid(true);
      setError({ message: t("expenseDateInvalid"), field: "date" });
      return;
    }
    void createExpense.mutate({
      categoryId,
      amount: parsed,
      note: note.trim() === "" ? undefined : note.trim(),
      occurredAt: occurredAtIso ?? undefined,
    });
  }

  // the quick-add form renders in two places: alone when there is no category to
  // record against, and inline under the record form once one exists
  // the empty-state path is the only one that takes focus: opening the form
  // mid-entry must not move the caret out of the field being typed in
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (categoryFormOpen && categoryListEmpty) nameRef.current?.focus();
  }, [categoryFormOpen, categoryListEmpty]);

  const categoryForm = (
    <form id="expense-category-form" className="grid gap-3 rounded bg-accent p-3" onSubmit={submitCategory} data-testid="expense-category-form">
      <label className="grid gap-1 text-sm font-medium">
        {t("expenseCategoryName")}
        <input
          ref={nameRef}
          className={inputClass}
          name="expenseCategoryName"
          autoComplete="off"
          value={newCategoryName}
          onChange={(event) => setNewCategoryName(event.target.value)}
          aria-invalid={categoryError !== null}
          aria-describedby={categoryError !== null ? "expense-category-error" : undefined}
          data-testid="expense-category-name"
        />
      </label>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={createCategory.isPending} data-testid="expense-category-create">
          {t("expenseCategoryCreate")}
        </Button>
        <Button type="button" variant="outline" disabled={createCategory.isPending} onClick={() => setCategoryFormOpen(false)} data-testid="expense-category-cancel">
          {t("expenseCategoryCancel")}
        </Button>
      </div>
      {categoryError !== null && (
        <p id="expense-category-error" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" role="alert" data-testid="expense-category-error">
          {categoryError}
        </p>
      )}
    </form>
  );

  /** the fields the expense is recorded with; disabled while no category exists,
   * so the flow stays legible without offering a save that can only fail */
  const recordFields = (disabled: boolean) => (
    <div className="grid grid-cols-2 gap-3">
      <div className="grid gap-1">
        <div className="flex items-center justify-between gap-2">
          <span id="expense-category-label" className="text-sm font-medium">
            {t("expenseCategory")}
            <span className="text-destructive" aria-hidden="true"> *</span>
            <span className="sr-only"> ({t("expenseRequired")})</span>
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={categoryFormOpen}
            aria-controls="expense-category-form"
            onClick={() => {
              if (categoryFormOpen) {
                setCategoryFormOpen(false);
              } else {
                openCategoryForm();
              }
            }}
            data-testid="expense-category-add"
          >
            {t("expenseCategoryAdd")}
          </Button>
        </div>
        <Select
          value={categoryId}
          onValueChange={(value) => setCategoryId(value ?? "")}
          disabled={disabled}
          items={[
            { value: "", label: t("expenseCategoryPlaceholder") },
            ...categoryOptions.map((category) => ({
              value: category.id,
              label: `${category.name}${category.isOwnerWithdrawal ? ` (${t("expensesWithdrawalBadge")})` : ""}`,
            })),
          ]}
        >
          <SelectTrigger id="expense-category" aria-labelledby="expense-category-label" className="w-full" data-testid="expense-category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">{t("expenseCategoryPlaceholder")}</SelectItem>
            {categoryOptions.map((category) => (
              <SelectItem key={category.id} value={category.id}>
                {category.name}
                {category.isOwnerWithdrawal ? ` (${t("expensesWithdrawalBadge")})` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <label className="grid gap-1">
        <span>
          {t("expenseAmount")}
          <span className="text-destructive" aria-hidden="true"> *</span>
          <span className="sr-only"> ({t("expenseRequired")})</span>
        </span>
        <input className={inputClass} inputMode="numeric" disabled={disabled} value={amount} onChange={(event) => setAmount(event.target.value)} data-testid="expense-amount" />
      </label>
      <label className="grid gap-1">
        {t("expenseNote")}
        <input className={inputClass} disabled={disabled} value={note} onChange={(event) => setNote(event.target.value)} data-testid="expense-note" />
      </label>
      <div className="grid gap-1">
        <label htmlFor="expense-occurred-at">{t("expenseOccurredAt")}</label>
        <DateField
          id="expense-occurred-at"
          name="expenseOccurredAt"
          disabled={disabled}
          value={occurredAt}
          invalid={dateInvalid}
          errorId="expense-error"
          onValueChange={(text) => {
            setOccurredAt(text);
            setDateInvalid(false);
          }}
          onNow={() => {
            // a fresh now is valid: clear only the date field's own refusal —
            // an amount/category/save error is not this button's to hide
            if (error?.field === "date") setError(null);
          }}
          testId="expense-date"
        />
      </div>
    </div>
  );

  return (
    <section data-testid="expenses-page">
      <h1 className="text-xl font-bold">{t("expensesTitle")}</h1>

      <div className="mt-4 grid gap-4 rounded border bg-card p-4" data-testid="expense-record">
        <h2 className="font-semibold">{t("expensesRecordTitle")}</h2>

        {categoriesUnavailable && categories.isError ? (
          <div className="grid gap-2 rounded border border-destructive/20 bg-destructive/10 p-3" data-testid="expense-categories-error">
            <p className="text-sm text-destructive" role="alert">
              {t("expenseCategoriesLoadFailed")}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => void categories.refetch()} data-testid="expense-categories-retry">
              {t("itemsSearchRetry")}
            </Button>
          </div>
        ) : categoriesUnavailable ? (
          <p className="text-sm text-muted-foreground" data-testid="expense-categories-loading">
            {t("appSub")}
          </p>
        ) : categoryListEmpty ? (
          <div className="grid gap-3" data-testid="expense-category-empty">
            <EmptyState
              icon={<Tags size={28} />}
              title={t("expenseCategoryEmpty")}
              hint={t("expenseCategoryEmptyHint")}
              action={
                <Button size="lg" type="button" onClick={openCategoryForm} data-testid="expense-category-empty-action">
                  {t("expenseCategoryCreateFirst")}
                </Button>
              }
            />
            {recordFields(true)}
            {categoryFormOpen && categoryForm}
          </div>
        ) : (
          <>
            <form className="grid gap-3" onSubmit={submit} data-testid="expense-record-form">
              {recordFields(false)}

              <div className="flex items-center gap-3">
                <Button type="submit" disabled={createExpense.isPending} data-testid="expense-save">
                  {t("expenseSave")}
                </Button>
                {saved && <span className="text-sm text-success" data-testid="expense-saved">{t("expenseSaved")}</span>}
              </div>
              {error && <p id="expense-error" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" role="alert" data-testid="expense-error">{error.message}</p>}
            </form>

            {categoryFormOpen && categoryForm}

            {categoryNotice !== null && (
              <p className="text-sm text-success" role="status" data-testid="expense-category-created">
                {t("expenseCategoryCreated", { name: categoryNotice })}
              </p>
            )}
          </>
        )}
      </div>

      <div className="mt-6 grid gap-4">
        <h2 className="font-semibold">{t("expensesHistoryTitle")}</h2>
        <div className="grid gap-3 rounded border bg-card p-4" data-testid="expense-filters">
          <div className="grid grid-cols-3 gap-3">
            <label className="grid gap-1">
              {t("expensesRange")}
              <Select
                value={preset}
                onValueChange={(value) => applyFilterChange(toPreset(value ?? ""), preset, setPreset)}
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
                onValueChange={(value) => applyFilterChange(value === "amount" ? "amount" : "occurredAt", sortBy, setSortBy)}
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
                onValueChange={(value) => applyFilterChange(value === "asc" ? "asc" : "desc", sortDir, setSortDir)}
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="grid gap-1">
                <label htmlFor="expense-custom-from">{t("expensesCustomFrom")}</label>
                <DateField
                  id="expense-custom-from"
                  value={customFrom.text}
                  onValueChange={(text) => applyBoundEdit(customFrom, text, setCustomFrom)}
                  testId="expense-custom-from"
                />
              </div>
              <div className="grid gap-1">
                <label htmlFor="expense-custom-to">{t("expensesCustomTo")}</label>
                <DateField
                  id="expense-custom-to"
                  value={customTo.text}
                  onValueChange={(text) => applyBoundEdit(customTo, text, setCustomTo)}
                  testId="expense-custom-to"
                />
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`rounded-full border px-3 py-1 text-sm ${selectedCategoryIds.size === 0 ? "bg-primary text-primary-foreground" : "bg-card text-foreground"}`}
              onClick={() => {
                // the active pill is a no-op: resetting here would move a later
                // page with no filter change (finding 2's class)
                if (selectedCategoryIds.size === 0) return;
                setSelectedCategoryIds(new Set());
                pager.reset();
              }}
              data-testid="expense-filter-all"
            >
              {t("expensesAllCategories")}
            </button>
            {categoryOptions.map((category) => {
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
        ) : history.isError ? (
          <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive" data-testid="expenses-history-error">
            {tError(history.error instanceof Error ? history.error.message : undefined)}
          </p>
        ) : history.data === undefined || history.data.total === 0 ? (
          <EmptyState
            testId="expenses-empty"
            className="rounded border border-border bg-card"
            title={t(noExpenseCategories ? "expensesEmptyNoCategory" : "expensesEmpty")}
            hint={
              historyFiltersActive
                ? t("expensesEmptyFilteredHint")
                : noExpenseCategories
                  ? t("expenseCategoryEmptyHint")
                  : categoriesUnavailable
                    ? undefined
                    : t("expensesEmptyHint")
            }
            action={
              historyFiltersActive ? (
                <Button size="lg" variant="outline" onClick={clearHistoryFilters} data-testid="expenses-empty-action">
                  {t("expensesEmptyClearFilters")}
                </Button>
              ) : noExpenseCategories ? (
                <Button size="lg" variant="outline" onClick={openCategoryForm} data-testid="expenses-empty-action">
                  {t("expenseCategoryCreateFirst")}
                </Button>
              ) : categoriesUnavailable ? undefined : (
                <Button
                  size="lg"
                  variant="outline"
                  onClick={() => document.querySelector<HTMLInputElement>('[data-testid="expense-amount"]')?.focus()}
                  data-testid="expenses-empty-action"
                >
                  {t("expensesEmptyAction")}
                </Button>
              )
            }
          />
        ) : (
          <>
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
                    <td className="p-3 text-sm whitespace-nowrap text-muted-foreground">{formatDateTime(entry.occurredAt)}</td>
                    <td className="p-3">
                      {category?.name ?? entry.categoryId.slice(0, 8)}
                      {withdrawal && <span className="mr-2 rounded bg-warning px-2 py-0.5 text-xs text-warning-foreground">{t("expensesWithdrawalBadge")}</span>}
                    </td>
                    <td className="p-3 text-sm text-muted-foreground" data-testid="expense-row-note">{entry.note ?? "—"}</td>
                    <td className="p-3 font-semibold"><Amount value={entry.amount} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pager
            total={history.data.total}
            pageSize={pager.pageSize}
            offset={pager.offset}
            onOffsetChange={pager.setOffset}
            onPageSizeChange={pager.setPageSize}
            testId="expenses-pager"
          />
          </>
        )}
      </div>
    </section>
  );
}