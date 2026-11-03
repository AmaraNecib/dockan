import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { MAX_EXPENSE_AMOUNT, type ExpenseCategory, type ExpenseCorrect, type ExpenseCorrection, type ExpenseCorrectionHistory, type ExpenseListItem, type ReportRangePreset } from "@dokan/contracts";
import { Tags } from "lucide-react";

import { tError } from "../lib/i18n";
import { parseGroupedAmount } from "@/lib/amount-parse";
import { Pager } from "@/components/ui/pager";
import { DateField } from "@/components/ui/date-field";
import { inputClass } from "@/components/ui/input";
import { focusByTestId } from "../lib/focus";
import { expenseCorrectionRecoveryQueryKey } from "../lib/query-keys";
import { useSessionCacheScope } from "../lib/session-query-scope";
import { orpc } from "../lib/rpc";
import { usePagination } from "../hooks/use-pagination";
import { editDateBound, formatDateTime, nowDateTimeText, OPEN_BOUND, parseDateTimeText, type DateBound } from "../lib/dates";
import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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

type ExpenseCorrectionAcknowledgement = {
  correction: ExpenseCorrection;
  historyDataUpdateCountAtAck: number;
};
type ExpenseCorrectionRecovery = {
  row: ExpenseListItem | null;
  acknowledgements: ExpenseCorrectionAcknowledgement[];
  notice: string | null;
  correctionRequest: { amount: number; reason?: string; idempotencyKey: string; historyDataUpdateCountAtFailure?: number } | null;
  undoRequests: Record<string, string>;
};
type ExpenseCorrectionRecoveryStore = Record<string, ExpenseCorrectionRecovery>;
const EMPTY_EXPENSE_CORRECTION_RECOVERY: ExpenseCorrectionRecovery = {
  row: null,
  acknowledgements: [],
  notice: null,
  correctionRequest: null,
  undoRequests: {},
};

function isDefinitiveCorrectionRefusal(message: string): boolean {
  return [
    "EXPENSE_CORRECTION_IDEMPOTENCY_KEY_REUSED",
    "EXPENSE_CORRECTION_NO_CHANGE",
    "EXPENSE_CORRECTION_NOT_FOUND",
    "EXPENSE_CORRECTION_ALREADY_REVERSED",
    "EXPENSE_CORRECTION_NOT_REVERSIBLE",
    "EXPENSE_CORRECTION_UNDO_OUT_OF_RANGE",
  ].includes(message);
}

function toPreset(value: string): ReportRangePreset {
  for (const preset of PRESET_KEYS) {
    if (value === preset) return preset;
  }
  return "CURRENT_MONTH";
}

function ExpenseCorrectionRow({
  entry,
  categoryName,
  withdrawal,
  onRecoveryChange,
  onAcknowledged,
  onHistoryConfirmed,
  onClearNotice,
  onRequestChange,
  onUndoRequestsChange,
  recovery,
}: {
  entry: ExpenseListItem;
  categoryName: string;
  withdrawal: boolean;
  onRecoveryChange: (entry: ExpenseListItem, active: boolean) => void;
  onAcknowledged: (expenseId: string, entry: ExpenseListItem, correction: ExpenseCorrection, historyDataUpdateCountAtAck: number, notice: string) => void;
  onHistoryConfirmed: (expenseId: string, history: ExpenseCorrectionHistory) => void;
  onClearNotice: (expenseId: string) => void;
  onRequestChange: (expenseId: string, correctionRequest: ExpenseCorrectionRecovery["correctionRequest"], undoRequests: Record<string, string>) => void;
  onUndoRequestsChange: (expenseId: string, undoRequests: Record<string, string>) => void;
  recovery: ExpenseCorrectionRecovery;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftAmount, setDraftAmount] = useState(recovery.correctionRequest === null ? "" : String(recovery.correctionRequest.amount));
  const [draftReason, setDraftReason] = useState(recovery.correctionRequest?.reason ?? "");
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [historyActionError, setHistoryActionError] = useState<string | null>(null);
  const [discardConfirmation, setDiscardConfirmation] = useState<{ fingerprint: string; previousKey: string } | null>(null);
  const [undoConfirmationId, setUndoConfirmationId] = useState<string | null>(() => Object.keys(recovery.undoRequests)[0] ?? null);
  const correctionKeyRef = useRef<{ fingerprint: string; key: string } | null>(recovery.correctionRequest === null ? null : {
    fingerprint: `${recovery.correctionRequest.amount}\u0000${recovery.correctionRequest.reason ?? ""}`,
    key: recovery.correctionRequest.idempotencyKey,
  });
  const undoKeysRef = useRef(new Map(Object.entries(recovery.undoRequests)));
  const historyOptions = useMemo(
    () => orpc.expenseCorrectionHistory.queryOptions({ input: { expenseId: entry.id } }),
    [entry.id],
  );
  const history = useQuery({ ...historyOptions, enabled: expanded });
  const historyDataUpdateCount = queryClient.getQueryState(historyOptions.queryKey)?.dataUpdateCount ?? 0;

  const listCorrectionCount = entry.correctionCount ?? 0;
  const historyCorrectionCount = history.data?.corrections.length ?? 0;
  const pendingAcknowledgements = recovery.acknowledgements;
  const pendingAcknowledgementSignature = pendingAcknowledgements.map((pending) => `${pending.correction.id}:${pending.historyDataUpdateCountAtAck}`).join("|");
  const pendingAcknowledgementsInHistory = history.data !== undefined
    && pendingAcknowledgements.length > 0
    && pendingAcknowledgements.every((pending) => history.data?.corrections.some((event) => event.id === pending.correction.id) === true);
  const amountConflict = history.data !== undefined
    && historyCorrectionCount === listCorrectionCount
    && history.data.effectiveAmount !== entry.effectiveAmount;
  const unorderedAcknowledgements = pendingAcknowledgements.length > 1 && !pendingAcknowledgementsInHistory;
  const latestKnownAmount = historyCorrectionCount > listCorrectionCount
    ? history.data?.effectiveAmount ?? entry.effectiveAmount
    : entry.effectiveAmount;
  const effectiveAmount = amountConflict || unorderedAcknowledgements
    ? undefined
    : pendingAcknowledgements.length === 1 && !pendingAcknowledgementsInHistory
      ? pendingAcknowledgements[0]?.correction.afterAmount
      : latestKnownAmount;
  const amountNeedsVerification = pendingAcknowledgements.length > 0 || recovery.correctionRequest !== null || Object.keys(recovery.undoRequests).length > 0;
  const correctionHistoryRefreshedAfterFailure = recovery.correctionRequest?.historyDataUpdateCountAtFailure !== undefined
    && history.isSuccess
    && historyDataUpdateCount > recovery.correctionRequest.historyDataUpdateCountAtFailure;
  const correctionDraftChanged = recovery.correctionRequest !== null && (
    parseGroupedAmount(draftAmount) !== recovery.correctionRequest.amount
    || draftReason.trim() !== (recovery.correctionRequest.reason ?? "")
  );
  const editingBlocked = amountConflict || pendingAcknowledgements.length > 0 || (
    correctionDraftChanged
    && recovery.correctionRequest?.historyDataUpdateCountAtFailure !== undefined
    && (!correctionHistoryRefreshedAfterFailure || history.isError)
  );

  const refreshCorrectionHistory = useCallback(async () => {
    await queryClient.cancelQueries({ queryKey: historyOptions.queryKey, exact: true });
    try {
      const freshHistory = await queryClient.fetchQuery({ ...historyOptions, staleTime: 0 });
      onHistoryConfirmed(entry.id, freshHistory);
    } catch {
      // A failed read leaves every acknowledgement unresolved and edits blocked.
    }
  }, [entry.id, historyOptions, onHistoryConfirmed, onRequestChange, queryClient, recovery.correctionRequest]);

  useEffect(() => {
    const freshHistory = history.data;
    if (!history.isSuccess || freshHistory === undefined || pendingAcknowledgements.length === 0) return;
    const eventIds = new Set(freshHistory.corrections.map((event) => event.id));
    const readStartedAfterEveryAck = pendingAcknowledgements.every(
      (pending) => historyDataUpdateCount > pending.historyDataUpdateCountAtAck,
    );
    if (readStartedAfterEveryAck && pendingAcknowledgements.every((pending) => eventIds.has(pending.correction.id))) {
      onHistoryConfirmed(entry.id, freshHistory);
    }
  }, [entry.id, history.data, historyDataUpdateCount, history.isSuccess, onHistoryConfirmed, pendingAcknowledgementSignature]);

  useEffect(() => {
    onRecoveryChange(entry, editing || undoConfirmationId !== null || amountNeedsVerification);
  }, [entry, editing, undoConfirmationId, amountNeedsVerification, onRecoveryChange]);

  const correction = useMutation(
    orpc.expensesCorrect.mutationOptions({
      onSuccess: (savedCorrection) => {
        setEditing(false);
        setCorrectionError(null);
        onAcknowledged(entry.id, entry, savedCorrection, queryClient.getQueryState(historyOptions.queryKey)?.dataUpdateCount ?? 0, t("expenseCorrectionSaved"));
        correctionKeyRef.current = null;
        onRequestChange(entry.id, null, Object.fromEntries(undoKeysRef.current));
        void queryClient.invalidateQueries();
        void refreshCorrectionHistory();
      },
      onError: (error, input) => {
        setCorrectionError(tError(error.message));
        // Unknown failures may hide a committed write; known domain refusals cannot.
        let unresolvedRequest: ExpenseCorrectionRecovery["correctionRequest"] = null;
        if (!isDefinitiveCorrectionRefusal(error.message)) {
          unresolvedRequest = {
            amount: input.amount,
            idempotencyKey: input.idempotencyKey,
            historyDataUpdateCountAtFailure: queryClient.getQueryState(historyOptions.queryKey)?.dataUpdateCount ?? 0,
          };
          if (input.reason !== undefined) unresolvedRequest.reason = input.reason;
        }
        correctionKeyRef.current = unresolvedRequest === null ? null : {
          fingerprint: `${input.amount}\u0000${input.reason?.trim() ?? ""}`,
          key: input.idempotencyKey,
        };
        onRequestChange(entry.id, unresolvedRequest, Object.fromEntries(undoKeysRef.current));
        void queryClient.invalidateQueries();
        void refreshCorrectionHistory();
      },
    }),
  );

  const undo = useMutation(
    orpc.expensesCorrectionUndo.mutationOptions({
      onSuccess: (savedUndo) => {
        setUndoConfirmationId(null);
        setHistoryActionError(null);
        onAcknowledged(entry.id, entry, savedUndo, queryClient.getQueryState(historyOptions.queryKey)?.dataUpdateCount ?? 0, t("expenseCorrectionUndoSaved"));
        undoKeysRef.current.delete(savedUndo.reversesCorrectionId ?? "");
        onUndoRequestsChange(entry.id, Object.fromEntries(undoKeysRef.current));
        void queryClient.invalidateQueries();
        void refreshCorrectionHistory();
      },
      onError: (error, input) => {
        setHistoryActionError(tError(error.message));
        if (isDefinitiveCorrectionRefusal(error.message)) undoKeysRef.current.delete(input.correctionId);
        else undoKeysRef.current.set(input.correctionId, input.idempotencyKey);
        onUndoRequestsChange(entry.id, Object.fromEntries(undoKeysRef.current));
        void queryClient.invalidateQueries();
        void refreshCorrectionHistory();
      },
    }),
  );

  function openCorrectionEditor(): void {
    setExpanded(true);
    if (editing || correction.isPending || (editingBlocked && recovery.correctionRequest === null)) return;
    setEditing(true);
    if (recovery.correctionRequest === null) {
      setDraftAmount(String(effectiveAmount));
      setDraftReason("");
    }
    setCorrectionError(null);
    setHistoryActionError(null);
    onClearNotice(entry.id);
    if (recovery.correctionRequest === null) correctionKeyRef.current = null;
  }

  function cancelCorrectionEditor(): void {
    setEditing(false);
    setDiscardConfirmation(null);
    setCorrectionError(null);
    if (recovery.correctionRequest === null) correctionKeyRef.current = null;
  }

  function submitCorrection(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setCorrectionError(null);
    const amount = parseGroupedAmount(draftAmount);
    if (amount === null || amount < 1 || amount > MAX_EXPENSE_AMOUNT) {
      setCorrectionError(t("expenseCorrectionAmountInvalid"));
      return;
    }
    const reason = draftReason.trim();
    const fingerprint = `${amount}\u0000${reason}`;
    if (editingBlocked) return;
    const previous = correctionKeyRef.current;
    if (correction.isPending && previous?.fingerprint === fingerprint) return;
    if (recovery.correctionRequest !== null && !correction.isPending && previous?.fingerprint !== fingerprint) {
      if (!history.isSuccess || history.data === undefined) return;
      setDiscardConfirmation({ fingerprint, previousKey: recovery.correctionRequest.idempotencyKey });
      return;
    }
    sendCorrection(amount, reason);
  }

  function sendCorrection(amount: number, reason: string): void {
    const fingerprint = `${amount}\u0000${reason}`;
    const previous = correctionKeyRef.current;
    const idempotencyKey = previous?.fingerprint === fingerprint ? previous.key : crypto.randomUUID();
    correctionKeyRef.current = { fingerprint, key: idempotencyKey };
    const input: ExpenseCorrect = {
      expenseId: entry.id,
      amount,
      idempotencyKey,
    };
    if (reason !== "") input.reason = reason;
    const correctionRequest: NonNullable<ExpenseCorrectionRecovery["correctionRequest"]> = { amount, idempotencyKey };
    if (reason !== "") correctionRequest.reason = reason;
    onRequestChange(entry.id, correctionRequest, Object.fromEntries(undoKeysRef.current));
    correction.mutate(input);
  }

  function confirmDiscardAndContinue(): void {
    const pending = discardConfirmation;
    const amount = parseGroupedAmount(draftAmount);
    const reason = draftReason.trim();
    const fingerprint = amount === null ? "" : `${amount}\u0000${reason}`;
    if (pending === null || amount === null || pending.fingerprint !== fingerprint
      || recovery.correctionRequest?.idempotencyKey !== pending.previousKey
      || correction.isPending || editingBlocked || !correctionHistoryRefreshedAfterFailure || history.data === undefined) {
      setDiscardConfirmation(null);
      return;
    }
    setDiscardConfirmation(null);
    // Keep unresolved undo identities; discard only the old correction retry.
    correctionKeyRef.current = null;
    onRequestChange(entry.id, null, Object.fromEntries(undoKeysRef.current));
    sendCorrection(amount, reason);
  }

  function confirmUndo(correctionId: string): void {
    if (editingBlocked) return;
    const key = undoKeysRef.current.get(correctionId) ?? crypto.randomUUID();
    undoKeysRef.current.set(correctionId, key);
    onRequestChange(entry.id, recovery.correctionRequest, Object.fromEntries(undoKeysRef.current));
    undo.mutate({ correctionId, idempotencyKey: key });
  }

  function retryCurrentAmountReads(): void {
    void queryClient.invalidateQueries();
    void refreshCorrectionHistory();
  }

  function actorLabel(name: string | null, id: string | null) {
    if (name !== null && id !== null) {
      return <>{name} <bdi dir="ltr" className="break-all text-xs">({id})</bdi></>;
    }
    if (name !== null) return name;
    if (id !== null) return <bdi dir="ltr" className="break-all text-xs">{id}</bdi>;
    return t("expenseActorUnknown");
  }

  return (
    <>
      <tr className={`border-b ${withdrawal ? "bg-warning/10" : ""}`} data-testid="expense-row">
        <td className="p-3 text-sm whitespace-nowrap text-muted-foreground">{formatDateTime(entry.occurredAt)}</td>
        <td className="p-3">
          {categoryName}
          {withdrawal && <span className="mr-2 rounded bg-warning px-2 py-0.5 text-xs text-warning-foreground">{t("expensesWithdrawalBadge")}</span>}
        </td>
        <td className="p-3 text-sm text-muted-foreground" data-testid="expense-row-note">{entry.note ?? "—"}</td>
        <td className="p-3 font-semibold" data-testid="expense-row-effective-amount" data-value={effectiveAmount}>
          {effectiveAmount === undefined ? <span>—</span> : <Amount value={effectiveAmount} />}
          {amountNeedsVerification && (
            <div className="mt-1 grid gap-1 text-xs font-normal" role="status" data-testid="expense-correction-amount-unverified">
              <p>{t("expenseCorrectionAmountUnverified")}</p>
              <Button type="button" size="sm" variant="outline" onClick={retryCurrentAmountReads} data-testid="expense-correction-amount-retry">
                {t("expenseCorrectionRetry")}
              </Button>
            </div>
          )}
          {amountConflict && (
            <div className="mt-1 grid gap-1 text-xs font-normal" role="alert" data-testid="expense-correction-amount-conflict">
              <p>{t("expenseCorrectionAmountConflict")}</p>
              <Button type="button" size="sm" variant="outline" onClick={retryCurrentAmountReads} data-testid="expense-correction-amount-conflict-retry">
                {t("expenseCorrectionRetry")}
              </Button>
            </div>
          )}
        </td>
        <td className="p-3">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-expanded={expanded}
              aria-controls={`expense-correction-details-${entry.id}`}
              onClick={() => setExpanded((current) => !current)}
              data-testid="expense-correction-open-history"
            >
              {t("expenseCorrectionHistoryButton")}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={editingBlocked} onClick={openCorrectionEditor} data-testid="expense-correction-open-editor">
              {t("expenseCorrectionEditButton")}
            </Button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b bg-muted/30">
          <td colSpan={5} className="p-3" id={`expense-correction-details-${entry.id}`}>
            <section className="grid gap-3" data-testid="expense-correction-history">
              <h3 className="font-semibold">{t("expenseCorrectionHistoryHeading")}</h3>
              {history.isPending ? (
                <div className="grid gap-2" aria-busy="true">
                  <p className="sr-only">{t("expensesLoading")}</p>
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : history.isError ? (
                <div className="grid gap-2 rounded border border-destructive/20 bg-destructive/10 p-3" role="alert">
                  <p className="text-sm text-destructive" data-testid="expense-correction-history-error">{t("expenseCorrectionLoadError")}</p>
                  <Button type="button" size="sm" variant="outline" onClick={retryCurrentAmountReads} data-testid="expense-correction-history-retry">
                    {t("expenseCorrectionRetry")}
                  </Button>
                </div>
              ) : history.data !== undefined ? (
                <>
                  <ol className="grid gap-3">
                    <li className="grid gap-2 border-b pb-3" data-testid="expense-correction-original">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h4 className="font-medium">{t("expenseCorrectionOriginal")}</h4>
                        <Amount value={history.data.original.amount} />
                      </div>
                      <dl className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-2">
                        <div><dt className="text-muted-foreground">{t("expenseCorrectionEffectiveDate")}</dt><dd>{formatDateTime(history.data.original.occurredAt)}</dd></div>
                        <div><dt className="text-muted-foreground">{t("expenseCorrectionRecordedAt")}</dt><dd>{formatDateTime(history.data.original.createdAt)}</dd></div>
                        <div><dt className="text-muted-foreground">{t("expenseCorrectionActor")}</dt><dd>{actorLabel(history.data.original.actorName, history.data.original.actorId)}</dd></div>
                      </dl>
                    </li>
                    {history.data.corrections.map((event) => (
                      <li key={event.id} id={`expense-correction-entry-${event.id}`} className="grid gap-2 border-b pb-3 last:border-0" data-testid="expense-correction-entry">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <h4 className="font-medium">{event.reversesCorrectionId === null ? t("expenseCorrectionStage") : t("expenseCorrectionReversalOf")}</h4>
                          <bdi dir="ltr" className="break-all text-xs text-muted-foreground">{event.id}</bdi>
                          <span className="text-sm">
                            <Amount value={event.beforeAmount} /> <span aria-hidden="true">→</span> <Amount value={event.afterAmount} />
                          </span>
                        </div>
                        <dl className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-2">
                          <div>
                            <dt className="text-muted-foreground">{t("expenseCorrectionDifference")}</dt>
                            <dd data-testid="expense-correction-difference">
                              <Amount value={Math.abs(event.difference)} sign={event.difference > 0 ? "+" : "−"} />
                            </dd>
                          </div>
                          <div><dt className="text-muted-foreground">{t("expenseCorrectionEffectiveDate")}</dt><dd>{formatDateTime(event.effectiveAt)}</dd></div>
                          <div><dt className="text-muted-foreground">{t("expenseCorrectionRecordedAt")}</dt><dd>{formatDateTime(event.recordedAt)}</dd></div>
                          <div><dt className="text-muted-foreground">{t("expenseCorrectionActor")}</dt><dd>{actorLabel(event.actorName, event.actorId)}</dd></div>
                          <div><dt className="text-muted-foreground">{t("expenseCorrectionReasonLabel")}</dt><dd>{event.reason ?? t("expenseCorrectionNoReason")}</dd></div>
                        </dl>
                        {event.reversesCorrectionId !== null && (
                          <p className="text-xs text-muted-foreground">{t("expenseCorrectionReversalOf")} <a className="underline" href={`#expense-correction-entry-${event.reversesCorrectionId}`}><bdi dir="ltr" className="break-all">{event.reversesCorrectionId}</bdi></a></p>
                        )}
                        {event.reversedByCorrectionId !== null && (
                          <p className="text-xs text-muted-foreground" role="status">
                            {t("expenseCorrectionReversedBy")} <a className="underline" href={`#expense-correction-entry-${event.reversedByCorrectionId}`}><bdi dir="ltr" className="break-all">{event.reversedByCorrectionId}</bdi></a>
                          </p>
                        )}
                        {event.reversesCorrectionId === null && event.reversedByCorrectionId === null && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={undo.isPending || editingBlocked}
                            onClick={() => { setHistoryActionError(null); setUndoConfirmationId(event.id); }}
                            data-testid="expense-correction-undo"
                          >
                            {t("expenseCorrectionUndo")}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ol>
                </>
              ) : null}
              {undoConfirmationId !== null && (
                <div className="grid gap-2 rounded border bg-card p-3" role="group" aria-labelledby={`expense-correction-undo-prompt-${undoConfirmationId}`} data-testid="expense-correction-undo-confirm">
                  <p id={`expense-correction-undo-prompt-${undoConfirmationId}`} className="text-sm">{t("expenseCorrectionUndoConfirm")}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" disabled={undo.isPending} onClick={() => setUndoConfirmationId(null)} data-testid="expense-correction-undo-cancel">
                      {t("expenseCorrectionUndoCancel")}
                    </Button>
                    <Button type="button" size="sm" disabled={undo.isPending || editingBlocked} onClick={() => confirmUndo(undoConfirmationId)} data-testid="expense-correction-undo-confirm-button">
                      {undo.isPending ? t("expenseCorrectionSaving") : t("expenseCorrectionUndoConfirmButton")}
                    </Button>
                  </div>
                </div>
              )}
              {editing && (
                <form className="grid gap-3 rounded border bg-card p-3" onSubmit={submitCorrection} data-testid="expense-correction-form">
                  <label className="grid gap-1 text-sm font-medium" htmlFor={`expense-correction-amount-${entry.id}`}>
                    {t("expenseCorrectionNewAmount")}
                    <input
                      id={`expense-correction-amount-${entry.id}`}
                      className={inputClass}
                      type="text"
                      inputMode="numeric"
                      value={draftAmount}
                      aria-invalid={correctionError !== null}
                      aria-describedby={correctionError !== null ? `expense-correction-error-${entry.id}` : undefined}
                      onChange={(event) => { setDraftAmount(event.target.value); setCorrectionError(null); setDiscardConfirmation(null); }}
                      data-testid="expense-correction-amount"
                    />
                  </label>
                  <label className="grid gap-1 text-sm font-medium" htmlFor={`expense-correction-reason-${entry.id}`}>
                    {t("expenseCorrectionReasonLabel")}
                    <textarea
                      id={`expense-correction-reason-${entry.id}`}
                      className={inputClass}
                      rows={2}
                      maxLength={500}
                      value={draftReason}
                      onChange={(event) => { setDraftReason(event.target.value); setDiscardConfirmation(null); }}
                      data-testid="expense-correction-reason"
                    />
                  </label>
                  {discardConfirmation !== null && (
                    <div className="grid gap-2 rounded border border-warning/40 bg-warning/10 p-3 text-sm" role="alert" data-testid="expense-correction-discard-confirmation">
                      <p data-testid="expense-correction-discard-warning">{t("expenseCorrectionDiscardWarning")}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" size="sm" disabled={correction.isPending} onClick={confirmDiscardAndContinue} data-testid="expense-correction-discard-confirm">
                          {t("expenseCorrectionDiscardConfirm")}
                        </Button>
                        <Button type="button" size="sm" variant="outline" disabled={correction.isPending} onClick={() => setDiscardConfirmation(null)} data-testid="expense-correction-discard-cancel">
                          {t("expenseCorrectionCancel")}
                        </Button>
                      </div>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" size="sm" disabled={correction.isPending || editingBlocked} data-testid="expense-correction-save">
                      {correction.isPending ? t("expenseCorrectionSaving") : t("expenseCorrectionSave")}
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={correction.isPending} onClick={cancelCorrectionEditor} data-testid="expense-correction-cancel">
                      {t("expenseCorrectionCancel")}
                    </Button>
                  </div>
                  {correctionError !== null && (
                    <p id={`expense-correction-error-${entry.id}`} className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" role="alert" data-testid="expense-correction-error">
                      {correctionError}
                    </p>
                  )}
                </form>
              )}
              {historyActionError !== null && <p className="text-sm text-destructive" role="alert">{historyActionError}</p>}
            </section>
          </td>
        </tr>
      )}
    </>
  );
}

/** The record form's error, tagged with the control it belongs to so a field
 * action (the Now button) clears only its own field refusal. */
type RecordError = { message: string; field: "amount" | "category" | "date" | "save" };

export function ExpensesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const sessionCacheScope = useSessionCacheScope();
  const correctionRecoveryKey = useMemo(() => expenseCorrectionRecoveryQueryKey(sessionCacheScope), [sessionCacheScope]);
  const correctionRecoveryQuery = useQuery({
    queryKey: correctionRecoveryKey,
    queryFn: async (): Promise<ExpenseCorrectionRecoveryStore> => ({}),
    initialData: (): ExpenseCorrectionRecoveryStore => ({}),
    enabled: false,
    gcTime: Infinity,
  });
  const correctionRecoveryStore = correctionRecoveryQuery.data;
  const correctionNotices = Object.entries(correctionRecoveryStore).flatMap(([expenseId, state]) =>
    state.notice === null ? [] : [[expenseId, state.notice] as const],
  );
  const categories = useQuery(orpc.expenseCategoriesList.queryOptions());
  const clearCorrectionNotice = useCallback((expenseId: string) => {
    queryClient.setQueryData<ExpenseCorrectionRecoveryStore>(correctionRecoveryKey, (current) => {
      if (current === undefined) return current;
      const existing = current[expenseId];
      if (existing === undefined || existing.notice === null) return current;
      const updated = { ...existing, notice: null };
      const next = { ...current };
      if (updated.row === null && updated.acknowledgements.length === 0) delete next[expenseId];
      else next[expenseId] = updated;
      return next;
    });
  }, [correctionRecoveryKey, queryClient]);
  const retainRecoveryRow = useCallback((entry: ExpenseListItem, active: boolean) => {
    queryClient.setQueryData<ExpenseCorrectionRecoveryStore>(correctionRecoveryKey, (current) => {
      if (current === undefined) return current;
      const existing = current[entry.id] ?? EMPTY_EXPENSE_CORRECTION_RECOVERY;
      if (active && existing.row === entry) return current;
      if (!active && existing.row === null) return current;
      const updated = { ...existing, row: active ? entry : null };
      const next = { ...current };
      if (updated.row === null && updated.acknowledgements.length === 0 && updated.notice === null && updated.correctionRequest === null && Object.keys(updated.undoRequests).length === 0) delete next[entry.id];
      else next[entry.id] = updated;
      return next;
    });
  }, [correctionRecoveryKey, queryClient]);
  const retainUndoRequests = useCallback((expenseId: string, undoRequests: Record<string, string>) => {
    queryClient.setQueryData<ExpenseCorrectionRecoveryStore>(correctionRecoveryKey, (current) => {
      const store = current ?? {};
      const existing = store[expenseId] ?? EMPTY_EXPENSE_CORRECTION_RECOVERY;
      const updated = { ...existing, undoRequests };
      const next = { ...store };
      if (updated.row === null && updated.acknowledgements.length === 0 && updated.notice === null && updated.correctionRequest === null && Object.keys(undoRequests).length === 0) delete next[expenseId];
      else next[expenseId] = updated;
      return next;
    });
  }, [correctionRecoveryKey, queryClient]);
  const retainCorrectionRequests = useCallback((expenseId: string, correctionRequest: ExpenseCorrectionRecovery["correctionRequest"], undoRequests: Record<string, string>) => {
    queryClient.setQueryData<ExpenseCorrectionRecoveryStore>(correctionRecoveryKey, (current) => {
      const store = current ?? {};
      const existing = store[expenseId] ?? EMPTY_EXPENSE_CORRECTION_RECOVERY;
      const updated = { ...existing, correctionRequest, undoRequests };
      const next = { ...store };
      if (updated.row === null && updated.acknowledgements.length === 0 && updated.notice === null && correctionRequest === null && Object.keys(undoRequests).length === 0) delete next[expenseId];
      else next[expenseId] = updated;
      return next;
    });
  }, [correctionRecoveryKey, queryClient]);

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
  /** the testid of the history filter the owner last CHANGED. After clearing,
   * focus returns to that control, because it is what emptied the view; an
   * "always the range preset" rule would send a keyboard user to a control that
   * never narrowed the list (issue #96 round 4, the invoice rule at 5144100) */
  const lastHistoryFilterRef = useRef<string | null>(null);

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

  const expenseListOptions = orpc.expensesList.queryOptions({
    input: {
      preset,
      customFrom: customFrom.bound,
      customTo: customTo.bound,
      categoryIds: selectedCategoryIds.size > 0 ? [...selectedCategoryIds] : undefined,
      sortBy,
      sortDir,
      ...pager.pagination,
    },
  });
  const history = useQuery(expenseListOptions);
  const acknowledgeCorrection = useCallback((expenseId: string, entry: ExpenseListItem, correction: ExpenseCorrection, historyDataUpdateCountAtAck: number, notice: string) => {
    queryClient.setQueryData<ExpenseCorrectionRecoveryStore>(correctionRecoveryKey, (current) => {
      const store = current ?? {};
      const existing = store[expenseId] ?? EMPTY_EXPENSE_CORRECTION_RECOVERY;
      const acknowledgements = existing.acknowledgements.some((event) => event.correction.id === correction.id)
        ? existing.acknowledgements
        : [...existing.acknowledgements, { correction, historyDataUpdateCountAtAck }];
      return { ...store, [expenseId]: { ...existing, row: entry, acknowledgements, notice } };
    });
  }, [correctionRecoveryKey, queryClient]);
  const confirmAcknowledgementsFromFreshHistory = useCallback((expenseId: string, freshHistory: ExpenseCorrectionHistory) => {
    queryClient.setQueryData<ExpenseCorrectionRecoveryStore>(correctionRecoveryKey, (current) => {
      if (current === undefined) return current;
      const existing = current[expenseId];
      if (existing === undefined || existing.acknowledgements.length === 0) return current;
      const eventIds = new Set(freshHistory.corrections.map((event) => event.id));
      if (!existing.acknowledgements.every((event) => eventIds.has(event.correction.id))) return current;
      const updated = { ...existing, acknowledgements: [] };
      const next = { ...current };
      if (updated.row === null && updated.notice === null) delete next[expenseId];
      else next[expenseId] = updated;
      return next;
    });
  }, [correctionRecoveryKey, queryClient]);

  // Active editors, undo confirmations and acknowledgements outlive sorted-page membership.
  const visibleRows = new Map((history.data?.items ?? []).map((entry) => [entry.id, entry]));
  for (const [id, state] of Object.entries(correctionRecoveryStore)) {
    if (state.row !== null && !visibleRows.has(id)) visibleRows.set(id, state.row);
  }

  const toggleCategory = (id: string) => {
    pager.reset();
    lastHistoryFilterRef.current = `expense-filter-${id}`;
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
    // the clicked button is replaced by the table (or by an action-less empty
    // state), so focus is handed to a control that survives BEFORE the button
    // unmounts (issue #96 round 4 -- the same class as the invoice clear at
    // 5144100). The target is the filter that emptied the view; the range preset
    // is the fallback because it is always rendered, including when that
    // filter's own control is gone.
    const last = lastHistoryFilterRef.current;
    // the mechanism reports whether focus moved, so the fallback is a deliberate
    // branch instead of a silent second drop (issue #248)
    const moved = last !== null && focusByTestId(last);
    if (!moved) focusByTestId("expense-range-preset");
    lastHistoryFilterRef.current = null;
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
    if (next.bound !== previous.bound) {
      // an APPLIED bound is a window change, and the fields themselves unmount when
      // the window resets, so the range control is the focus target after a clear
      lastHistoryFilterRef.current = "expense-range-preset";
      pager.reset();
    }
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
                onValueChange={(value) => {
                  lastHistoryFilterRef.current = "expense-range-preset";
                  applyFilterChange(toPreset(value ?? ""), preset, setPreset);
                }}
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
                lastHistoryFilterRef.current = "expense-filter-all";
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

        {history.isError && (
          <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive" data-testid="expenses-history-error">
            {tError(history.error instanceof Error ? history.error.message : undefined)}
          </p>
        )}
        {history.isPending && visibleRows.size === 0 ? (
          <p className="rounded border bg-card p-4 text-muted-foreground" data-testid="expenses-loading">{t("expensesLoading")}</p>
        ) : !history.isError && visibleRows.size === 0 ? (
          <EmptyState
            testId="expenses-empty"
            card
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
        ) : null}
        {correctionNotices.length > 0 && (
          <div className="grid gap-2" aria-live="polite">
            {[...correctionNotices].map(([expenseId, message]) => (
              <div key={expenseId} className="flex flex-wrap items-center gap-2 text-sm text-success">
                <p role="status" data-testid="expense-correction-saved">{message}</p>
                <Button type="button" size="sm" variant="outline" aria-label={t("expenseCorrectionDismiss")} onClick={() => clearCorrectionNotice(expenseId)} data-testid="expense-correction-dismiss">
                  {t("expenseCorrectionDismiss")}
                </Button>
              </div>
            ))}
          </div>
        )}
        {visibleRows.size > 0 && (
          <table className="w-full rounded border bg-card" data-testid="expense-history">
            <thead>
              <tr className="border-b text-right text-sm text-muted-foreground">
                <th className="p-3">{t("expenseColDate")}</th>
                <th className="p-3">{t("expenseColCategory")}</th>
                <th className="p-3">{t("expenseColNote")}</th>
                <th className="p-3">{t("expenseColAmount")}</th>
                <th className="p-3">{t("expenseCorrectionEditButton")}</th>
              </tr>
            </thead>
            <tbody>
              {[...visibleRows.values()].map((entry) => {
                const category = categories.data?.items.find((row) => row.id === entry.categoryId);
                return (
                  <ExpenseCorrectionRow
                    key={entry.id}
                    entry={entry}
                    categoryName={category?.name ?? entry.categoryId.slice(0, 8)}
                    withdrawal={category?.isOwnerWithdrawal === true}
                    onRecoveryChange={retainRecoveryRow}
                    onAcknowledged={acknowledgeCorrection}
                    onHistoryConfirmed={confirmAcknowledgementsFromFreshHistory}
                    onClearNotice={clearCorrectionNotice}
                    onRequestChange={retainCorrectionRequests}
                    onUndoRequestsChange={retainUndoRequests}
                    recovery={correctionRecoveryStore[entry.id] ?? EMPTY_EXPENSE_CORRECTION_RECOVERY}
                  />
                );
              })}
            </tbody>
          </table>
        )}
        {history.data !== undefined && history.data.total > 0 && (
          <Pager
            total={history.data.total}
            pageSize={pager.pageSize}
            offset={pager.offset}
            onOffsetChange={pager.setOffset}
            onPageSizeChange={pager.setPageSize}
            testId="expenses-pager"
          />
        )}
      </div>
    </section>
  );
}