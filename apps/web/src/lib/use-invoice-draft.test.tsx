import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { Item } from "@dokan/contracts";

import { saleUnitPrice, type SaleDraftLine } from "./invoice-draft";
import {
  useInvoiceDraft,
  usePaymentPair,
  useQuickAdd,
  type PaymentPairState,
  type QuickAddOutcome,
  type QuickAddSpec,
} from "./use-invoice-draft";

// React 19 act() requires the environment flag to be set explicitly.
// SAFETY: only this flag is written; globalThis keeps every other property.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * #146 — the React adapter's own coverage. The pure rules are unit-tested in
 * `invoice-draft.test.ts`; these pin the wiring the pages rely on: the seed and
 * reset policy of `openForm`, the create-then-land-the-line flow, the line list,
 * and the payment pair's link to the reference total.
 */

function item(id: string, sellingPrice = 1000, costPrice = 400): Item {
  return {
    id,
    name: `منتج ${id}`,
    barcode: null,
    categoryId: "cat-1",
    costPrice,
    sellingPrice,
    lowStockThreshold: 0,
    stockOnHand: 0,
    createdAt: "2026-10-01T10:00:00",
    updatedAt: "2026-10-01T10:00:00",
  };
}

let roots: Array<{ unmount: () => void; host: HTMLElement }> = [];

afterEach(() => {
  const entries = roots;
  roots = [];
  for (const entry of entries) {
    entry.unmount();
    entry.host.remove();
  }
  document.body.innerHTML = "";
});

/** Renders a hook in a throwaway root and hands the test its latest value. */
function mountHook<T>(useHook: () => T) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let current: T | null = null;

  function Harness() {
    current = useHook();
    return null;
  }
  act(() => {
    root.render(<Harness />);
  });
  const api = {
    get: (): T => {
      if (current === null) throw new Error("hook did not mount");
      return current;
    },
    unmount: () => act(() => root.unmount()),
    host,
  };
  roots.push({ unmount: api.unmount, host });
  return api;
}

const SALE_DRAFT = {
  emptyLine: (entry: Item): SaleDraftLine => ({ item: entry, quantityDraft: "1", overrideType: "", overrideValue: "" }),
  unitPrice: saleUnitPrice,
};

/** sale's contract: reset on every open, and nothing survives a create */
const RESETTING_QUICK: QuickAddSpec<{ name: string; barcode: string }> = {
  empty: () => ({ name: "", barcode: "" }),
  resetOnOpen: true,
  keepOnCreate: [],
};
/** purchase's open policy: keep what is typed across a close */
const RETAINING_QUICK: QuickAddSpec<{ name: string; barcode: string }> = {
  empty: () => ({ name: "", barcode: "" }),
  resetOnOpen: false,
  keepOnCreate: [],
};
/** purchase's create policy: the destination category survives a successful create */
const KEEPING_QUICK: QuickAddSpec<{ name: string; barcode: string; categoryId: string }> = {
  empty: () => ({ name: "", barcode: "", categoryId: "" }),
  resetOnOpen: false,
  keepOnCreate: ["categoryId"],
};

/**
 * The same policy with a NON-empty default for the kept field, so a test can
 * tell "the cleared value was carried forward" from "the keep was ignored and
 * empty() was used instead".
 */
const KEEPING_DEFAULT_QUICK: QuickAddSpec<{ name: string; barcode: string; categoryId: string }> = {
  empty: () => ({ name: "", barcode: "", categoryId: "cat-default" }),
  resetOnOpen: false,
  keepOnCreate: ["categoryId"],
};

/** A keeping spec that hands back the SAME frozen object on every call. */
const FROZEN_EMPTY = Object.freeze({ name: "", barcode: "", categoryId: "cat-default" });
const FROZEN_KEEPING: QuickAddSpec<{ name: string; barcode: string; categoryId: string }> = {
  empty: () => FROZEN_EMPTY,
  resetOnOpen: false,
  keepOnCreate: ["categoryId"],
};

function mountQuick<F extends { name: string } & Record<string, string>>(spec: QuickAddSpec<F>) {
  const created: Array<{ id: string; name: string }> = [];
  const errors: Array<string | null> = [];
  const hook = mountHook(() =>
    useQuickAdd(spec, {
      onCreated: (entry, fields) => created.push({ id: entry.id, name: fields.name }),
      setError: (message) => errors.push(message),
    }),
  );
  return { hook, created, errors };
}

describe("useInvoiceDraft (the line list behind both screens)", () => {
  it("adds, merges a repeat pick, re-prices and removes", () => {
    const { get } = mountHook(() => useInvoiceDraft(SALE_DRAFT));

    act(() => get().addItem(item("a")));
    act(() => get().addItem(item("a")));
    expect(get().lines).toHaveLength(1);
    expect(get().lines[0]!.quantityDraft).toBe("2");
    expect(get().subtotal).toBe(2000);

    act(() => get().setQuantity("a", "3"));
    expect(get().subtotal).toBe(3000);

    act(() => get().patch("a", { overrideType: "AMOUNT", overrideValue: "500" }));
    expect(get().subtotal).toBe(1500);

    act(() => get().remove("a"));
    expect(get().lines).toEqual([]);
    expect(get().subtotal).toBe(0);
  });

  it("lands a quick-added line with kind-specific extras and resets on demand", () => {
    const { get } = mountHook(() => useInvoiceDraft(SALE_DRAFT));

    act(() => get().addItem(item("a"), { quantityDraft: "4" }));
    expect(get().lines[0]!.quantityDraft).toBe("4");
    expect(get().subtotal).toBe(4000);

    act(() => get().reset());
    expect(get().lines).toEqual([]);
  });

  it("treats an unusable draft as a zero line without dropping it", () => {
    const { get } = mountHook(() => useInvoiceDraft(SALE_DRAFT));
    act(() => get().addItem(item("a")));
    act(() => get().setQuantity("a", ""));
    expect(get().lines).toHaveLength(1);
    expect(get().subtotal).toBe(0);
  });
});

describe("useQuickAdd (the quick-add form's behaviour)", () => {
  it("resets the bag and applies the seed when resetOnOpen is true", () => {
    const { hook } = mountQuick(RESETTING_QUICK);
    act(() => hook.get().openForm({ barcode: "111" }));
    expect(hook.get().fields).toEqual({ name: "", barcode: "111" });

    act(() => hook.get().setField("name", "typed"));
    act(() => hook.get().openForm({ barcode: "222" }));
    expect(hook.get().fields).toEqual({ name: "", barcode: "222" });
  });

  it("merges a seed into the retained bag when resetOnOpen is false", () => {
    const { hook } = mountQuick(RETAINING_QUICK);
    act(() => hook.get().openForm({ name: "kept" }));
    act(() => hook.get().setField("barcode", "111"));
    // purchase keeps what is typed across a close, and a seed still lands
    act(() => hook.get().openForm({ barcode: "222" }));
    expect(hook.get().fields).toEqual({ name: "kept", barcode: "222" });
  });

  it("toggles and closes the form", () => {
    const { hook } = mountQuick(RESETTING_QUICK);
    act(() => hook.get().toggle());
    expect(hook.get().open).toBe(true);
    act(() => hook.get().close());
    expect(hook.get().open).toBe(false);
  });

  it("lands the created item with the fields it was created from, then closes and resets", async () => {
    const { hook, created, errors } = mountQuick(RESETTING_QUICK);
    act(() => hook.get().openForm({ barcode: "111" }));
    act(() => hook.get().setField("name", "منتج"));

    await act(async () => {
      await hook.get().submit(async (fields) => ({ ok: true, item: item(fields.name) }));
    });
    expect(created).toEqual([{ id: "منتج", name: "منتج" }]);
    expect(hook.get().open).toBe(false);
    expect(hook.get().fields).toEqual({ name: "", barcode: "" });
    expect(errors).toEqual([null]);
  });

  it("keeps only the fields the spec declares across a successful create", async () => {
    const { hook } = mountQuick(KEEPING_QUICK);
    act(() => hook.get().openForm({ name: "منتج", barcode: "111" }));
    act(() => hook.get().setField("categoryId", "cat-1"));

    await act(async () => {
      await hook.get().submit(async () => ({ ok: true, item: item("منتج") }));
    });
    // the declared field survives so the next item needs no second pick
    expect(hook.get().fields).toEqual({ name: "", barcode: "", categoryId: "cat-1" });
  });

  it("keeps a cleared declared field cleared rather than falling back to empty()", async () => {
    const { hook } = mountQuick(KEEPING_DEFAULT_QUICK);
    act(() => hook.get().openForm({ categoryId: "cat-1" }));
    act(() => hook.get().setField("categoryId", ""));

    await act(async () => {
      await hook.get().submit(async () => ({ ok: true, item: item("a") }));
    });
    // an empty() fallback would resurrect "cat-default", so this only passes
    // when the cleared value is what the kept field carries forward
    expect(hook.get().fields.categoryId).toBe("");
  });

  it("keeps a declared field the owner edits while the create is in flight", async () => {
    const { hook } = mountQuick(KEEPING_QUICK);
    act(() => hook.get().openForm({ categoryId: "cat-1" }));

    let release: (outcome: QuickAddOutcome) => void = () => undefined;
    const create = () =>
      new Promise<QuickAddOutcome>((resolve) => {
        release = resolve;
      });
    let settled: Promise<void> = Promise.resolve();
    await act(async () => {
      settled = hook.get().submit(create);
    });

    // the create has not settled, so the form is still live: the owner retargets
    // the kept field, and that newer value must be what the next form keeps
    act(() => hook.get().setField("categoryId", "cat-2"));
    await act(async () => {
      release({ ok: true, item: item("a") });
      await settled;
    });
    expect(hook.get().fields.categoryId).toBe("cat-2");
  });

  it("never mutates the object a spec hands back from empty()", async () => {
    const { hook } = mountQuick(FROZEN_KEEPING);
    act(() => hook.get().openForm({ name: "x" }));
    act(() => hook.get().setField("categoryId", "cat-1"));

    await act(async () => {
      await hook.get().submit(async () => ({ ok: true, item: item("a") }));
    });
    // writing into the frozen default would throw during submit, so reaching
    // this assertion is itself the proof that the bag was copied
    expect(FROZEN_EMPTY).toEqual({ name: "", barcode: "", categoryId: "cat-default" });
    expect(hook.get().fields).toEqual({ name: "", barcode: "", categoryId: "cat-1" });
  });

  it("does not touch the bag when the create is refused", async () => {
    const { hook } = mountQuick(KEEPING_QUICK);
    act(() => hook.get().openForm({ name: "منتج", barcode: "111" }));
    act(() => hook.get().setField("categoryId", "cat-1"));

    await act(async () => {
      await hook.get().submit(async () => ({ ok: false, error: "أدخل كمية صحيحة" }));
    });
    // the typed work survives so the owner can correct the one bad value
    expect(hook.get().fields).toEqual({ name: "منتج", barcode: "111", categoryId: "cat-1" });
    expect(hook.get().open).toBe(true);
  });

  it("lets a later seed win over a kept field, since a kept field is not preserved across an open", async () => {
    const { hook } = mountQuick(KEEPING_QUICK);
    act(() => hook.get().openForm({ categoryId: "cat-1" }));
    await act(async () => {
      await hook.get().submit(async () => ({ ok: true, item: item("a") }));
    });
    expect(hook.get().fields.categoryId).toBe("cat-1");

    // resetOnOpen false merges into the retained bag, so a seed overwrites a
    // kept field on purpose; the keep list governs the create, not the open. The
    // leftover barcode proves the bag was RETAINED and not rebuilt from empty()
    // and then merged, which would drop it.
    act(() => hook.get().setField("barcode", "leftover"));
    act(() => hook.get().openForm({ name: "next", categoryId: "cat-2" }));
    expect(hook.get().fields).toEqual({ name: "next", barcode: "leftover", categoryId: "cat-2" });
  });

  it("re-seeds from empty on the next open when the spec keeps nothing", async () => {
    const { hook } = mountQuick(RESETTING_QUICK);
    act(() => hook.get().openForm({ barcode: "111" }));
    act(() => hook.get().setField("name", "typed"));

    await act(async () => {
      await hook.get().submit(async () => ({ ok: true, item: item("a") }));
    });
    expect(hook.get().fields).toEqual({ name: "", barcode: "" });

    // sale's contract: the next open rebuilds from empty() plus its seed, so a
    // previous pick is deliberately gone
    act(() => hook.get().openForm({ barcode: "222" }));
    expect(hook.get().fields).toEqual({ name: "", barcode: "222" });
  });

  it("does not land a line when the create call refuses, and reports it", async () => {
    const { hook, created, errors } = mountQuick(RESETTING_QUICK);
    act(() => hook.get().openForm({ barcode: "111" }));
    await act(async () => {
      await hook.get().submit(async () => ({ ok: false, error: "أدخل كمية صحيحة" }));
    });
    expect(created).toEqual([]);
    // the form stays open so the value can be corrected
    expect(hook.get().open).toBe(true);
    expect(errors).toEqual([null, "أدخل كمية صحيحة"]);
  });
});

describe("usePaymentPair (the #162 amount and percentage link)", () => {
  function mountPair(initialTotal: number) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let current: PaymentPairState | null = null;

    function Harness({ total }: { total: number }) {
      current = usePaymentPair(total);
      return null;
    }
    act(() => {
      root.render(<Harness total={initialTotal} />);
    });
    const unmount = () => act(() => root.unmount());
    roots.push({ unmount, host });
    return {
      get: (): PaymentPairState => {
        if (current === null) throw new Error("hook did not mount");
        return current;
      },
      setTotal: (next: number) => act(() => root.render(<Harness total={next} />)),
    };
  }

  it("follows the full total while untouched, then rescales an edited percentage", () => {
    const pair = mountPair(0);
    expect(pair.get()).toMatchObject({ amount: "", percentage: "", source: null });

    pair.setTotal(1000);
    expect(pair.get()).toMatchObject({ amount: "1000", percentage: "100" });

    act(() => pair.get().onChange({ amount: "500", percentage: "50" }, "percentage"));
    pair.setTotal(2000);
    expect(pair.get()).toMatchObject({ amount: "1000", percentage: "50", source: "percentage" });
  });

  it("keeps an edited amount, re-derives the percentage, and resets after a save", () => {
    const pair = mountPair(1000);
    act(() => pair.get().onChange({ amount: "400", percentage: "40" }, "amount"));
    pair.setTotal(2000);
    expect(pair.get()).toMatchObject({ amount: "400", percentage: "20", source: "amount" });

    act(() => pair.get().reset());
    expect(pair.get()).toMatchObject({ amount: "", percentage: "", source: null });
  });

  it("drops a percentage-based payment to zero when the reference disappears", () => {
    const pair = mountPair(1000);
    act(() => pair.get().onChange({ amount: "500", percentage: "50" }, "percentage"));
    pair.setTotal(0);
    expect(pair.get()).toMatchObject({ amount: "0", percentage: "50", source: "percentage" });
  });
});
