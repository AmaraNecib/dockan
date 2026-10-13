import { afterEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import i18n from "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

/**
 * The kind and status filters clear themselves with an empty-valued "All"
 * option, which is also what removes the query parameter. That coercion is the
 * part worth pinning: Base UI hands back `null` for an empty selection, the page
 * maps it to "", and the request must then carry no filter at all. Getting it
 * wrong leaves the list filtered with nothing on screen explaining why.
 */
type Status = "UNPAID" | "PARTIAL" | "PAID";

type Row = {
  id: string;
  invoiceNumber: string;
  kind: "SALE" | "PURCHASE";
  status: Status;
  counterpartyName: string | null;
  invoiceDate: string;
  totalAmount: number;
  remainingAmount: number;
};

/** every request the page made, in order, so apply-then-clear is provable */
let requests: Array<{ kind?: string; status?: string; limit?: number; offset?: number }> = [];

const allInvoices: Row[] = [
  { id: "inv-1", invoiceNumber: "INV-0001", kind: "SALE", status: "UNPAID", counterpartyName: "زبون", invoiceDate: "2026-08-01", totalAmount: 1000, remainingAmount: 1000 },
  { id: "inv-2", invoiceNumber: "INV-0002", kind: "PURCHASE", status: "PAID", counterpartyName: "مورد", invoiceDate: "2026-08-02", totalAmount: 500, remainingAmount: 0 },
];

// stub the whole seam + Link (rendered as a plain anchor) so the page is
// testable without a network or a router mount, matching returns.test.tsx
mock.module("@tanstack/react-router", () => ({
  Link: (props: { children?: import("react").ReactNode; className?: string; "data-testid"?: string; params?: Record<string, string>; to?: string }) => {
    const { children, params, to, ...rest } = props;
    return <a href={`${to ?? ""}?${new URLSearchParams(params ?? {}).toString()}`} {...rest}>{children}</a>;
  },
  useParams: () => ({}),
}));

mock.module("@/lib/rpc", () => ({
  orpc: {
    invoicesList: {
      // SAFETY: mirror the real tanstack-query utils signature ({ input })
      queryOptions: ({ input }: { input: { kind?: "SALE" | "PURCHASE"; status?: Status; limit?: number; offset?: number } }) => ({
        queryKey: ["invoicesList", input],
        queryFn: async () => {
          requests.push(input);
          const items = allInvoices.filter(
            (row) =>
              (input.kind === undefined || row.kind === input.kind) &&
              (input.status === undefined || row.status === input.status),
          );
          return { items, total: items.length };
        },
      }),
    },
  },
  rpcClient: {},
}));

const { InvoicesPage } = await import("./invoices");

let mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  const roots = mounted;
  mounted = [];
  for (const root of roots) act(() => root.unmount());
  document.body.innerHTML = "";
  requests = [];
});

/** act-wrapped polling so floating-ui positioning and store updates settle inside React */
const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("condition not met within timeout");
};

async function mountPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <InvoicesPage />
      </QueryClientProvider>,
    );
  });
  await waitFor(() => container.querySelector("[data-testid='invoices-table']") !== null);
  return {
    rows: () => Array.from(container.querySelectorAll<HTMLTableRowElement>("tr[data-testid='invoice-row']")),
    numbers: () =>
      Array.from(container.querySelectorAll<HTMLTableRowElement>("tr[data-testid='invoice-row']")).map((row) =>
        row.querySelector("td")?.textContent ?? "",
      ),
  };
}

function openPopup(trigger: HTMLElement) {
  act(() => {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** choose the option whose visible label matches the translated string */
async function choose(testId: string, label: string) {
  const trigger = document.querySelector<HTMLElement>(`[data-testid='${testId}']`)!;
  openPopup(trigger);
  await waitFor(() => document.querySelectorAll("[role='option']").length > 0);
  const option = Array.from(document.querySelectorAll<HTMLElement>("[role='option']")).find((element) =>
    element.textContent?.includes(label),
  );
  if (option === undefined) throw new Error(`no option labelled ${label}`);
  act(() => {
    // Base UI items arm mouse selection on pointerdown, then commit on click.
    option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    option.dispatchEvent(
      new PointerEvent("click", { bubbles: true, cancelable: true, pointerType: "mouse", detail: 1 }),
    );
  });
}

describe("InvoicesPage filters", () => {
  it("sends no filter initially, then narrows by kind and clears it again", async () => {
    const page = await mountPage();

    // unfiltered: both rows, and the first request carries no filter at all
    expect(page.numbers()).toEqual(["INV-0001", "INV-0002"]);
    expect(requests[0]).toEqual({ kind: undefined, status: undefined, limit: 10, offset: 0 });

    // apply: the request narrows and the list follows
    await choose("invoices-kind-filter", i18n.t("invoicesFilterSale"));
    await waitFor(() => page.numbers().length === 1);
    expect(requests.at(-1)?.kind).toBe("SALE");
    expect(page.numbers()).toEqual(["INV-0001"]);

    // clear through the empty-valued "All" option: the parameter must disappear
    await choose("invoices-kind-filter", i18n.t("invoicesFilterAll"));
    await waitFor(() => page.numbers().length === 2);
    expect(requests.at(-1)?.kind).toBeUndefined();
    expect(page.numbers()).toEqual(["INV-0001", "INV-0002"]);
  });

  it("narrows by payment status and clears it again", async () => {
    const page = await mountPage();

    await choose("invoices-status-filter", i18n.t("invoicesStatusPaid"));
    await waitFor(() => page.numbers().length === 1);
    expect(requests.at(-1)?.status).toBe("PAID");
    expect(page.numbers()).toEqual(["INV-0002"]);

    await choose("invoices-status-filter", i18n.t("invoicesStatusAll"));
    await waitFor(() => page.numbers().length === 2);
    expect(requests.at(-1)?.status).toBeUndefined();
  });
});
