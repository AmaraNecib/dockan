import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ExpenseRefundInput, ExpenseRefundUndoInput } from "@dokan/contracts";
import { orpc } from "../lib/rpc";
import { useSessionCacheScope } from "../lib/session-query-scope";
import { parseGroupedAmount } from "../lib/amount-parse";
import { formatDateTime, nowDateTimeText, parseDateTimeText } from "../lib/dates";
import { tError } from "../lib/i18n";
import { Amount } from "./ui/amount";
import { Button } from "./ui/button";
import { inputClass } from "./ui/input";

type Request = { kind: "refund"; input: ExpenseRefundInput } | { kind: "undo"; input: ExpenseRefundUndoInput };
type Recovery = { request: Request | null; inFlight: boolean; acknowledgedId: string | null; notice: boolean };
const EMPTY: Recovery = { request: null, inFlight: false, acknowledgedId: null, notice: false };

/** Recovery is mount-independent but session-local; uncertain requests keep their exact identity. */
export function ExpenseRefundPanel({ expenseId }: { expenseId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return <section className="grid gap-3 border-t pt-3" data-testid="expense-refund-section">
    <Button type="button" variant="outline" size="sm" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="expense-refund-open">{t("expenseRefundTitle")}</Button>
    {open && <RefundEditor expenseId={expenseId} onCancel={() => setOpen(false)} />}
  </section>;
}

function RefundEditor({ expenseId, onCancel }: { expenseId: string; onCancel: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const scope = useSessionCacheScope();
  const recoveryKey = ["expenseRefundRecovery", scope, expenseId];
  const { data: recovery = EMPTY } = useQuery<Recovery>({ queryKey: recoveryKey, queryFn: () => EMPTY, enabled: false, gcTime: Infinity });
  const history = useQuery(orpc.expenseRefundHistory.queryOptions({ input: { expenseId } }));
  const refund = useMutation(orpc.expensesRefund.mutationOptions());
  const undo = useMutation(orpc.expensesRefundUndo.mutationOptions());
  const [amountText, setAmountText] = useState(recovery.request?.kind === "refund" ? String(recovery.request.input.amount) : "");
  const [dateText, setDateText] = useState(recovery.request?.kind === "refund" ? formatDateTime(recovery.request.input.occurredAt) : nowDateTimeText());
  const [reason, setReason] = useState(recovery.request?.kind === "refund" ? recovery.request.input.reason ?? "" : "");
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const submitting = useRef(false);
  const confirmed = recovery.acknowledgedId === null || history.data?.refunds.some((row) => row.id === recovery.acknowledgedId) === true;
  const blocked = recovery.inFlight || history.isFetching || history.isError || history.data === undefined || !confirmed;
  const locked = blocked || recovery.request !== null;

  useEffect(() => {
    if (recovery.acknowledgedId !== null && confirmed) {
      queryClient.setQueryData<Recovery>(["expenseRefundRecovery", scope, expenseId], (current) => ({ ...(current ?? EMPTY), acknowledgedId: null }));
    }
  }, [confirmed, recovery.acknowledgedId, queryClient, scope, expenseId]);

  async function send(request: Request) {
    const current = queryClient.getQueryData<Recovery>(recoveryKey) ?? EMPTY;
    if (submitting.current || current.inFlight) return;
    submitting.current = true;
    setError(null);
    queryClient.setQueryData<Recovery>(recoveryKey, { ...current, request, inFlight: true, notice: false });
    try {
      const saved = request.kind === "refund" ? await refund.mutateAsync(request.input) : await undo.mutateAsync(request.input);
      queryClient.setQueryData<Recovery>(recoveryKey, { request: null, inFlight: false, acknowledgedId: saved.id, notice: true });
      setAmountText("");
      setReason("");
      setConfirmId(null);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : undefined;
      const definitive = message !== undefined && ["EXPENSE_REFUND_EXCEEDS_BALANCE", "EXPENSE_REFUND_ALREADY_REVERSED", "EXPENSE_REFUND_KEY_REUSED", "EXPENSE_REFUND_NOT_FOUND", "EXPENSE_NOT_FOUND"].includes(message);
      queryClient.setQueryData<Recovery>(recoveryKey, { ...current, request: definitive ? null : request, inFlight: false });
      setError(tError(message));
    } finally {
      submitting.current = false;
      // Refresh reports as well as history even after a lost response: the write may have committed.
      void queryClient.invalidateQueries();
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (blocked) return;
    if (recovery.request !== null) { void send(recovery.request); return; }
    const amount = parseGroupedAmount(amountText);
    const occurredAt = parseDateTimeText(dateText);
    if (amount === null || amount <= 0 || amount > (history.data?.refundableAmount ?? 0)) { setError(t("EXPENSE_REFUND_EXCEEDS_BALANCE")); return; }
    if (occurredAt === null) { setError(t("expenseDateInvalid")); return; }
    void send({ kind: "refund", input: { expenseId, amount, occurredAt, reason: reason.trim() || undefined, idempotencyKey: crypto.randomUUID() } });
  }

  return <div className="grid gap-3" data-testid="expense-refund-editor">
    <p className="text-sm text-muted-foreground">{t("expenseRefundHelp")}</p>
    {history.isPending && <p role="status">{t("expensesLoading")}</p>}
    {(history.isError || !confirmed) && <div role="alert"><p>{t("expenseRefundReadError")}</p><Button type="button" onClick={() => void history.refetch()} data-testid="expense-refund-reload">{t("expenseCorrectionRetry")}</Button></div>}
    {recovery.notice && <p role="status" data-testid="expense-refund-saved">{t("expenseRefundSaved")}</p>}
    {history.data !== undefined && <>
      <p data-testid="expense-refund-balance">{t("expenseRefundBalance")} <Amount value={history.data.refundableAmount} /></p>
      <ol className="grid gap-3">
        {history.data.refunds.map((row) => <li key={row.id} id={`expense-refund-${row.id}`} className="grid gap-2 rounded border p-3" data-testid="expense-refund-entry">
          <h4 className="font-medium">{t(row.reversesRefundId === null ? "expenseRefundEntry" : "expenseRefundCompensation")} <Amount value={Math.abs(row.difference)} sign={row.difference < 0 ? "−" : "+"} /></h4>
          <bdi dir="ltr" className="break-all text-xs">{row.id}</bdi>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt>{t("expenseRefundDate")}</dt><dd>{formatDateTime(row.occurredAt)}</dd></div>
            <div><dt>{t("expenseCorrectionRecordedAt")}</dt><dd>{formatDateTime(row.recordedAt)}</dd></div>
            <div><dt>{t("expenseCorrectionActor")}</dt><dd>{row.actorName ?? t("expenseActorUnknown")} <bdi dir="ltr" className="break-all text-xs">{row.actorId}</bdi></dd></div>
            <div><dt>{t("expenseRefundReason")}</dt><dd>{row.reason ?? t("expenseCorrectionNoReason")}</dd></div>
          </dl>
          {row.reversesRefundId !== null && <a className="break-all text-xs underline" href={`#expense-refund-${row.reversesRefundId}`}>{t("expenseRefundReverses")} <bdi dir="ltr">{row.reversesRefundId}</bdi></a>}
          {row.reversedByRefundId !== null ? <a className="break-all text-xs underline" href={`#expense-refund-${row.reversedByRefundId}`}>{t("expenseRefundReversedBy")} <bdi dir="ltr">{row.reversedByRefundId}</bdi></a> : <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => setConfirmId(row.id)} data-testid="expense-refund-undo">{t("expenseRefundUndo")}</Button>}
        </li>)}
      </ol>
    </>}
    {confirmId !== null && <div role="group" className="grid gap-2 rounded border p-3" data-testid="expense-refund-confirm">
      <p>{t("expenseRefundUndoHelp")}</p>
      <div className="flex gap-2"><Button type="button" disabled={locked} onClick={() => void send({ kind: "undo", input: { refundId: confirmId, idempotencyKey: crypto.randomUUID() } })} data-testid="expense-refund-confirm-save">{t("expenseRefundUndo")}</Button><Button type="button" variant="outline" disabled={recovery.inFlight} onClick={() => setConfirmId(null)} data-testid="expense-refund-confirm-cancel">{t("expenseCorrectionCancel")}</Button></div>
    </div>}
    <form onSubmit={submit} className="grid gap-3 rounded border bg-card p-3" data-testid="expense-refund-form">
      <label className="grid gap-1" htmlFor={`refund-amount-${expenseId}`}>{t("expenseRefundAmount")}<input id={`refund-amount-${expenseId}`} className={inputClass} inputMode="numeric" value={amountText} disabled={locked} onChange={(event) => setAmountText(event.target.value)} data-testid="expense-refund-amount" /></label>
      <label className="grid gap-1" htmlFor={`refund-date-${expenseId}`}>{t("expenseRefundDate")}<input id={`refund-date-${expenseId}`} className={inputClass} placeholder="DD/MM/YYYY HH:mm" value={dateText} disabled={locked} onChange={(event) => setDateText(event.target.value)} data-testid="expense-refund-date" /></label>
      <label className="grid gap-1" htmlFor={`refund-reason-${expenseId}`}>{t("expenseRefundReason")}<textarea id={`refund-reason-${expenseId}`} className={inputClass} value={reason} maxLength={500} disabled={locked} onChange={(event) => setReason(event.target.value)} data-testid="expense-refund-reason" /></label>
      {error !== null && <p role="alert" data-testid="expense-refund-error">{error}</p>}
      {recovery.request !== null && <p role="status" data-testid="expense-refund-uncertain">{t("expenseRefundUncertain")}</p>}
      <div className="flex flex-wrap gap-2"><Button type="submit" disabled={blocked} data-testid="expense-refund-save">{t(recovery.inFlight ? "expenseCorrectionSaving" : recovery.request !== null ? "expenseCorrectionRetry" : "expenseRefundSave")}</Button><Button type="button" variant="outline" disabled={recovery.inFlight} onClick={onCancel} data-testid="expense-refund-cancel">{t("expenseCorrectionCancel")}</Button></div>
    </form>
  </div>;
}
