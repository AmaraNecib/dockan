import { afterEach, describe, expect, it, mock } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly.
// SAFETY: only this flag is written; globalThis keeps every other property.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

import type { PartyListItem, PartyRole } from "@dokan/contracts";

import { PartyPicker, type PartySelection } from "./party-picker";

type PartyFixture = PartyListItem;

const EMPTY_STATS = { invoiceCount: 0, totalAmount: 0, paidAmount: 0, remainingAmount: 0 };

const ALI: PartyFixture = { id: "ali", name: "علي علي", phone: "+213555123456", createdAt: "2026-10-01T10:00:00", stats: EMPTY_STATS, accountBalance: null, accountEntryCount: null };
const OMAR: PartyFixture = { id: "omar", name: "عماره", phone: "+213555111222", createdAt: "2026-10-01T10:00:00", stats: EMPTY_STATS, accountBalance: null, accountEntryCount: null };
const SUPPLIER_ALI: PartyFixture = { id: "sup-ali", name: "علي علي", phone: "+213555123456", createdAt: "2026-10-01T10:00:00", stats: EMPTY_STATS, accountBalance: null, accountEntryCount: null };

let parties: PartyFixture[] = [ALI, OMAR];
let suppliers: PartyFixture[] = [];
let created: Array<{ name: string; phone?: string }> = [];
let createFails = false;

mock.module("@/lib/rpc", () => ({
  orpc: {
    customersList: {
      queryOptions: () => ({ queryKey: ["customers"], queryFn: async () => ({ items: parties }) }),
      queryKey: () => ["customers"],
    },
    suppliersList: {
      queryOptions: () => ({ queryKey: ["suppliers"], queryFn: async () => ({ items: suppliers }) }),
      queryKey: () => ["suppliers"],
    },
    customersCreate: {
      mutationOptions: () => ({
        mutationFn: async (input: { name: string; phone?: string }) => {
          created.push(input);
          if (createFails) throw new Error("CUSTOMER_PHONE_EXISTS");
          return { id: `new-${created.length}`, name: input.name, phone: input.phone ?? null, createdAt: "2026-10-01T11:00:00" };
        },
      }),
    },
    suppliersCreate: {
      mutationOptions: () => ({ mutationFn: async () => ({ id: "s-new", name: "مورد", phone: null, createdAt: "2026-10-01T11:00:00" }) }),
    },
  },
  rpcClient: {},
}));

const mounted: Array<{ root: Root; host: HTMLElement; queryClient: QueryClient }> = [];

function Harness({ role = "customer" }: { role?: PartyRole }) {
  const [value, setValue] = useState<PartySelection>({ id: null, name: "" });
  return (
    <div>
      <PartyPicker role={role} label={role === "customer" ? "الزبون" : "المورّد"} value={value} onChange={setValue} testId="picker" />
      <output data-testid="selection">{`${value.id ?? "none"}|${value.name}`}</output>
      <output data-testid="needs-choice">{value.needsChoice === true ? "needs" : "ok"}</output>
    </div>
  );
}

async function mount(role: PartyRole = "customer"): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Harness role={role} />
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  mounted.push({ root, host, queryClient });
  return host;
}

function setElementValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function type(host: HTMLElement, testId: string, value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  if (input === null) throw new Error(`missing input ${testId}`);
  await act(async () => {
    setElementValue(input, value);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(host: HTMLElement, testId: string): Promise<void> {
  const button = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (button === null) throw new Error(`missing button ${testId}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const selection = (host: HTMLElement): string => host.querySelector('[data-testid="selection"]')?.textContent ?? "";
const choiceState = (host: HTMLElement): string => host.querySelector('[data-testid="needs-choice"]')?.textContent ?? "";
const optionNames = (host: HTMLElement): string[] =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('[data-testid="picker-option"]')).map((button) => button.textContent ?? "");

afterEach(async () => {
  for (const { root, host, queryClient } of mounted.splice(0)) {
    await act(async () => root.unmount());
    queryClient.clear();
    host.remove();
  }
  parties = [ALI, OMAR];
  suppliers = [];
  created = [];
  createFails = false;
});

describe("PartyPicker (issue 120)", () => {
  it("filters by name as the owner types and picking reports the record id", async () => {
    const host = await mount();
    await type(host, "picker", "علي");

    expect(optionNames(host).some((text) => text.includes("علي علي"))).toBe(true);
    await click(host, "picker-option");
    expect(selection(host)).toBe("ali|علي علي");
  });

  it("filters by phone in local spelling and picks the owning record", async () => {
    const host = await mount();
    await type(host, "picker", "05551234");

    expect(optionNames(host).some((text) => text.includes("علي علي"))).toBe(true);
    // the option reads the owner's local form, never the stored +213 value
    expect(optionNames(host).some((text) => text.includes("0555123456"))).toBe(true);
    expect(optionNames(host).some((text) => text.includes("+213"))).toBe(false);
    expect(optionNames(host).some((text) => text.includes("عماره"))).toBe(false);
    await click(host, "picker-option");
    expect(selection(host)).toBe("ali|علي علي");
  });

  it("clears the picked id when the text is edited again", async () => {
    const host = await mount();
    await type(host, "picker", "علي");
    await click(host, "picker-option");
    expect(selection(host)).toBe("ali|علي علي");

    await type(host, "picker", "علي علي محمد");
    expect(selection(host)).toBe("none|علي علي محمد");
  });

  it("offers inline create when nothing matches and reports the created record", async () => {
    const host = await mount();
    await type(host, "picker", "يوسف");
    expect(host.querySelector('[data-testid="picker-no-match"]')).not.toBeNull();

    await click(host, "picker-create");
    const nameInput = host.querySelector<HTMLInputElement>('[data-testid="picker-create-name"]');
    expect(nameInput?.value).toBe("يوسف");

    await click(host, "picker-create-save");
    expect(created).toEqual([{ name: "يوسف" }]);
    expect(selection(host)).toBe("new-1|يوسف");
  });

  it("prefills the phone field for a phone-looking query", async () => {
    const host = await mount();
    await type(host, "picker", "0666111222");
    await click(host, "picker-create");

    const nameInput = host.querySelector<HTMLInputElement>('[data-testid="picker-create-name"]');
    const phoneInput = host.querySelector<HTMLInputElement>('[data-testid="picker-create-phone"]');
    expect(nameInput?.value).toBe("");
    expect(phoneInput?.value).toBe("0666111222");
  });

  it("warns on a duplicate name with a different phone and offers the existing record", async () => {
    const host = await mount();
    await type(host, "picker", "عماره");
    await click(host, "picker-create");

    const warning = host.querySelector('[data-testid="picker-duplicate"]');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain("عماره");

    await click(host, "picker-pick-duplicate");
    expect(selection(host)).toBe("omar|عماره");
  });

  it("warns for a variant spelling of a stored name and still creates the second record (#130)", async () => {
    const host = await mount();
    // «على علي» is the stored «علي علي» with an alef maqsura (ى vs ي)
    await type(host, "picker", "على علي");

    // a variant spelling is the advisory warning, never the exact-name gate
    expect(choiceState(host)).toBe("ok");

    await click(host, "picker-create");
    const warning = host.querySelector('[data-testid="picker-duplicate"]');
    expect(warning).not.toBeNull();
    // the warning names the STORED spelling and its phone, not the typed text
    expect(warning?.textContent).toContain("علي علي");
    expect(warning?.textContent).toContain("0555123456");

    // the owner can still proceed: the save stays enabled and creates the variant
    const save = host.querySelector<HTMLButtonElement>('[data-testid="picker-create-save"]');
    expect(save?.disabled).toBe(false);
    await click(host, "picker-create-save");
    expect(created).toEqual([{ name: "على علي" }]);
    expect(selection(host)).toBe("new-1|على علي");
  });

  it("refuses a non-numeric phone in the inline create panel (issue 129)", async () => {
    const host = await mount();
    await type(host, "picker", "زبون-نص");
    await click(host, "picker-create");
    await type(host, "picker-create-phone", "abc");

    const save = host.querySelector<HTMLButtonElement>('[data-testid="picker-create-save"]');
    expect(save?.disabled).toBe(true);
    expect(host.querySelector('[data-testid="picker-invalid-phone"]')?.textContent).toContain("أرقام");

    await click(host, "picker-create-save");
    expect(created).toEqual([]);
  });

  it("accepts Arabic-Indic digits in the inline create panel (issue 129)", async () => {
    const host = await mount();
    await type(host, "picker", "زبون-عربي");
    await click(host, "picker-create");
    await type(host, "picker-create-phone", "٠٦٦٦٩٩٩٨٨٨");
    await click(host, "picker-create-save");

    expect(created).toEqual([{ name: "زبون-عربي", phone: "٠٦٦٦٩٩٩٨٨٨" }]);
  });

  it("keeps an empty phone valid in the inline create panel (optional field)", async () => {
    const host = await mount();
    await type(host, "picker", "زبون-بلا-هاتف");
    await click(host, "picker-create");
    await type(host, "picker-create-phone", "   ");

    expect(host.querySelector('[data-testid="picker-invalid-phone"]')).toBeNull();
    await click(host, "picker-create-save");
    expect(created).toEqual([{ name: "زبون-بلا-هاتف" }]);
  });

  it("resolves a folded match to the existing debtor when the owner picks it (#130)", async () => {
    const host = await mount();
    await type(host, "picker", "على علي");
    await click(host, "picker-create");

    // the money path: the warning's button selects the STORED record, so the
    // sale lands on the existing debtor instead of a second one
    await click(host, "picker-pick-duplicate");
    expect(selection(host)).toBe("ali|علي علي");
    expect(created).toEqual([]);
  });

  it("does not warn for a name that differs by a real letter (#130)", async () => {
    const host = await mount();
    await type(host, "picker", "علا علي");
    await click(host, "picker-create");

    expect(host.querySelector('[data-testid="picker-duplicate"]')).toBeNull();
  });

  it("warns for a variant spelling on the supplier picker too (shared path, #130)", async () => {
    suppliers = [SUPPLIER_ALI];
    const host = await mount("supplier");
    await type(host, "picker", "على علي");
    await click(host, "picker-create");

    expect(host.querySelector('[data-testid="picker-duplicate"]')?.textContent).toContain("علي علي");
  });

  it("does not offer a variant debtor when the typed spelling is already stored without a phone (#189 review)", async () => {
    parties = [
      { ...ALI, id: "exact", name: "علي علي", phone: null },
      { ...ALI, id: "variant", name: "على علي", phone: null },
    ];
    const host = await mount();
    await type(host, "picker", "علي علي");

    // the exact phoneless record is the needs-choice case, not a duplicate...
    expect(choiceState(host)).toBe("needs");
    await click(host, "picker-create");
    // ...and the create panel must not warn about the OTHER debtor, whose
    // one-click pick would move the sale's balance there
    expect(host.querySelector('[data-testid="picker-duplicate"]')).toBeNull();
    // opening the panel must not clear the identity gate either: it is the only
    // thing left refusing a typed-only submit for this spelling
    expect(choiceState(host)).toBe("needs");
    expect(host.querySelector('[data-testid="picker-needs-choice"]')).not.toBeNull();
  });

  it("blocks creating with a phone another record owns and offers that record instead", async () => {
    const host = await mount();
    await type(host, "picker", "شخص جديد");
    await click(host, "picker-create");
    await type(host, "picker-create-phone", "0555123456");

    const owner = host.querySelector('[data-testid="picker-phone-owner"]');
    expect(owner).not.toBeNull();
    expect(owner?.textContent).toContain("علي علي");
    const save = host.querySelector<HTMLButtonElement>('[data-testid="picker-create-save"]');
    expect(save?.disabled).toBe(true);

    await click(host, "picker-pick-owner");
    expect(selection(host)).toBe("ali|علي علي");
    expect(created).toEqual([]);
  });

  it("submits the inline create form with Enter", async () => {
    const host = await mount();
    await type(host, "picker", "يوسف");
    await click(host, "picker-create");

    const form = host.querySelector<HTMLFormElement>('[data-testid="picker-create-panel"]');
    await act(async () => {
      form?.requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(created).toEqual([{ name: "يوسف" }]);
    expect(selection(host)).toBe("new-1|يوسف");
  });

  it("moves the active option with the keyboard and closes on Escape", async () => {
    const host = await mount();
    const input = host.querySelector<HTMLInputElement>('[data-testid="picker"]');
    if (input === null) throw new Error("missing picker input");
    await act(async () => {
      setElementValue(input, "ع");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.querySelector('[data-testid="picker-menu"]')).not.toBeNull();

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(selection(host)).toBe("ali|علي علي");

    // Escape closes the menu without changing the selection
    await act(async () => {
      setElementValue(input, "ع");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.querySelector('[data-testid="picker-menu"]')).toBeNull();
  });

  it("requires an explicit choice when the typed name exactly matches a record", async () => {
    const host = await mount();
    await type(host, "picker", "علي علي");

    // the exact name is a real record: typed-only would split the balance
    expect(choiceState(host)).toBe("needs");
    expect(host.querySelector('[data-testid="picker-needs-choice"]')).not.toBeNull();

    await click(host, "picker-option");
    expect(choiceState(host)).toBe("ok");
    expect(selection(host)).toBe("ali|علي علي");
  });

  it("keeps typed-only valid when no record matches the name", async () => {
    const host = await mount();
    await type(host, "picker", "اسم غير مسجّل");
    expect(choiceState(host)).toBe("ok");
    expect(selection(host)).toBe("none|اسم غير مسجّل");
  });

  it("sees through a bidi mark when deciding an exact name match", async () => {
    const host = await mount();
    await type(host, "picker", "علي علي\u061C");
    expect(choiceState(host)).toBe("needs");
  });

  it("surfaces a server refusal in the create panel", async () => {
    createFails = true;
    const host = await mount();
    await type(host, "picker", "يوسف");
    await click(host, "picker-create");
    await click(host, "picker-create-save");

    const error = host.querySelector('[data-testid="picker-create-error"]');
    expect(error?.textContent).toContain("رقم الهاتف مستعمل مع زبون آخر");
    expect(selection(host)).toBe("none|يوسف");
  });
});
