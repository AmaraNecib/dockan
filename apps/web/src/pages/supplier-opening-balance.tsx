import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
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

/** The server's resolved destination for a typed name (issue 184). Never
 * computed here: the client renders exactly what `suppliersResolveName` returns. */
type ResolvedSupplier = { id: string; name: string; accountEntryCount: number };

/** The direction Selects render only these two values, so any string they hand
 * back is narrowed here instead of asserting it. */
const asDirection = (value: string | null): SupplierAdjustmentDirection => (value === "THEY_OWE" ? "THEY_OWE" : "WE_OWE");

/** #183 — the reads this screen owns. A write changes supplier identities and
 * accounts, so all three are refreshed; `suppliersList` is kept because other
 * screens still read the full list. */
const SUPPLIER_READ_QUERY_KEYS = [orpc.suppliersListNames.queryKey(), orpc.suppliersAccountSummaries.queryKey(), orpc.suppliersList.queryKey()];

/** A dismissal hung off a navigation gesture must fire only when the gesture
 * actually navigates THIS tab. A modified mouse activation (Ctrl/Cmd/Shift/Alt), a
 * non-primary button, or a link whose target is not this tab (e.g. `_blank`) sends
 * the destination somewhere other than the tab the owner is looking at, so
 * abandoning would close the confirmation in the tab they stayed in and stop a
 * pending refusal recovery from restoring it (Greptile round 4; the target term
 * comes from the debate critic). The back link is the only dismissal route that
 * hangs off a navigation gesture today; keeping the rule in one predicate means a
 * future one calls it instead of growing a second, drift-prone check. */
function navigatesCurrentTab(event: ReactMouseEvent): boolean {
  const target = event.currentTarget.getAttribute("target");
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    (target === null || target === "" || target.toLowerCase() === "_self")
  );
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
  // #183 — two lean reads replace the full party list. `suppliersListNames` is
  // the names-only seam the conflict check folds against; the account summary
  // carries only the balance + entry count the table renders.
  const namesQuery = useQuery(orpc.suppliersListNames.queryOptions());
  const accountsQuery = useQuery(orpc.suppliersAccountSummaries.queryOptions());

  const [dateDraft, setDateDraft] = useState(() => nowDateTimeText().slice(0, 10));
  const [reasonDraft, setReasonDraft] = useState(() => t("supplierAdjustPresetOpening"));
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [newName, setNewName] = useState("");
  const [newDirection, setNewDirection] = useState<SupplierAdjustmentDirection>("WE_OWE");
  const [newAmount, setNewAmount] = useState("");
  const [confirming, setConfirming] = useState(false);
  // the destination the server named, tagged with the exact lookup key it answered
  // for; the dialog renders it verbatim and an edit invalidates it (issue 184)
  const [typedResolution, setTypedResolution] = useState<{ key: string; supplier: ResolvedSupplier | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ created: number; accounts: Array<{ supplierId: string; name: string; balance: number }> } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** true while a submit is asking the server for the destination, so a rapid
   * double-click cannot run two resolutions (issue 184). The ref guards the
   * same-task double-fire that React has not yet re-rendered. */
  const [resolving, setResolving] = useState(false);
  const resolvingRef = useRef(false);
  /** Monotonic attempt id: leaving the page or editing the typed row's lookup
   * fields invalidates an in-flight submit so a late resolve cannot write. */
  const attemptRef = useRef(0);
  /** Monotonic generation of an EXPLICIT dismissal (Escape, either Cancel,
   * leaving the page, a lookup-field edit). `attemptRef` cannot serve this: an
   * existing-row edit bumps it but the dialog must still refresh after a
   * refusal, so the recovery path has to tell a changed batch apart from a
   * dismissed dialog. Bumped only by `abandonAttempt`, so every dismissal route
   * is honoured uniformly (review round 3 finding 1). */
  const dismissalRef = useRef(0);
  const mountedRef = useRef(true);
  const bulk = useMutation(orpc.suppliersOpeningBalances.mutationOptions());

  // merge by id into the rows the table renders; a supplier with no account
  // entry is absent from the summary and defaults to 0/0, exactly as the list
  // seam's supplier-only nulls used to
  const suppliers = useMemo(() => {
    const accountsById = new Map((accountsQuery.data?.items ?? []).map((account) => [account.id, account]));
    return (namesQuery.data?.items ?? []).map((supplier) => {
      const account = accountsById.get(supplier.id);
      return { id: supplier.id, name: supplier.name, accountBalance: account?.accountBalance ?? 0, accountEntryCount: account?.accountEntryCount ?? 0 };
    });
  }, [namesQuery.data, accountsQuery.data]);
  const listPending = namesQuery.isPending || accountsQuery.isPending;
  const listError = namesQuery.isError ? namesQuery.error : accountsQuery.isError ? accountsQuery.error : null;
  // #183 — a failed read must block the save. If only the account summary fails,
  // the merge would still yield rows with accountEntryCount 0, silently skipping
  // the confirmation gate the full list used to power; the base page blocked
  // because its empty list made the batch look empty. Refuse explicitly.
  const listFailed = listError !== null;
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
  // a typed name is a NAME: the server is the only resolver. A "duplicate" draft
  // is not an error by itself; the pre-submit guard blocks it only when it
  // collides with a row the owner already picked.
  const newRowError =
    newRow.status === "incomplete"
      ? t("supplierOpeningNewIncomplete")
      : newRow.status === "invalid"
        ? t("supplierOpeningRowInvalid")
        : null;

  // Round 5 — the typed name is its own outgoing row, sent as newSupplierName and
  // never moved onto another supplier's row. One resolver: the server.
  const typedNameKey = newName.trim() === "" ? null : normalizeTextKey(newName);
  const typedAmount = parseGroupedAmount(newAmount);
  const typedRowReady = typedNameKey !== null && typedAmount !== null && typedAmount > 0;
  // #184 — the resolution input and the key that tags its answer, derived once so
  // they cannot disagree. The key is the row signature the server resolves
  // against, so a change to any of the five fields invalidates the snapshot.
  const typedLookup = useMemo(() => {
    if (typedNameKey === null || typedAmount === null || typedAmount <= 0 || occurredAt === null) return null;
    const input = { name: newName.trim(), direction: newDirection, amount: typedAmount, occurredAt, reason: reasonDraft.trim() === "" ? undefined : reasonDraft.trim() };
    return { input, key: JSON.stringify([input.name, input.direction, input.amount, input.occurredAt, input.reason ?? null]) };
  }, [typedNameKey, typedAmount, newDirection, newName, occurredAt, reasonDraft]);
  const resolveInput = typedLookup?.input ?? null;
  const resolveKey = typedLookup?.key ?? null;
  // the destination snapshot is only used while it belongs to the CURRENT lookup
  // fields, so a stale snapshot can never block a valid edited batch
  const typedDestination = typedResolution !== null && typedResolution.key === resolveKey ? typedResolution.supplier : null;
  // the confirmation is stale the moment the typed row's lookup fields move (or a
  // typed row appears while an existing-rows-only confirmation is open), so the
  // dialog cannot act on an old snapshot for even one commit (review round 1 F3)
  const confirmStale = typedResolution === null ? resolveKey !== null : typedResolution.key !== resolveKey;
  // guard: a typed name that folds onto a row the owner already picked must not be
  // sent (the same account twice). Folded names are a local, tie-break-free
  // check; the resolved id comes from the server. One function so the render-time
  // banner and the submit-time guard cannot drift apart.
  const foldedConflict = typedRowReady && filledExisting.some((row) => normalizeTextKey(row.supplier.name) === typedNameKey);
  const conflictsWithFilled = (destination: ResolvedSupplier | null) =>
    typedRowReady && (foldedConflict || (destination !== null && filledExisting.some((row) => row.supplier.id === destination.id)));
  const typedNameConflict = conflictsWithFilled(typedDestination);

  // a change to the typed row's lookup fields means the confirmation named an
  // account for a now-outdated row: close it, drop the snapshot, and invalidate
  // any in-flight submit for the old fields
  const lastResolveKeyRef = useRef(resolveKey);
  // the live lookup key, for a late continuation to compare against the key it was
  // started for. A layout effect keeps it current at commit, before any async
  // continuation can read it — a passive effect would lag a render behind.
  const resolveKeyRef = useRef(resolveKey);
  useLayoutEffect(() => {
    resolveKeyRef.current = resolveKey;
  }, [resolveKey]);
  useEffect(() => {
    if (lastResolveKeyRef.current === resolveKey) return;
    lastResolveKeyRef.current = resolveKey;
    abandonAttempt();
  }, [resolveKey]);

  // leaving the page (by any route) invalidates every in-flight attempt, so a late
  // resolve can never reach save() after the owner left. `useLayoutEffect` runs
  // the cleanup synchronously in the unmount commit rather than in a deferred
  // passive flush, so the exit the page does not own (the app-shell sidebar, a
  // programmatic nav — no click handler to invalidate on) narrows to the commit
  // itself. The back link invalidates in its `onClick` as an immediate guard, but
  // only for activations that navigate THIS tab: a Ctrl/Cmd/middle-click opens a
  // new tab and leaves the owner here (Greptile round 4).
  // Re-arming on mount keeps a StrictMode double-invoke from leaving it false.
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidateAttempt();
    };
  }, []);

  const totalRows = filledExisting.length + (typedRowReady && !typedNameConflict ? 1 : 0);
  const overLimit = isOpeningBatchOverLimit(totalRows);
  // the save is blocked, and the reason shown, BEFORE the owner fills more rows.
  // `typedNameConflict` includes the server-resolved id, so editing a row onto the
  // account the dialog named re-blocks the dialog too (issue 177 round 5 / #184).
  const blockedReason = overLimit
    ? t("supplierOpeningTooManyRows", { max: MAX_OPENING_BALANCE_ROWS })
    : invalidExisting.length > 0
      ? t("supplierOpeningFixRows")
      : typedNameConflict
        ? t("supplierOpeningRowHasAmount")
        : newRowError;
  // the confirmation dialog names every account the batch will write to, including
  // the server's resolved name for the typed row, so a confirmed save never lands
  // on an unnamed account
  const confirmNames = [
    ...filledExisting.filter((row) => (row.supplier.accountEntryCount ?? 0) > 0).map((row) => row.supplier.name),
    ...(typedRowReady && !typedNameConflict ? [typedDestination?.name ?? newName.trim()] : []),
  ].filter((name, index, all) => all.findIndex((other) => normalizeTextKey(other) === normalizeTextKey(name)) === index);
  // forward confirmExisting only for the rows the dialog actually named (their
  // cached count shows history); a stale count is resolved by the refusal round-trip
  const forwardsConfirm = (confirm: boolean, accountEntryCount: number | null | undefined) => (confirm && (accountEntryCount ?? 0) > 0 ? true : undefined);

  /** Close the dialog AND drop its destination snapshot, so a later edit cannot
   * be judged against the account a previous dialog named (issue 184). */
  function closeConfirm() {
    setConfirming(false);
    setTypedResolution(null);
  }

  /** Abandon any in-flight submit AND dismiss the confirmation. One primitive so
   * the generation bump and the dialog dismissal cannot drift apart: the dialog's
   * OWN Cancel (review round 2 finding 1), the page Cancel, and a lookup-field
   * edit all need both. Cancel stays enabled — a hung lookup must not trap the
   * owner. The success path uses the bare `closeConfirm()` because the write is
   * done and there is nothing left to abandon. */
  function abandonAttempt() {
    dismissalRef.current += 1;
    invalidateAttempt();
    closeConfirm();
  }

  /** Remember the server's answer under the exact lookup key it answered for. */
  function rememberResolution(supplier: ResolvedSupplier | null) {
    setTypedResolution(resolveKey === null ? null : { key: resolveKey, supplier });
  }

  /** Leave the screen: abandon any in-flight attempt and drop the confirmation
   * before navigating, so a late resolve cannot write (review round 1 finding 1).
   * Cancel is never blocked — a hung lookup must not trap the owner. */
  function leave() {
    abandonAttempt();
    void navigate({ to: "/suppliers" });
  }

  /** Ask the server which account this typed name resolves to (issue 184). The
   * only resolver; a `null` answer means a write would create a new supplier. */
  async function resolveTypedDestination(): Promise<ResolvedSupplier | null> {
    if (resolveInput === null) return null;
    const result = await queryClient.fetchQuery(orpc.suppliersResolveName.queryOptions({ input: resolveInput }));
    return result.supplier;
  }

  /** Any edit to the outgoing batch invalidates an in-flight submit: the lookup
   * was for the previous batch, so a late answer must not write it. Synchronous,
   * so it beats a already-queued resolve continuation (review round 1 F1/F2). */
  function invalidateAttempt() {
    attemptRef.current += 1;
  }

  function setRow(supplierId: string, patch: Partial<RowDraft>) {
    invalidateAttempt();
    setDrafts((current) => {
      const existing = current[supplierId] ?? { direction: "WE_OWE", amount: "" };
      return { ...current, [supplierId]: { ...existing, ...patch } };
    });
  }

  async function save(confirmExisting: boolean, destination: ResolvedSupplier | null) {
    if (occurredAt === null) return;
    // a failed read must block the dialog path too: the counts the dialog was
    // derived from may no longer be the ones on screen (see `listFailed`)
    if (listFailed) {
      setError(tError(listError?.message));
      return;
    }
    // surface the reason on the dialog path too, instead of silently no-op'ing
    if (blockedReason !== null) {
      setError(blockedReason);
      return;
    }
    // a dialog can outlive the rows it named (the owner clears them): never post
    // an empty batch from the confirm button
    if (totalRows === 0) {
      setError(t("supplierOpeningNothing"));
      return;
    }
    // the lookup key this write was started for: a refusal only re-aligns the
    // dialog when the typed fields still match it. A row edit during the write
    // must NOT skip the refresh (that would leave the dialog naming a stale
    // account and loop on refusals), but a typed-field edit must (the effect has
    // already closed the dialog for fields this write no longer represents).
    const saveResolveKey = resolveKey;
    // an explicit dismissal after this write starts must survive the refusal
    // recovery below; `abandonAttempt` is the one primitive that records it
    const saveDismissal = dismissalRef.current;
    setError(null);
    setSubmitting(true);
    try {
      const result = await bulk.mutateAsync({
        occurredAt,
        reason: reasonDraft.trim() === "" ? undefined : reasonDraft.trim(),
        rows: [
          ...filledExisting.map((row) => ({
            supplierId: row.supplier.id,
            direction: row.direction,
            amount: row.state.amount,
            confirmExisting: forwardsConfirm(confirmExisting, row.supplier.accountEntryCount),
          })),
          // a typed name travels as a NAME; the server is the only resolver. Only a
          // destination the server named (and the dialog showed) forwards
          // confirmExisting, and the named id travels as a consistency check so a
          // draft edited while the dialog was open cannot land elsewhere (issue 184).
          ...(typedRowReady
            ? [
                {
                  newSupplierName: newName.trim(),
                  direction: newDirection,
                  amount: typedAmount ?? 0,
                  confirmExisting: forwardsConfirm(confirmExisting, destination?.accountEntryCount),
                  expectedSupplierId: destination?.id ?? null,
                },
              ]
            : []),
        ],
      });
      await Promise.all([
        ...SUPPLIER_READ_QUERY_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
        queryClient.invalidateQueries({ queryKey: orpc.reportsDebts.queryKey() }),
        queryClient.invalidateQueries({ queryKey: DEBTS_BY_PARTY_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: orpc.dashboardSummary.queryKey() }),
        queryClient.invalidateQueries({ queryKey: ACTIVITIES_LIST_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: INVOICES_LIST_QUERY_KEY }),
      ]);
      setSaved({ created: result.created, accounts: result.accounts });
      if (mountedRef.current) closeConfirm();
    } catch (err) {
      // surface the refusal first; a failed re-resolve below is the more
      // actionable error and must not be overwritten
      setError(tError(err instanceof Error ? err.message : undefined));
      // a refusal means the server resolved the typed name to an account the
      // dialog had not named (or a stale count). Refresh the counts AND re-ask the
      // server for the destination, then re-open the dialog so what it names is
      // what the confirmed write will touch. Do this on the CONFIRMED path too.
      if (err instanceof Error && (err.message.includes("OPENING_BALANCE_EXISTS") || err.message.includes("OPENING_BALANCE_TARGET_CHANGED"))) {
        await Promise.all(SUPPLIER_READ_QUERY_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
        try {
          const destination = await resolveTypedDestination();
          if (!mountedRef.current || resolveKeyRef.current !== saveResolveKey || dismissalRef.current !== saveDismissal) return;
          rememberResolution(destination);
          setConfirming(true);
        } catch (resolveError) {
          // a dismissal must survive a FAILED recovery too: otherwise the error the
          // owner just dismissed is silently replaced (review round 3, class fix)
          if (mountedRef.current && resolveKeyRef.current === saveResolveKey && dismissalRef.current === saveDismissal) setError(tError(resolveError instanceof Error ? resolveError.message : undefined));
        }
      }
    } finally {
      // NOTE: do NOT reset `confirming` here — the catch may have just set it to
      // surface the dialog after a stale-expectation refusal. It is cleared on
      // success above and by the dialog's own cancel button.
      if (mountedRef.current) setSubmitting(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || resolvingRef.current || bulk.isPending || dateInvalid || listFailed) return;
    if (blockedReason !== null) {
      setError(blockedReason);
      return;
    }
    if (totalRows === 0) {
      setError(t("supplierOpeningNothing"));
      return;
    }
    // every submit owns an attempt id: leaving the page or editing the lookup
    // fields invalidates it, so a late resolve can never reach save()
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    // the server's resolution is the only source of the typed row's destination
    // (issue 184): ask it before deciding what the dialog must name. A batch with
    // no typed name stays synchronous — there is nothing to resolve.
    const destination = resolveInput === null ? null : await resolveForSubmit(attempt);
    if (attempt !== attemptRef.current) return; // left or the lookup fields changed
    if (destination === undefined) return; // resolve failed; the error is already shown
    const conflict = conflictsWithFilled(destination);
    if (conflict) {
      setError(t("supplierOpeningRowHasAmount"));
      return;
    }
    const existingNeedsConfirm = filledExisting.some((row) => (row.supplier.accountEntryCount ?? 0) > 0);
    if (existingNeedsConfirm || (destination?.accountEntryCount ?? 0) > 0) {
      rememberResolution(destination);
      setConfirming(true);
      return;
    }
    await save(false, destination);
  }

  /** `submit`'s resolve with the UI guards a bare read needs: a pending flag so
   * a double-click cannot run two, and an error surface instead of an unhandled
   * rejection. `undefined` means it failed and the error is shown. */
  async function resolveForSubmit(attempt: number): Promise<ResolvedSupplier | null | undefined> {
    resolvingRef.current = true;
    setResolving(true);
    try {
      return await resolveTypedDestination();
    } catch (err) {
      if (attempt === attemptRef.current && mountedRef.current) setError(tError(err instanceof Error ? err.message : undefined));
      return undefined;
    } finally {
      resolvingRef.current = false;
      if (mountedRef.current) setResolving(false);
    }
  }

  return (
    <section data-testid="opening-balance-page">
      <Link
        to="/suppliers"
        onClick={(event) => {
          // a new-tab activation never leaves this tab, so the confirmation (and a
          // pending refusal recovery) must survive it (Greptile round 4)
          if (navigatesCurrentTab(event)) abandonAttempt();
        }}
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        data-testid="opening-balance-back"
      >
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
        <form
          className="mt-4 grid gap-4"
          onSubmit={submit}
          // Escape is the keyboard equivalent of the dialog's Cancel — the same
          // `abandonAttempt` so it invalidates any in-flight submit too. It lives
          // on the FORM, not the dialog, because the dialog is inline and does not
          // trap focus: an Escape pressed in an input behind it must still dismiss
          // (Web Interface Guidelines: interactive elements need keyboard
          // handlers). Guarded on `confirming` so Escape elsewhere in the form
          // does not abandon an unrelated attempt.
          onKeyDown={(event) => {
            if (event.key === "Escape" && confirming) abandonAttempt();
          }}
          data-testid="opening-balance-form"
        >
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm">
              {t("supplierOpeningDate")}
              <input
                className="h-9 w-32 rounded-lg border border-input bg-background px-3 text-sm"
                inputMode="numeric"
                autoComplete="off"
                value={dateDraft}
                onChange={(event) => {
                  invalidateAttempt();
                  setDateDraft(event.target.value);
                }}
                aria-invalid={dateInvalid}
                data-testid="opening-balance-date"
              />
            </label>
            <label className="grid flex-1 gap-1 text-sm">
              {t("supplierOpeningReason")}
              <input
                className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
                value={reasonDraft}
                onChange={(event) => {
                  invalidateAttempt();
                  setReasonDraft(event.target.value);
                }}
                data-testid="opening-balance-reason"
              />
            </label>
          </div>

          {listPending ? (
            <div className="grid gap-2" data-testid="opening-balance-loading">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : listError !== null ? (
            <p className="rounded border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive" role="alert" data-testid="opening-balance-error">
              {tError(listError.message)}
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
                      onChange={(event) => {
                        invalidateAttempt();
                        setNewName(event.target.value);
                      }}
                      maxLength={200}
                      placeholder={t("supplierOpeningNewRow")}
                      aria-label={t("supplierOpeningNewRow")}
                      aria-invalid={newRow.status === "invalid"}
                      data-testid="opening-balance-new-name"
                    />
                    {newRowError !== null && (
                      <p className="mt-1 text-xs text-destructive" role="alert" data-testid="opening-balance-new-error">
                        {newRowError}
                      </p>
                    )}
                  </td>
                  <td className="p-2 text-muted-foreground">—</td>
                  <td className="p-2">
                    <Select
                      value={newDirection}
                      onValueChange={(next) => {
                        invalidateAttempt();
                        setNewDirection(asDirection(next));
                      }}
                    >
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
                      onChange={(event) => {
                        invalidateAttempt();
                        setNewAmount(event.target.value);
                      }}
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
            <Button type="submit" disabled={submitting || resolving || bulk.isPending || dateInvalid || listFailed || blockedReason !== null} data-testid="opening-balance-save">
              {t("supplierOpeningSave", { count: totalRows })}
            </Button>
            <Button type="button" variant="outline" onClick={leave} disabled={submitting || bulk.isPending} data-testid="opening-balance-cancel">
              {t("partyCancel")}
            </Button>
          </div>

          {confirming && !confirmStale && (
            <div
              className="rounded border border-warning/40 bg-warning/10 p-4"
              role="alertdialog"
              aria-label={t("supplierOpeningConfirmTitle")}
              data-testid="opening-balance-confirm"
            >
              <p className="font-semibold">{t("supplierOpeningConfirmTitle")}</p>
              <p className="mt-1 text-sm">{t("supplierOpeningConfirmBody")}</p>
              <ul className="mt-2 grid gap-1 text-sm">
                {confirmNames.map((name, index) => (
                  <li key={`${index}-${name}`} data-testid="opening-balance-confirm-name">{name}</li>
                ))}
              </ul>
              <div className="mt-3 flex gap-2">
                <Button type="button" onClick={() => void save(true, typedDestination)} disabled={submitting || resolving || bulk.isPending || listFailed || blockedReason !== null} data-testid="opening-balance-confirm-save">
                  {t("supplierOpeningConfirmSave")}
                </Button>
                <Button type="button" variant="outline" onClick={abandonAttempt} disabled={submitting || bulk.isPending} data-testid="opening-balance-confirm-cancel">
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
