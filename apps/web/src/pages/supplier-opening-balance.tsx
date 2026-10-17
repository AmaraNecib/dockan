import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

import { normalizeTextKey, type SupplierAdjustmentDirection } from "@dokan/contracts";

import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

import { nowDateTimeText, parseDateTimeText } from "@/lib/dates";
import { tError } from "@/lib/i18n";
import { focusByTestId } from "@/lib/focus";
import { supplierBalanceDirectionKey, supplierDirectionKey } from "@/lib/supplier-entry-display";
import { DEBTS_BY_PARTY_QUERY_KEY, INVOICES_LIST_QUERY_KEY, ACTIVITIES_LIST_QUERY_KEY } from "@/lib/query-keys";
import { orpc } from "@/lib/rpc";
import { supplierBalanceDirectionKey } from "@/lib/supplier-entry-display";
import {
  MAX_OPENING_BALANCE_ROWS,
  droppedFilledDrafts,
  duplicateTypedRowIds,
  isOpeningBatchOverLimit,
  newOpeningRowStatus,
  openingRowStatus,
  type NewOpeningRowStatus,
  type RemovedFilledDraft,
} from "@/lib/supplier-opening-draft";

type RowDraft = { direction: SupplierAdjustmentDirection; amount: string; name?: string };

/** #255 — one typed (new-supplier) draft row. Keyed by a CLIENT row id, never a
 * supplier id: two drafts naming alike are two rows, and adding a row can never
 * collapse onto — or overwrite — another row's text. */
type TypedRow = { id: string; name: string; direction: SupplierAdjustmentDirection; amount: string };

/** A blank typed row. The page opens with one, so the single-row flow the owner
 * already knows keeps working, and every added row is the same shape. */
const blankTypedRow = (id: string): TypedRow => ({ id, name: "", direction: "WE_OWE", amount: "" });

/** The server's resolved destination for a typed name (issue 184). Never
 * computed here: the client renders exactly what `suppliersResolveName` returns. */
type ResolvedSupplier = { id: string; name: string; accountEntryCount: number };

/** The direction Selects render only these two values, so any string they hand
 * back is narrowed here instead of asserting it. */
const asDirection = (value: string | null): SupplierAdjustmentDirection => (value === "THEY_OWE" ? "THEY_OWE" : "WE_OWE");

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
  // #204 — filled drafts whose supplier a background refresh removed. Kept apart
  // from `drafts`: the draft is gone, but the loss must stay visible (and block
  // the save) until the owner acknowledges it.
  const [removedFilled, setRemovedFilled] = useState<RemovedFilledDraft[]>([]);
  // #255 — the typed drafts. A list, not three scalars: the page accepts a 200-row
  // batch, so dozens of new parties must be typed in one pass instead of one save
  // each.
  const [typedRows, setTypedRows] = useState<TypedRow[]>(() => [blankTypedRow("typed-1")]);
  /** Monotonic row ids, so a removed row's id is never reused (a stale ref or a
   * late resolve can no longer address the row that took its place). */
  const nextTypedRowId = useRef(2);
  /** The row an add just appended, focused once it has mounted: the whole point
   * of #255 is typing many parties without leaving the keyboard. The testid is
   * resolved AFTER the commit, because only then does the row exist. */
  const pendingTypedFocusTestId = useRef<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // the destinations the server named, tagged with the exact batch key they
  // answered for; the dialog renders them verbatim and an edit invalidates the
  // whole set (issue 184, generalised to N rows by #255)
  const [typedResolution, setTypedResolution] = useState<{ key: string; destinations: Record<string, ResolvedSupplier | null> } | null>(null);
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
  // #183 — the reads this screen owns. A write changes supplier identities and
  // accounts, so all three are refreshed; `suppliersList` is kept because other
  // screens still read the full list. Computed in the component (not at module
  // load) so importing the page never depends on the full rpc surface existing.
  const supplierReadQueryKeys = [orpc.suppliersListNames.queryKey(), orpc.suppliersAccountSummaries.queryKey(), orpc.suppliersList.queryKey()];

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
  // #204 — the refresh seam. `presentSupplierIds` only changes when the fresh
  // supplier list changes, so reconciliation runs on a refresh (never per
  // keystroke) and a filled draft whose supplier vanished is handed to the
  // notice instead of disappearing with the row. `null` guards the not-yet-loaded
  // (and cache-reset) case: an undefined list must never look like "every supplier
  // vanished" and flag every draft.
  const presentSupplierIds = useMemo(
    () => (namesQuery.data === undefined ? null : suppliers.map((supplier) => supplier.id)),
    [namesQuery.data, suppliers],
  );
  /** The latest drafts, so the reconciliation effect can read them without taking
   * `drafts` as a dependency (which would run it on every keystroke). */
  const draftsRef = useRef(drafts);
  useLayoutEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);
  /** The same removal, live at write time. `save`/`submit` can resume after the
   * render that started them (the stale-closure class Greptile round 3 fixed for
   * the read failure), so a captured `hasRemovedFilled` can be false while a
   * removal landed during the in-flight resolve. */
  const removedFilledRef = useRef(removedFilled);
  useLayoutEffect(() => {
    removedFilledRef.current = removedFilled;
  }, [removedFilled]);
  useEffect(() => {
    if (presentSupplierIds === null) return;
    const dropped = droppedFilledDrafts({ drafts: draftsRef.current, presentSupplierIds });
    if (dropped.length === 0) return;
    // the outgoing batch changed: abandon any in-flight submit (a late resolve
    // must not write the removed row) and close the confirmation that named the
    // now-shrunk batch, exactly as a typed-field edit would
    abandonAttempt();
    setRemovedFilled((current) => {
      const known = new Set(current.map((row) => row.supplierId));
      const added = dropped.filter((row) => !known.has(row.supplierId));
      return added.length === 0 ? current : [...current, ...added];
    });
    setDrafts((current) => {
      const next = { ...current };
      for (const row of dropped) delete next[row.supplierId];
      return next;
    });
  }, [presentSupplierIds]);
  const listPending = namesQuery.isPending || accountsQuery.isPending;
  const listError = namesQuery.isError ? namesQuery.error : accountsQuery.isError ? accountsQuery.error : null;
  // #183 — a failed read must block the save. If only the account summary fails,
  // the merge would still yield rows with accountEntryCount 0, silently skipping
  // the confirmation gate the full list used to power; the base page blocked
  // because its empty list made the batch look empty. Refuse explicitly.
  const listFailed = listError !== null;
  /** The SAME read failure, but read live from the query cache at the moment a
   * continuation consults it. `save`/`submit` can resume after the render that
   * started them, so a captured `listFailed` can be false while a read has since
   * failed and the page already shows the failure banner; the write would land
   * behind that banner (Greptile round 3). The cache flips to `error` the instant
   * a read rejects — before React commits — so this cannot lag the read the way a
   * render value can. `null` means no failure; a `{ message: undefined }` failure
   * (an error status with no error object) still blocks, it just shows the
   * generic message. */
  function liveListFailure(): { message: string | undefined } | null {
    for (const queryKey of [orpc.suppliersListNames.queryKey(), orpc.suppliersAccountSummaries.queryKey()]) {
      const state = queryClient.getQueryState(queryKey);
      if (state?.status === "error") return { message: state.error?.message };
    }
    return null;
  }
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

  // #255 — one status per typed row, from the same reader the lib uses for a
  // single inline supplier. "duplicate" (a name that folds onto an EXISTING
  // supplier) is not an error: the server resolves it onto that account, which is
  // exactly what `newSupplierName` means. Only a blank or unreadable draft keeps a
  // row out of the batch.
  const supplierNames = useMemo(() => suppliers.map((supplier) => supplier.name), [suppliers]);
  const typedRowStates = useMemo(
    () => typedRows.map((row) => ({ row, status: newOpeningRowStatus({ name: row.name, amount: row.amount, existingNames: supplierNames }) })),
    [typedRows, supplierNames],
  );
  const readyTypedRows = useMemo(
    () =>
      typedRowStates.flatMap(({ row, status }) =>
        status.status === "filled" || status.status === "duplicate"
          ? [{ id: row.id, name: status.name, direction: row.direction, amount: status.amount }]
          : [],
      ),
    [typedRowStates],
  );
  // #255 — two typed rows that fold onto one supplier are one account entered
  // twice: the api refuses the WHOLE batch for it (DUPLICATE_OPENING_BALANCE_ROW),
  // so every amount in it would be lost. Block the same shape here first.
  const duplicateTypedIds = useMemo(() => new Set(duplicateTypedRowIds(typedRows)), [typedRows]);
  // recomputed per render like `filledExisting` itself, which is a fresh filter
  // every render: a memo here would only look like one
  const pickedSupplierIds = new Set(filledExisting.map((row) => row.supplier.id));
  const pickedSupplierNames = new Set(filledExisting.map((row) => normalizeTextKey(row.supplier.name)));

  // #184 — the resolution input and the key that tags its answer, derived per row
  // and folded into ONE batch key so a change to any field of any row invalidates
  // the snapshot for all of them. The key is the row signature the server resolves
  // against, plus the row id so two identical rows keep their own answers.
  const typedLookups = useMemo(() => {
    if (readyTypedRows.length === 0 || occurredAt === null) return [];
    const reason = reasonDraft.trim() === "" ? undefined : reasonDraft.trim();
    return readyTypedRows.map((row) => {
      const input = { name: row.name, direction: row.direction, amount: row.amount, occurredAt, reason };
      return { id: row.id, input, key: JSON.stringify([row.id, input.name, input.direction, input.amount, input.occurredAt, input.reason ?? null]) };
    });
  }, [readyTypedRows, occurredAt, reasonDraft]);
  const resolveKey = typedLookups.length === 0 ? null : JSON.stringify(typedLookups.map((lookup) => lookup.key));
  // the destination snapshot is only used while it belongs to the CURRENT batch,
  // so a stale snapshot can never block (or mis-name) a valid edited batch
  const resolvedDestinations = typedResolution !== null && typedResolution.key === resolveKey ? typedResolution.destinations : null;
  const destinationFor = (rowId: string): ResolvedSupplier | null => resolvedDestinations?.[rowId] ?? null;
  // the confirmation is stale the moment the typed rows' lookup fields move (or a
  // typed row appears while an existing-rows-only confirmation is open), so the
  // dialog cannot act on an old snapshot for even one commit (review round 1 F3)
  const confirmStale = typedResolution === null ? resolveKey !== null : typedResolution.key !== resolveKey;
  // guard: a typed row that folds onto — or resolves to — an account another row
  // already carries must not be sent (the same account twice). Folded names are a
  // local, tie-break-free check; the resolved id comes from the server. One
  // predicate so the render-time row error and the submit-time guard cannot drift
  // apart.
  function rowOnPickedSupplier(row: { id: string; name: string }, destination: ResolvedSupplier | null): boolean {
    if (pickedSupplierNames.has(normalizeTextKey(row.name))) return true;
    return destination !== null && pickedSupplierIds.has(destination.id);
  }
  const conflictsWithFilled = (destinations: Record<string, ResolvedSupplier | null> | null) =>
    readyTypedRows.some((row) => rowOnPickedSupplier(row, destinations?.[row.id] ?? null));
  /** The message shown under a typed row, in the order the owner can act on it:
   * finish the row, fix its amount, drop the duplicate, pick another supplier. */
  function typedRowError(row: TypedRow, status: NewOpeningRowStatus): string | null {
    if (status.status === "incomplete") return t("supplierOpeningNewIncomplete");
    if (status.status === "invalid") return t("supplierOpeningRowInvalid");
    if (duplicateTypedIds.has(row.id)) return t("supplierOpeningDuplicateRow");
    if (rowOnPickedSupplier(row, destinationFor(row.id))) return t("supplierOpeningRowHasAmount");
    return null;
  }
  // one entry per draft row: its state, its message, and the row itself. The render
  // reads this array and nothing else, so a row can never show another row's state.
  const typedRowEntries = typedRowStates.map(({ row, status }) => ({ row, status, error: typedRowError(row, status) }));
  /** The outgoing rows the batch will actually carry: a row the owner cannot send
   * (a duplicate, or one naming a supplier another row already carries) is not
   * counted and not named in the dialog. `save` deliberately maps the UNFILTERED
   * `readyTypedRows` instead: there, dropping a row would silently lose its amount,
   * so the write is refused by `blockedReason` and, failing that, by the server.
   */
  const eligibleTypedRows = readyTypedRows.filter((row) => !duplicateTypedIds.has(row.id) && !rowOnPickedSupplier(row, destinationFor(row.id)));

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

  const totalRows = filledExisting.length + eligibleTypedRows.length;
  const overLimit = isOpeningBatchOverLimit(totalRows);
  /** #255 — the add control stops at the contract's row cap in BOTH senses: the
   * batch (filled rows) cannot grow past 200, and neither can the draft list, so
   * pressing add on a page of blank rows cannot append unbounded DOM. One value,
   * read by the control's `disabled` and by the handler, so the two cannot
   * disagree. */
  const addRowBlocked = totalRows >= MAX_OPENING_BALANCE_ROWS || typedRows.length >= MAX_OPENING_BALANCE_ROWS;
  // the save is blocked, and the reason shown, BEFORE the owner fills more rows.
  // A typed row's error includes the server-resolved id, so editing a row onto the
  // account the dialog named re-blocks the dialog too (issue 177 round 5 / #184);
  // with N rows the FIRST row that has something to say is the one named, so the
  // banner and the row's own message always agree.
  const firstTypedRowError = typedRowEntries.find((entry) => entry.error !== null)?.error ?? null;
  const blockedReason = overLimit
    ? t("supplierOpeningTooManyRows", { max: MAX_OPENING_BALANCE_ROWS })
    : invalidExisting.length > 0
      ? t("supplierOpeningFixRows")
      : firstTypedRowError;
  // #204 — an unacknowledged dropped amount blocks the save on its own, so the
  // owner cannot confirm a batch while still believing the removed row is in it.
  const hasRemovedFilled = removedFilled.length > 0;
  // the confirmation dialog names every account the batch will write to, including
  // the server's resolved name for each typed row, so a confirmed save never lands
  // on an unnamed account
  const confirmNames = [
    ...filledExisting.filter((row) => (row.supplier.accountEntryCount ?? 0) > 0).map((row) => row.supplier.name),
    ...eligibleTypedRows.map((row) => destinationFor(row.id)?.name ?? row.name),
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

  /** Remember the server's answers under the exact batch key they answered for. */
  function rememberResolution(destinations: Record<string, ResolvedSupplier | null>) {
    setTypedResolution(resolveKey === null ? null : { key: resolveKey, destinations });
  }

  /** #255 — append a blank typed row and focus its name field, so the owner can
   * type the next party without reaching for the mouse. Refused when
   * `addRowBlocked`: a row added past the contract's cap could only make the batch
   * unsavable. */
  function addTypedRow() {
    if (addRowBlocked) return;
    invalidateAttempt();
    const id = `typed-${nextTypedRowId.current}`;
    nextTypedRowId.current += 1;
    // the appended row's index is the list length at this moment
    pendingTypedFocusTestId.current = `opening-balance-typed-name-${typedRows.length}`;
    setTypedRows((current) => [...current, blankTypedRow(id)]);
  }

  /** Drop one typed row. The rows after it keep their text and their order: they
   * are drafts, not supplier rows, so a removal must never re-index anything. The
   * remove control unmounts with its row, so focus moves to the row that took its
   * place (or to the add control once the list is empty) instead of falling to
   * `document.body`. */
  function removeTypedRow(id: string) {
    invalidateAttempt();
    const index = typedRows.findIndex((row) => row.id === id);
    const remaining = typedRows.filter((row) => row.id !== id);
    // the row that takes the removed row's place. The lower clamp is a ternary,
    // not a max() call, because the issue-184 structural guard reads a maximum
    // comparison in this file as a re-implemented entry-count tie-break and a
    // list clamp is not one (`findIndex` returns -1 only for an id no rendered
    // row owns, so the ternary is the defensive branch).
    const survivor = index < 0 ? 0 : Math.min(index, remaining.length - 1);
    pendingTypedFocusTestId.current = remaining.length === 0 ? "opening-balance-add-row" : `opening-balance-typed-name-${survivor}`;
    setTypedRows(remaining);
  }

  function setTypedRow(id: string, patch: Partial<TypedRow>) {
    invalidateAttempt();
    setTypedRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  // Move focus to whatever the last add/remove named, once the DOM reflects it.
  // The named control can have become UNFOCUSABLE by this commit: at the
  // contract's row cap the add control is disabled, and a blocked batch disables
  // Save too, so a bare `focusByTestId` would leave the keyboard user on
  // `document.body` with no place on the page (Greptile round 5). `focusByTestId`
  // reports whether focus moved, so fall back through the controls the owner
  // still has — Save first, then the two no row state disables.
  useEffect(() => {
    const testId = pendingTypedFocusTestId.current;
    if (testId === null) return;
    pendingTypedFocusTestId.current = null;
    if (focusByTestId(testId)) return;
    for (const fallback of ["opening-balance-save", "opening-balance-cancel", "opening-balance-back"]) {
      if (focusByTestId(fallback)) return;
    }
  }, [typedRows]);

  /** Leave the screen: abandon any in-flight attempt and drop the confirmation
   * before navigating, so a late resolve cannot write (review round 1 finding 1).
   * Cancel is never blocked — a hung lookup must not trap the owner. */
  function leave() {
    abandonAttempt();
    void navigate({ to: "/suppliers" });
  }

  /** Ask the server which account each typed row resolves to (issue 184 / #255).
   * ONE batch read for the whole draft (Greptile round 3 finding 3): a per-row
   * `suppliersResolveName` call rereads every supplier name and recomputes every
   * account summary, so a full 200-row batch repeated that work 200 times. The
   * server reads the two lean lists once and still resolves each row's own
   * signature; the answers come back parallel to the rows. A `null` answer means
   * a write would create a new supplier. An empty draft is not resolved at all. */
  async function resolveTypedDestinations(): Promise<Record<string, ResolvedSupplier | null>> {
    const first = typedLookups[0];
    if (first === undefined) return {};
    const result = await queryClient.fetchQuery(
      orpc.suppliersResolveNames.queryOptions({
        input: {
          occurredAt: first.input.occurredAt,
          reason: first.input.reason,
          rows: typedLookups.map((lookup) => ({ name: lookup.input.name, direction: lookup.input.direction, amount: lookup.input.amount })),
        },
      }),
    );
    return Object.fromEntries(typedLookups.map((lookup, index) => [lookup.id, result.suppliers[index] ?? null]));
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
      // remember the supplier this draft is typed against, so a refresh that
      // removes it can still name the lost row (issue 204)
      const name = suppliers.find((supplier) => supplier.id === supplierId)?.name ?? existing.name;
      return { ...current, [supplierId]: { ...existing, ...patch, name } };
    });
  }

  /** Acknowledge the removed rows: the loss has been shown and read, so the save
   * unblocks and only the surviving rows remain (issue 204). */
  function dismissRemoved() {
    setRemovedFilled([]);
  }

  /** #204 review — the supplier ids the cache holds RIGHT NOW. `save` is reached
   * from a continuation that can outlive the render which started it, so the
   * supplier set behind `filledExisting` may already be stale: the names refetch
   * can have written its fresh list to the cache while React has not yet
   * committed the removal effect. Reading the cache here closes exactly that
   * window — the refetch finished, the effect has not run — independent of
   * whether the effect or the resumed lookup wins. (A refetch still in flight has
   * not written a new list; nothing can know the row is gone until it lands, so
   * this is not a claim about that window.) `null` means the names read has no
   * data (never loaded, or reset mid-read), which must not be read as "every
   * supplier vanished". */
  function livePresentSupplierIds(): string[] | null {
    const data = queryClient.getQueryData<{ items: Array<{ id: string }> }>(orpc.suppliersListNames.queryKey());
    return data === undefined ? null : data.items.map((item) => item.id);
  }

  /** Whether a dropped amount still needs acknowledgement before a write. Reads
   * the live ref AND the live cache, never a captured render value: a refetch
   * that has written a supplier out of the cache can reach here before the
   * reconciliation effect commits, and the removed supplier would otherwise
   * travel in the batch (the server rejects the WHOLE batch, losing the surviving
   * balances — the exact silent-loss class #204 exists to stop). On a live
   * removal this surfaces the loss, drops the vanished drafts, and refuses the
   * write, exactly as the effect would have. */
  function removalBlocksSave(): boolean {
    if (removedFilledRef.current.length > 0) return true;
    const present = livePresentSupplierIds();
    if (present === null) return false;
    const dropped = droppedFilledDrafts({ drafts: draftsRef.current, presentSupplierIds: present });
    if (dropped.length === 0) return false;
    // the outgoing batch changed: abandon any in-flight submit (a late resolve
    // must not write the removed row) and close the confirmation that named the
    // now-shrunk batch, exactly as the refresh effect does
    abandonAttempt();
    setRemovedFilled((current) => {
      const known = new Set(current.map((row) => row.supplierId));
      const added = dropped.filter((row) => !known.has(row.supplierId));
      return added.length === 0 ? current : [...current, ...added];
    });
    setDrafts((current) => {
      const next = { ...current };
      for (const row of dropped) delete next[row.supplierId];
      return next;
    });
    return true;
  }

  async function save(confirmExisting: boolean, destinations: Record<string, ResolvedSupplier | null> | null) {
    if (occurredAt === null) return;
    // a failed read must block the dialog path too, and it must be the failure
    // AT WRITE TIME: this function can run from a continuation that outlived the
    // render which started it, so `listFailed` is a captured value the read can
    // have overtaken (Greptile round 3). Consult the live cache, not the closure.
    const readFailure = liveListFailure();
    if (readFailure !== null) {
      setError(tError(readFailure.message));
      return;
    }
    // surface the reason on the dialog path too, instead of silently no-op'ing
    if (blockedReason !== null) {
      setError(blockedReason);
      return;
    }
    // the dropped amount must be acknowledged before any write is attempted
    if (removalBlocksSave()) {
      setError(t("supplierOpeningRemovedBlocked"));
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
          // #255 — every typed row travels as a NAME; the server is the only
          // resolver. Only a destination the server named (and the dialog showed)
          // forwards confirmExisting, and the named id travels as a per-row
          // consistency check so a draft edited while the dialog was open cannot
          // land elsewhere (issue 184).
          ...readyTypedRows.map((row) => ({
            newSupplierName: row.name,
            direction: row.direction,
            amount: row.amount,
            confirmExisting: forwardsConfirm(confirmExisting, destinations?.[row.id]?.accountEntryCount),
            expectedSupplierId: destinations?.[row.id]?.id ?? null,
          })),
        ],
      });
      await Promise.all([
        ...supplierReadQueryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
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
        await Promise.all(supplierReadQueryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
        try {
          const destinations = await resolveTypedDestinations();
          if (!mountedRef.current || resolveKeyRef.current !== saveResolveKey || dismissalRef.current !== saveDismissal) return;
          rememberResolution(destinations);
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
    if (removalBlocksSave()) {
      setError(t("supplierOpeningRemovedBlocked"));
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
    // the server's resolution is the only source of every typed row's destination
    // (issue 184): ask it per row before deciding what the dialog must name. A
    // batch with no typed row stays synchronous — there is nothing to resolve.
    const destinations = typedLookups.length === 0 ? null : await resolveForSubmit(attempt);
    if (attempt !== attemptRef.current) return; // left or the lookup fields changed
    if (destinations === undefined) return; // resolve failed; the error is already shown
    // a read that failed while the lookup was in flight must not name a dialog
    // either: the counts `confirmNames` would show, and the gate `save` applies,
    // come from the same render this continuation outlived (Greptile round 3
    // class fix). The failure banner is already on screen, so stop silently the
    // way the entry guard does.
    if (liveListFailure() !== null) return;
    const conflict = conflictsWithFilled(destinations);
    if (conflict) {
      setError(t("supplierOpeningRowHasAmount"));
      return;
    }
    const existingNeedsConfirm = filledExisting.some((row) => (row.supplier.accountEntryCount ?? 0) > 0);
    if (existingNeedsConfirm || typedLookups.some((lookup) => (destinations?.[lookup.id]?.accountEntryCount ?? 0) > 0)) {
      rememberResolution(destinations ?? {});
      setConfirming(true);
      return;
    }
    await save(false, destinations);
  }

  /** `submit`'s resolve with the UI guards a bare read needs: a pending flag so
   * a double-click cannot run two, and an error surface instead of an unhandled
   * rejection. `undefined` means it failed and the error is shown. */
  async function resolveForSubmit(attempt: number): Promise<Record<string, ResolvedSupplier | null> | undefined> {
    resolvingRef.current = true;
    setResolving(true);
    try {
      return await resolveTypedDestinations();
    } catch (err) {
      if (attempt === attemptRef.current && mountedRef.current) setError(tError(err instanceof Error ? err.message : undefined));
      return undefined;
    } finally {
      resolvingRef.current = false;
      if (mountedRef.current) setResolving(false);
    }
  }

  /** #252 — the direction Selects' value→label map, and the popup's own options.
   * `SelectValue` renders the raw value when the root has no `items` map, which is
   * how the trigger showed `WE_OWE` while its own popup showed the Arabic labels.
   * One map drives both the trigger and the options, built from one
   * direction→key function, so a label cannot sit on one value in the list and the
   * other in the trigger. */
  const directionItems = [
    { value: "WE_OWE", label: t(supplierDirectionKey("WE_OWE")) },
    { value: "THEY_OWE", label: t(supplierDirectionKey("THEY_OWE")) },
  ];

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
              <li key={account.supplierId} className="flex items-center justify-between gap-3" data-testid="opening-balance-saved-row">
                <span>{account.name}</span>
                <span className="font-medium"><Amount value={Math.abs(account.balance)} /> {t(supplierBalanceDirectionKey(account.balance))}</span>
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
                            {t(supplierBalanceDirectionKey(supplier.accountBalance))}
                          </span>
                        )}
                      </td>
                      <td className="p-2">
                        <Select items={directionItems} value={draft.direction} onValueChange={(next) => setRow(supplier.id, { direction: asDirection(next) })}>
                          <SelectTrigger className="w-28" data-testid="opening-balance-direction">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {directionItems.map((item) => (
                              <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                            ))}
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
                {/* #255 — one row per typed (new-supplier) draft. Keyed by the row's
                    own id so adding or removing a row never moves another row's text,
                    and indexed in the testids because the draft list is positional. */}
                {typedRowEntries.map(({ row: typedRow, status: typedState, error: typedError }, index) => {
                  const typedName = typedRow.name.trim();
                  return (
                    <tr key={typedRow.id} className="border-b bg-accent/40" data-testid={`opening-balance-typed-row-${index}`}>
                      <td className="p-2">
                        <div className="flex items-center gap-1">
                          <input
                            className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
                            value={typedRow.name}
                            onChange={(event) => setTypedRow(typedRow.id, { name: event.target.value })}
                            maxLength={200}
                            placeholder={t("supplierOpeningNewRow")}
                            aria-label={t("supplierOpeningNewRow")}
                            aria-invalid={typedState.status === "invalid" || typedError !== null}
                            data-testid={`opening-balance-typed-name-${index}`}
                          />
                          <button
                            type="button"
                            className="rounded p-1 text-destructive hover:bg-destructive/10 disabled:opacity-50"
                            aria-label={typedName === "" ? t("supplierOpeningRemoveRow") : t("supplierOpeningRemoveRowName", { name: typedName })}
                            onClick={() => removeTypedRow(typedRow.id)}
                            disabled={submitting || bulk.isPending}
                            data-testid={`opening-balance-typed-remove-${index}`}
                          >
                            <X size={16} aria-hidden="true" />
                          </button>
                        </div>
                        {typedError !== null && (
                          <p className="mt-1 text-xs text-destructive" role="alert" data-testid={`opening-balance-typed-error-${index}`}>
                            {typedError}
                          </p>
                        )}
                      </td>
                      <td className="p-2 text-muted-foreground">—</td>
                      <td className="p-2">
                        <Select items={directionItems} value={typedRow.direction} onValueChange={(next) => setTypedRow(typedRow.id, { direction: asDirection(next) })}>
                          <SelectTrigger className="w-28" data-testid={`opening-balance-typed-direction-${index}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {directionItems.map((item) => (
                              <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="p-2">
                        <input
                          className="h-9 w-32 rounded-lg border border-input bg-background px-3 text-sm"
                          inputMode="numeric"
                          autoComplete="off"
                          value={typedRow.amount}
                          onChange={(event) => setTypedRow(typedRow.id, { amount: event.target.value })}
                          aria-label={t("supplierOpeningNewRow")}
                          aria-invalid={typedState.status === "invalid"}
                          data-testid={`opening-balance-typed-amount-${index}`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {hasRemovedFilled && (
            <div className="rounded border border-destructive/30 bg-destructive/10 p-3 text-sm" data-testid="opening-balance-removed">
              {/* the statement is the live region; the dismiss button stays OUTSIDE it,
                  so the control is not announced as part of the alert (a11y review) */}
              <div role="alert">
                <p className="font-semibold text-destructive">{t("supplierOpeningRemovedTitle")}</p>
                <ul className="mt-2 grid gap-1">
                  {removedFilled.map((row) => (
                    <li key={row.supplierId} className="flex flex-wrap items-center gap-1" data-testid="opening-balance-removed-row">
                      <span>{t("supplierOpeningRemovedRow", { name: row.name })}</span>
                      <Amount value={row.amount} />
                    </li>
                  ))}
                </ul>
              </div>
              <div className="mt-3">
                <Button type="button" variant="outline" onClick={dismissRemoved} data-testid="opening-balance-removed-dismiss">
                  {t("supplierOpeningRemovedDismiss")}
                </Button>
              </div>
            </div>
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
            <Button type="submit" disabled={submitting || resolving || bulk.isPending || dateInvalid || listFailed || blockedReason !== null || hasRemovedFilled} data-testid="opening-balance-save">
              {t("supplierOpeningSave", { count: totalRows })}
            </Button>
            {/* #255 — the owner's ask: press it and another blank row appears, so
                several parties are entered and saved in one pass. Disabled at the
                contract's row cap, where a further row could only fail to save. */}
            <Button
              type="button"
              variant="outline"
              onClick={addTypedRow}
              disabled={submitting || resolving || bulk.isPending || listPending || listFailed || addRowBlocked}
              data-testid="opening-balance-add-row"
            >
              {t("supplierOpeningAddRow")}
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
                <Button type="button" onClick={() => void save(true, resolvedDestinations)} disabled={submitting || resolving || bulk.isPending || listFailed || blockedReason !== null || hasRemovedFilled} data-testid="opening-balance-confirm-save">
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
