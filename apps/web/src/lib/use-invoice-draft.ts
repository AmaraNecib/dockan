import { useCallback, useEffect, useReducer, useState } from "react";

import type { Item } from "@dokan/contracts";

import {
  EMPTY_PAYMENT_PAIR,
  draftReducer,
  draftSubtotal,
  nextPaymentPair,
  paymentPairUnchanged,
  type DraftAction,
  type DraftLine,
  type PaymentPair,
  type PaymentSource,
} from "@/lib/invoice-draft";

/**
 * #146, the React side of the invoice-draft module. Each hook wraps a pure rule
 * from `invoice-draft.ts`, so the pages keep only their kind-specific fields.
 */

/** Per-kind configuration. Define these at module scope so identity is stable. */
export interface InvoiceDraftConfig<T extends DraftLine> {
  /** The line a freshly added item lands as (quantity 1, kind-specific extras). */
  emptyLine(item: Item): T;
  /** The per-kind unit price a line bills at (sale override, purchase cost). */
  unitPrice(line: T): number;
}

export interface InvoiceDraft<T extends DraftLine> {
  lines: T[];
  /** Add an item, merging a repeat pick into its existing line. */
  addItem(item: Item, extras?: Partial<T>): void;
  setQuantity(itemId: string, draft: string): void;
  /** Merge kind-specific fields (price override, unit cost) into one line. */
  patch(itemId: string, patch: Partial<T>): void;
  remove(itemId: string): void;
  reset(): void;
  subtotal: number;
}

/**
 * The line list behind both invoice screens. Wraps the pure reducer, so the
 * add, merge, remove and set-quantity rules live in one place and are
 * unit-tested without React.
 */
export function useInvoiceDraft<T extends DraftLine>(config: InvoiceDraftConfig<T>): InvoiceDraft<T> {
  const [lines, dispatch] = useReducer(
    (state: T[], action: DraftAction<T>): T[] => draftReducer(state, action),
    // SAFETY: an empty draft is a valid T[] for every T; useReducer cannot infer
    // T from the generic reducer alone, so the initial value states it.
    [] as T[],
  );

  const addItem = useCallback(
    (item: Item, extras?: Partial<T>) => {
      dispatch({ type: "add", line: { ...config.emptyLine(item), ...extras } });
    },
    [config],
  );
  const setQuantity = useCallback((itemId: string, draft: string) => {
    dispatch({ type: "quantity", itemId, draft });
  }, []);
  const patch = useCallback((itemId: string, next: Partial<T>) => {
    dispatch({ type: "patch", itemId, patch: next });
  }, []);
  const remove = useCallback((itemId: string) => {
    dispatch({ type: "remove", itemId });
  }, []);
  const reset = useCallback(() => {
    dispatch({ type: "reset" });
  }, []);

  return { lines, addItem, setQuantity, patch, remove, reset, subtotal: draftSubtotal(lines, config.unitPrice) };
}

export interface PaymentPairState {
  amount: string;
  percentage: string;
  source: PaymentSource;
  /** The `AmountPercentageInput` change handler; `edited` is the source of truth. */
  onChange(next: { amount: string; percentage: string }, edited: Exclude<PaymentSource, null>): void;
  /** After a save: a fresh pair follows the next cart's total. */
  reset(): void;
}

/**
 * The #162 amount and percentage pair shared by both screens. The link runs on
 * the pure `nextPaymentPair` transition whenever the reference total changes;
 * the input itself owns the link between edits.
 */
export function usePaymentPair(total: number): PaymentPairState {
  const [pair, setPair] = useState<PaymentPair>(EMPTY_PAYMENT_PAIR);

  useEffect(() => {
    setPair((current) => {
      const next = nextPaymentPair(total, current);
      return paymentPairUnchanged(next, current) ? current : next;
    });
  }, [total]);

  const onChange = useCallback((next: { amount: string; percentage: string }, edited: Exclude<PaymentSource, null>) => {
    setPair({ amount: next.amount, percentage: next.percentage, source: edited });
  }, []);
  const reset = useCallback(() => setPair(EMPTY_PAYMENT_PAIR), []);

  return { amount: pair.amount, percentage: pair.percentage, source: pair.source, onChange, reset };
}

/** Whether a quick-add's create call produced the item or a message to show. */
export type QuickAddOutcome = { ok: true; item: Item } | { ok: false; error: string };

export interface QuickAddSpec<F extends Record<string, string>> {
  /** The field bag a fresh form starts with. */
  empty(): F;
  /**
   * Whether opening the form resets the bag. Sale resets on every open (a scan
   * seeds the barcode); purchase keeps what the owner already typed.
   */
  resetOnOpen: boolean;
  /**
   * Fields that survive a SUCCESSFUL create. Everything else returns to
   * `empty()`. This is required so every caller states the policy: the first
   * version of this hook reset the whole bag, which silently dropped the
   * category purchase used to keep and forced the owner to re-pick it for
   * every item. Purchase keeps the destination category; sale keeps nothing,
   * because it re-derives its category default on every open.
   */
  keepOnCreate: readonly (keyof F & string)[];
}

/**
 * The bag the next form starts from after a successful create: everything back
 * to `empty()`, except the fields the spec declared it keeps.
 */
function nextBag<F extends Record<string, string>>(spec: QuickAddSpec<F>, fields: F): F {
  const next = spec.empty();
  for (const key of spec.keepOnCreate) next[key] = fields[key];
  return next;
}

export interface QuickAddOptions<F> {
  /** Land the created item on the draft (sale adds or merges; purchase replaces). */
  onCreated(item: Item, fields: F): void;
  /** The page's error setter, so the quick-add shares the one error surface. */
  setError(message: string | null): void;
}

export interface QuickAdd<F extends Record<string, string>> {
  open: boolean;
  fields: F;
  setField<K extends keyof F & string>(key: K, value: F[K]): void;
  /** Open the form, optionally seeding fields (a scanned barcode, a category). */
  openForm(seed?: Partial<F>): void;
  close(): void;
  toggle(): void;
  /** Validate and create through the caller's `create`, then land the line. */
  submit(create: (fields: F) => Promise<QuickAddOutcome>): Promise<void>;
}

/**
 * The quick-add item form's behaviour: open and close, the typed field bag, the
 * create-then-land-the-line flow, and error routing. The caller owns the
 * fields, their validation and copy (`create`), and the markup. The two forms
 * have different fields, labels and defaults by intent, so only the rules are
 * shared.
 */
export function useQuickAdd<F extends Record<string, string>>(
  spec: QuickAddSpec<F>,
  options: QuickAddOptions<F>,
): QuickAdd<F> {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<F>(() => spec.empty());

  const openForm = useCallback(
    (seed?: Partial<F>) => {
      setFields((current) => (spec.resetOnOpen ? { ...spec.empty(), ...seed } : { ...current, ...seed }));
      setOpen(true);
    },
    [spec],
  );
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((current) => !current), []);
  const setField = useCallback(<K extends keyof F & string>(key: K, value: F[K]) => {
    setFields((current) => ({ ...current, [key]: value }));
  }, []);

  const submit = useCallback(
    async (create: (fields: F) => Promise<QuickAddOutcome>) => {
      options.setError(null);
      const outcome = await create(fields);
      if (!outcome.ok) {
        options.setError(outcome.error);
        return;
      }
      options.onCreated(outcome.item, fields);
      setOpen(false);
      setFields(nextBag(spec, fields));
    },
    [fields, options, spec],
  );

  return { open, fields, setField, openForm, close, toggle, submit };
}
