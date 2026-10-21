import { afterEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserHistory, createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ThemeProvider } from "../lib/theme";
import { chooseOption } from "../tests/select-driver";

/**
 * #321 — a purchase cart must not vanish on a navigation click.
 *
 * The test drives the real router and the real sidebar, because the guard sits
 * at the router: a sidebar link, the header action and the browser's back
 * button all reach the same question. A page-level test cannot prove that,
 * so this file mounts the app's own route tree.
 */

interface ItemMutationOptions {
  onSuccess?: (item: { id: string; name: string; costPrice: number; sellingPrice: number }) => void;
  onError?: (error: { message: string }) => void;
}

mock.module("@/lib/rpc", () => ({
  orpc: {
    // the shell's pending-returns badge (#118)
    returnsPendingCount: {
      queryOptions: () => ({ queryKey: ["returnsPendingCount"], queryFn: async () => ({ count: 0 }) }),
    },
    categoriesList: {
      queryOptions: () => ({
        queryKey: ["categories"],
        queryFn: async () => ({ items: [{ id: "cat-1", name: "تصنيف" }] }),
      }),
    },
    // the picker, if a test opens it
    catalogSearch: {
      queryOptions: () => ({ queryKey: ["catalogSearch"], queryFn: async () => ({ matches: [], exact: null }) }),
    },
    // the quick-add creates the product the cart line carries
    itemsCreate: {
      mutationOptions: (opts?: ItemMutationOptions) => ({
        mutationFn: async (input: { name: string; categoryId: string; costPrice?: number; sellingPrice?: number }) => ({
          id: `item-${input.name}`,
          name: input.name,
          costPrice: input.costPrice ?? 100,
          sellingPrice: input.sellingPrice ?? 150,
        }),
        ...opts,
      }),
    },
    // the save the cart eventually makes; this lane never reaches it
    invoicesCreate: {
      mutationOptions: (opts?: ItemMutationOptions) => ({
        mutationFn: async () => ({ id: "inv-1", invoiceNumber: "1", remainingAmount: 0, counterpartyName: null }),
        ...opts,
      }),
    },
    // the screen the navigation lands on reads the catalogue
    itemsAll: { queryKey: () => ["itemsAll"] },
    itemsLowStock: { queryKey: () => ["itemsLowStock"] },
    itemsList: { queryKey: () => ["itemsList"] },
    // PartyPicker mounts on the purchase form
    suppliersList: {
      queryOptions: () => ({ queryKey: ["suppliers"], queryFn: async () => ({ items: [] }) }),
      queryKey: () => ["suppliers"],
    },
    customersList: {
      queryOptions: () => ({ queryKey: ["customers"], queryFn: async () => ({ items: [] }) }),
      queryKey: () => ["customers"],
    },
    suppliersCreate: {
      mutationOptions: (opts?: ItemMutationOptions) => ({
        mutationFn: async () => ({ id: "s-1", name: "مورد", phone: null, createdAt: "" }),
        ...opts,
      }),
    },
    customersCreate: {
      mutationOptions: (opts?: ItemMutationOptions) => ({
        mutationFn: async () => ({ id: "c-1", name: "زبون", phone: null, createdAt: "" }),
        ...opts,
      }),
    },
  },
  rpcClient: {},
}));

mock.module("@/lib/auth-client", () => ({
  useSession: () => ({ data: null, isPending: false }),
  authClient: { signOut: async () => {} },
}));

const { routeTree } = await import("../router");

interface MountedApp {
  container: HTMLElement;
  root: ReturnType<typeof createRoot>;
  queryClient: QueryClient;
  router: ReturnType<typeof createRouter>;
}

let mounted: MountedApp[] = [];

/**
 * The helpers below fail with an ASSERTION, not a thrown `Error`, whenever the
 * reason is «the UI never got there».
 *
 * Not style: `scripts/red-on-parent.ts` reads the junit failure type, and only
 * `AssertionError` counts as a red on the behaviour this change adds. A body
 * `throw` is reported as `Error`, which the gate reads as «the test could not be
 * evaluated» and judges worthless. Do not turn these back into throws.
 */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("HTMLInputElement value setter is unavailable");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function byTestId<T extends HTMLElement>(testId: string): T {
  const element = document.querySelector<T>(`[data-testid="${testId}"]`);
  expect(element).not.toBeNull();
  // SAFETY: the assertion above fails the test when the element is absent
  return element as T;
}

function navLink(href: string): HTMLAnchorElement {
  const link = document.querySelector<HTMLAnchorElement>(`nav a[href="${href}"]`);
  expect(link).not.toBeNull();
  // SAFETY: the assertion above fails the test when the link is absent
  return link as HTMLAnchorElement;
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  // the last look is the assertion: see the note above the helpers
  expect(check()).toBe(true);
}

async function mountRouter(router: ReturnType<typeof createRouter>): Promise<MountedApp> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const app: MountedApp = { container, root, queryClient, router };
  mounted.push(app);
  await act(async () => {
    root.render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
  });
  await waitFor(() => document.querySelector('[data-testid="purchase-form"]') !== null);
  return app;
}

async function mountPurchaseRoute(initialEntries: string[] = ["/purchase"]): Promise<MountedApp> {
  return mountRouter(createRouter({ routeTree, history: createMemoryHistory({ initialEntries }) }));
}

/**
 * The purchase screen mounted on the BROWSER's history, not an in-memory one.
 *
 * A memory history has no popstate: its `back()` just moves an index, so the
 * back button cannot be exercised through it at all. Only the browser history
 * carries that path, and only for same-document entries, so the two entries
 * the back button walks between are pushed through the history itself (the
 * document's own first entry is a page load, which no test can perform).
 */
async function mountPurchaseRouteOnBrowserHistory(): Promise<MountedApp> {
  const history = createBrowserHistory();
  history.push("/customers");
  // the flush is a microtask: without it both pushes collapse into one entry
  await Promise.resolve();
  history.push("/purchase");
  await Promise.resolve();
  return mountRouter(createRouter({ routeTree, history }));
}

/** quick-add one purchase line, the way the owner does it at the counter */
/** an element the test needs, or a failure that names the selector it could not
 * find — never a bare non-null assertion, which would report a null deref far
 * from the line that actually broke */
function mustFind<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`the test could not find ${selector}`);
  return found;
}

async function addQuickLine(container: HTMLElement, qty: string, cost: string) {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="purchase-toggle-quick"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const quickForm = container.querySelector<HTMLFormElement>('[data-testid="purchase-quick-form"]');
  expect(quickForm).not.toBeNull();
  // SAFETY: the assertion above fails the test when the form is absent
  const form = quickForm as HTMLFormElement;
  await act(async () => {
    typeInto(mustFind<HTMLInputElement>(form, '[data-testid="quick-name"]'), "منتج");
    typeInto(mustFind<HTMLInputElement>(form, '[data-testid="quick-qty"]'), qty);
    typeInto(mustFind<HTMLInputElement>(form, '[data-testid="quick-cost"]'), cost);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // the driver runs its own act() calls; wrapping it in another one overlaps
  // them and React then drops later updates
  await chooseOption(mustFind<HTMLElement>(form, "button"), "تصنيف");
  await act(async () => {
    form.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** the quantity field of the cart's only line */
function quantityField(container: HTMLElement): HTMLInputElement {
  const field = container.querySelector<HTMLInputElement>('input[aria-label*="الكمية"]');
  expect(field).not.toBeNull();
  // SAFETY: the assertion above fails the test when the field is absent
  return field as HTMLInputElement;
}

afterEach(async () => {
  const apps = mounted;
  mounted = [];
  for (const app of apps) {
    await act(async () => app.root.unmount());
    app.container.remove();
    app.queryClient.clear();
  }
  document.body.innerHTML = "";
});

describe("purchase cart guard (issue #321)", () => {
  it("asks before a navigation throws the cart away, and keeps the cart when the owner stays", async () => {
    const app = await mountPurchaseRoute();
    await addQuickLine(app.container, "2", "500");
    await waitFor(() => document.querySelector('[data-testid="purchase-lines"]') !== null);

    // the owner types a quantity and leaves the caret on it
    const quantity = quantityField(app.container);
    await act(async () => typeInto(quantity, "4"));
    quantity.focus();

    await act(async () => navLink("/customers").click());

    // the question is on screen, and it names the lines that would go
    await waitFor(() => document.querySelector('[data-testid="purchase-discard-confirm"]') !== null);
    const dialog = document.querySelector('[role="dialog"]');
    // the count is interpolated by the component; assert the shape AND the digit,
    // never the same `t()` call the component makes (that cannot fail)
    expect(dialog?.textContent).toContain("عدد أسطر الفاتورة التي ستُفقد: 1");
    // the screen is still the purchase screen: the navigation is held
    expect(app.router.state.location.pathname).toBe("/purchase");

    // the owner refuses: the cart is exactly as it was
    await act(async () => byTestId<HTMLButtonElement>("purchase-discard-stay").click());
    await waitFor(() => document.querySelector('[data-testid="purchase-discard-confirm"]') === null);

    expect(app.router.state.location.pathname).toBe("/purchase");
    expect(app.container.querySelectorAll('[data-testid="purchase-lines"] tbody tr')).toHaveLength(1);
    expect(quantityField(app.container).value).toBe("4");
    // the caret is back on the line the owner was working in
    expect(document.activeElement).toBe(quantityField(app.container));
  });

  it("discards the cart when the owner leaves on purpose, and comes back to an empty one", async () => {
    const app = await mountPurchaseRoute();
    await addQuickLine(app.container, "2", "500");
    await waitFor(() => document.querySelector('[data-testid="purchase-lines"]') !== null);

    await act(async () => navLink("/customers").click());
    await waitFor(() => document.querySelector('[data-testid="purchase-discard-confirm"]') !== null);
    await act(async () => byTestId<HTMLButtonElement>("purchase-discard-confirm").click());

    // the navigation went through
    await waitFor(() => document.querySelector('[data-testid="purchase-form"]') === null);
    expect(app.router.state.location.pathname).toBe("/customers");

    // and the cart is not resurrected: coming back starts empty
    await act(async () => navLink("/purchase").click());
    await waitFor(() => document.querySelector('[data-testid="purchase-form"]') !== null);
    expect(document.querySelector('[data-testid="purchase-lines"]')).toBeNull();
    expect(document.querySelector('[data-testid="purchase-empty"]')).not.toBeNull();
  });

  // red-on-parent-waive: "leaves without a prompt when the cart is empty" — the parent has no guard at all, so an empty cart already leaves silently; this test pins the path the change must NOT change
  it("leaves without a prompt when the cart is empty", async () => {
    const app = await mountPurchaseRoute();

    await act(async () => navLink("/customers").click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    expect(document.querySelector('[data-testid="purchase-discard-confirm"]')).toBeNull();
    expect(app.router.state.location.pathname).toBe("/customers");
  });

  it("asks before the browser's back button throws the cart away", async () => {
    // the back button is a POP, not a link click: it reaches the guard through
    // the browser's popstate, which is the second path the issue names. A
    // memory history cannot carry it (its back() only moves an index), so this
    // test mounts the real history the router ships with.
    const app = await mountPurchaseRouteOnBrowserHistory();
    await addQuickLine(app.container, "2", "500");
    await waitFor(() => document.querySelector('[data-testid="purchase-lines"]') !== null);

    await act(async () => {
      // the DOM API, not `router.history.back()`: this is the popstate a person's
      // browser fires when they hit Back
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => document.querySelector('[data-testid="purchase-discard-confirm"]') !== null);
    // the history did not move: the cart is still the screen on display
    expect(app.router.state.location.pathname).toBe("/purchase");

    await act(async () => byTestId<HTMLButtonElement>("purchase-discard-stay").click());
    await waitFor(() => document.querySelector('[data-testid="purchase-discard-confirm"]') === null);

    expect(app.router.state.location.pathname).toBe("/purchase");
    expect(app.container.querySelectorAll('[data-testid="purchase-lines"] tbody tr')).toHaveLength(1);
  });

  it("asks the browser's own question on a reload, because a reload cannot be blocked", async () => {
    // #321 review round 2 — the hook's docstring claimed a reload asks the same
    // question, and nothing covered it. A reload cannot be intercepted, so the
    // honest guarantee is `beforeunload`: the browser's generic prompt instead of
    // the app's dialog, and only once the cart is dirty.
    // the listener lives on the BROWSER history (`@tanstack/history` registers it
    // there only); a memory-history mount has none, which is what made the first
    // version of this test pass a false negative
    const app = await mountPurchaseRouteOnBrowserHistory();
    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    await addQuickLine(app.container, "2", "500");
    await waitFor(() => document.querySelector('[data-testid="purchase-lines"]') !== null);

    const dirtyEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);
  });

  it("holds the navigation for a quick-add field that is not a line, a name or a price", async () => {
    // #321 review round 2 — the inline `||` chain missed `threshold` and `qty`, and
    // no test could see the miss: `supplier.name` alone kept all five green. This
    // types into a field the old chain ignored, so the widened rule is wired, not
    // merely unit-tested.
    const app = await mountPurchaseRoute();
    await act(async () => {
      app.container.querySelector<HTMLButtonElement>('[data-testid="purchase-toggle-quick"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const threshold = mustFind<HTMLInputElement>(app.container, 'input[name="quickThreshold"]');
    await act(async () => typeInto(threshold, "5"));

    await act(async () => navLink("/customers").click());

    await waitFor(() => document.querySelector('[data-testid="purchase-discard-confirm"]') !== null);
    expect(app.router.state.location.pathname).toBe("/purchase");

    await act(async () => byTestId<HTMLButtonElement>("purchase-discard-stay").click());
    await waitFor(() => document.querySelector('[data-testid="purchase-discard-confirm"]') === null);
  });

  it("treats a pasted bidi mark as work, the way the sale screen does", async () => {
    // #244's rule, ported: the dirty gate is raw `.trim()`, so a mark that is
    // NOT whitespace (U+200F is Cf) is still work the prompt must keep. With no
    // line the cart is empty, so the mark is the only thing that can hold the
    // navigation — which is exactly what makes this test worth having.
    const app = await mountPurchaseRoute();

    const supplier = app.container.querySelector<HTMLInputElement>('[data-testid="purchase-supplier"]');
    expect(supplier).not.toBeNull();
    // SAFETY: the assertion above fails the test when the field is absent
    await act(async () => typeInto(supplier as HTMLInputElement, "\u200F"));

    await act(async () => navLink("/customers").click());

    await waitFor(() => document.querySelector('[data-testid="purchase-discard-confirm"]') !== null);
    const dialog = document.querySelector('[role="dialog"]');
    // no line yet, so the prompt must not claim «0 lines would be lost». The
    // literal is deliberate: asserting `i18n.t(...)` compares the component's call
    // with the same call, so a broken catalogue entry would pass.
    expect(dialog?.textContent).toContain("على هذه الفاتورة عمل لم يُحفظ بعد");
    expect(app.router.state.location.pathname).toBe("/purchase");

    await act(async () => byTestId<HTMLButtonElement>("purchase-discard-stay").click());
    await waitFor(() => document.querySelector('[data-testid="purchase-discard-confirm"]') === null);

    const kept = app.container.querySelector<HTMLInputElement>('[data-testid="purchase-supplier"]');
    expect(kept?.value).toBe("\u200F");
  });
});
