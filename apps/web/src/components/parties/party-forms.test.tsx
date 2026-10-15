import { afterEach, describe, expect, it, mock } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly.
// SAFETY: only this flag is written; globalThis keeps every other property.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

import type { Party } from "@dokan/contracts";

import { PartyForm } from "./party-forms";

const updates: Array<{ id: string; name?: string; phone?: string | null }> = [];
const created: Array<{ name: string; phone?: string }> = [];
const saved: Array<{ name: string; mode: string }> = [];

interface MutationOptions {
  onSuccess?: (party: Party) => void;
  onError?: (error: { message?: string }) => void;
}

const partyFrom = (input: { id?: string; name: string; phone?: string | null }): Party => ({
  id: input.id ?? "new-1",
  name: input.name,
  phone: input.phone ?? null,
  createdAt: "2026-10-01T10:00:00",
});

mock.module("@/lib/rpc", () => ({
  orpc: {
    customersCreate: {
      mutationOptions: (opts?: MutationOptions) => ({
        mutationFn: async (input: { name: string; phone?: string }) => {
          created.push(input);
          return partyFrom(input);
        },
        ...opts,
      }),
    },
    suppliersCreate: { mutationOptions: (opts?: MutationOptions) => ({ mutationFn: async () => partyFrom({ name: "s" }), ...opts }) },
    customersUpdate: {
      mutationOptions: (opts?: MutationOptions) => ({
        mutationFn: async (input: { id: string; name?: string; phone?: string | null }) => {
          updates.push(input);
          return partyFrom({ id: input.id, name: input.name ?? "علي", phone: input.phone });
        },
        ...opts,
      }),
    },
    suppliersUpdate: { mutationOptions: (opts?: MutationOptions) => ({ mutationFn: async () => partyFrom({ name: "s" }), ...opts }) },
  },
  rpcClient: {},
}));

const BASE: Party = { id: "c-1", name: "علي", phone: "+213555123456", createdAt: "2026-10-01T10:00:00" };

const mounted: Array<{ root: Root; host: HTMLElement }> = [];

/** Renders the form with a party prop the test can change (concurrent edit). */
function Harness({ initial }: { initial: Party }) {
  const [party, setParty] = useState(initial);
  return (
    <div>
      <PartyForm role="customer" party={party} onSaved={(savedParty, mode) => saved.push({ name: savedParty.name, mode })} />
      <button type="button" data-testid="change-name" onClick={() => setParty((current) => ({ ...current, name: `${current.name} محدّث` }))}>
        change name
      </button>
      <button type="button" data-testid="change-phone" onClick={() => setParty((current) => ({ ...current, phone: "+213555999999" }))}>
        change phone
      </button>
    </div>
  );
}

async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Harness initial={BASE} />
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  mounted.push({ root, host });
  return host;
}

function setElementValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function click(host: HTMLElement, testId: string): Promise<void> {
  const button = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (button === null) throw new Error(`missing ${testId}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function submit(host: HTMLElement): Promise<void> {
  const form = host.querySelector<HTMLFormElement>('[data-testid="party-form"]');
  if (form === null) throw new Error("missing form");
  await act(async () => {
    form.requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  updates.length = 0;
  created.length = 0;
  saved.length = 0;
  document.body.innerHTML = "";
});

describe("PartyForm concurrent edits (issue 120, Greptile P1.2)", () => {
  it("refreshes a field the operator has not touched when the record changes elsewhere", async () => {
    const host = await mount();
    expect(host.querySelector<HTMLInputElement>('[data-testid="party-form-name"]')?.value).toBe("علي");

    await click(host, "change-name");
    expect(host.querySelector<HTMLInputElement>('[data-testid="party-form-name"]')?.value).toBe("علي محدّث");
  });

  it("keeps the operator's edit when the record changes elsewhere", async () => {
    const host = await mount();
    const name = host.querySelector<HTMLInputElement>('[data-testid="party-form-name"]');
    await act(async () => {
      if (name !== null) setElementValue(name, "علي المعدّل");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await click(host, "change-name");
    expect(host.querySelector<HTMLInputElement>('[data-testid="party-form-name"]')?.value).toBe("علي المعدّل");
  });

  it("submits only the field the operator changed", async () => {
    const host = await mount();
    const phone = host.querySelector<HTMLInputElement>('[data-testid="party-form-phone"]');
    await act(async () => {
      if (phone !== null) setElementValue(phone, "0666111222");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await submit(host);

    // the canonical identity is what gets sent
    expect(updates).toEqual([{ id: "c-1", phone: "+213666111222" }]);
  });

  it("treats the same phone in another valid format as unchanged", async () => {
    const host = await mount();
    const phone = host.querySelector<HTMLInputElement>('[data-testid="party-form-phone"]');
    await act(async () => {
      // local spelling of the stored +213555123456
      if (phone !== null) setElementValue(phone, "0555 12 34 56");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await submit(host);

    expect(updates).toEqual([]);
    expect(saved).toEqual([{ name: "علي", mode: "updated" }]);
  });

  it("shows the stored +213 phone in local form and round-trips it unchanged", async () => {
    const host = await mount();
    const phone = host.querySelector<HTMLInputElement>('[data-testid="party-form-phone"]');
    // the edit field reads the owner's local form, not the stored canonical value
    expect(phone?.value).toBe("0555123456");
    await submit(host);
    // the unchanged local form normalises back to the same canonical identity,
    // so no write is sent and the stored +213 value is preserved
    expect(updates).toEqual([]);
    expect(saved).toEqual([{ name: "علي", mode: "updated" }]);
  });

  it("refreshes an untouched phone to the local form when the record changes elsewhere", async () => {
    const host = await mount();
    await click(host, "change-phone");
    expect(host.querySelector<HTMLInputElement>('[data-testid="party-form-phone"]')?.value).toBe("0555999999");
  });

  it("does not write when nothing changed", async () => {
    const host = await mount();
    await submit(host);

    expect(updates).toEqual([]);
    expect(saved).toEqual([{ name: "علي", mode: "updated" }]);
  });
});

describe("PartyForm phone text rule (issue 129)", () => {
  it("refuses a non-numeric phone with clear Arabic copy and sends nothing", async () => {
    const host = await mount();
    const phone = host.querySelector<HTMLInputElement>('[data-testid="party-form-phone"]');
    await act(async () => {
      if (phone !== null) setElementValue(phone, "abc");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await submit(host);

    expect(updates).toEqual([]);
    expect(host.querySelector('[data-testid="party-form-error"]')?.textContent).toContain("أرقام");
  });

  it("accepts Arabic-Indic digits and sends the canonical identity", async () => {
    const host = await mount();
    const phone = host.querySelector<HTMLInputElement>('[data-testid="party-form-phone"]');
    await act(async () => {
      if (phone !== null) setElementValue(phone, "٠٦٦٦٩٩٩٨٨٨");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await submit(host);

    expect(updates).toEqual([{ id: "c-1", phone: "+213666999888" }]);
  });
});
