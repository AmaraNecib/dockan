import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";

import type { PartyCreate, PartyRole } from "@dokan/contracts";

import { Button } from "@/components/ui/button";
import { orpc } from "@/lib/rpc";
import { tError } from "@/lib/i18n";
import { duplicateNameParty, filterParties, partyQueryLooksLikePhone, phoneMatchParty } from "./party-match";

/** What the invoice form needs: a known record id, or a typed-only name. */
export interface PartySelection {
  id: string | null;
  name: string;
}
interface PartyPickerProps {
  role: PartyRole;
  /** the visible form label (Arabic); the picker owns the layout */
  label: string;
  value: PartySelection;
  onChange: (next: PartySelection) => void;
  disabled?: boolean;
  /** base data-testid: the combobox gets exactly this, its parts `${testId}-…` */
  testId: string;
}

/**
 * Customer/supplier picker for the sale and purchase forms (issue 120).
 *
 * One combobox filters the role's list by name or phone as the owner types;
 * picking a row reports `{ id, name }` and typing again clears the id (a typed
 * name is not a record). When nothing fits, an inline create panel captures the
 * name and an optional phone with the invoice; it warns when a same-name record
 * carries a different phone and refuses a phone another record already owns.
 * Both warnings offer a one-click pick of the record they name.
 *
 * Deliberately not a dialog: the owner keeps the invoice in view while picking.
 */
export function PartyPicker({ role, label, value, onChange, disabled = false, testId }: PartyPickerProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const inputId = `${testId}-input`;
  const listId = `${testId}-list`;

  // Both lists are declared unconditionally (hooks rule); the role enables one.
  const customerList = useQuery({ ...orpc.customersList.queryOptions(), enabled: role === "customer" });
  const supplierList = useQuery({ ...orpc.suppliersList.queryOptions(), enabled: role === "supplier" });
  const list = role === "customer" ? customerList : supplierList;
  const customerCreate = useMutation(orpc.customersCreate.mutationOptions());
  const supplierCreate = useMutation(orpc.suppliersCreate.mutationOptions());
  const create = role === "customer" ? customerCreate : supplierCreate;

  const [query, setQuery] = useState(value.name);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createPhone, setCreatePhone] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const createNameRef = useRef<HTMLInputElement>(null);

  // the parent owns the selection: a reset (after save) or an external pick
  // flows back into the visible text
  useEffect(() => {
    setQuery(value.name);
  }, [value.name]);

  useEffect(() => {
    if (createOpen) createNameRef.current?.focus();
  }, [createOpen]);

  const parties = list.data?.items ?? [];
  const listReady = list.data !== undefined;
  const matches = useMemo(() => filterParties(parties, query), [parties, query]);
  const trimmedQuery = query.trim();
  const showMenu = open && trimmedQuery !== "";
  const candidatePhone = createPhone.trim() === "" ? null : createPhone.trim();
  const phoneOwner = phoneMatchParty(candidatePhone, parties);
  const duplicate = duplicateNameParty(createName, candidatePhone, parties);
  const createDisabled = create.isPending || createName.trim() === "" || phoneOwner !== undefined;

  function pick(party: { id: string; name: string }) {
    onChange({ id: party.id, name: party.name });
    setQuery(party.name);
    setOpen(false);
    setCreateOpen(false);
    setActiveIndex(null);
  }

  function handleQueryChange(next: string) {
    setQuery(next);
    setOpen(true);
    setCreateOpen(false);
    setActiveIndex(null);
    setCreateError(null);
    // typing invalidates a previous pick: the text is a typed name again
    if (value.id !== null || next !== value.name) onChange({ id: null, name: next });
  }

  function openCreate() {
    // a phone-looking query lands in the phone field, not the name
    const looksLikePhone = partyQueryLooksLikePhone(trimmedQuery);
    setCreateName(looksLikePhone ? "" : trimmedQuery);
    setCreatePhone(looksLikePhone ? trimmedQuery : "");
    setCreateError(null);
    setCreateOpen(true);
  }

  function submitCreate() {
    const name = createName.trim();
    if (name === "") {
      setCreateError(t("partyNameRequired"));
      return;
    }
    // a present phone is unique: the store is authoritative, this is the
    // inline explanation with the owner's record offered instead
    if (phoneOwner !== undefined) {
      setCreateError(t("partyPhoneTaken", { name: phoneOwner.name }));
      return;
    }
    const input: PartyCreate = { name };
    if (candidatePhone !== null) input.phone = candidatePhone;
    create.mutate(input, {
      onSuccess: (party) => {
        void queryClient.invalidateQueries({
          queryKey: role === "customer" ? orpc.customersList.queryKey() : orpc.suppliersList.queryKey(),
        });
        pick(party);
      },
      onError: (err) => setCreateError(tError(err.message)),
    });
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (matches.length === 0) return;
      event.preventDefault();
      setOpen(true);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => {
        if (current === null) return direction === 1 ? 0 : matches.length - 1;
        return (current + direction + matches.length) % matches.length;
      });
      return;
    }
    if (event.key === "Enter" && activeIndex !== null) {
      const active = matches[activeIndex];
      if (active !== undefined) {
        event.preventDefault();
        pick(active);
      }
      return;
    }
    if (event.key === "Escape") {
      setOpen(false);
      setCreateOpen(false);
    }
  }

  const active = activeIndex !== null && activeIndex < matches.length ? matches[activeIndex] : undefined;

  return (
    <div className="grid gap-1 text-sm font-medium">
      <label htmlFor={inputId}>{label}</label>
      <div
        className="relative"
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (next !== null && event.currentTarget.contains(next)) return;
          setOpen(false);
        }}
      >
        <input
          id={inputId}
          className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
          role="combobox"
          aria-expanded={showMenu}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active !== undefined ? `${testId}-option-${active.id}` : undefined}
          autoComplete="off"
          value={query}
          disabled={disabled}
          onChange={(event) => handleQueryChange(event.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          data-testid={testId}
        />

        {showMenu && (
          <div className="absolute z-20 mt-1 w-full rounded-lg border bg-popover text-foreground shadow-lg" data-testid={`${testId}-menu`}>
            <ul id={listId} role="listbox" aria-label={label} className="max-h-52 overflow-y-auto p-1">
              {matches.map((party, index) => (
                <li key={party.id} role="presentation">
                  <button
                    type="button"
                    id={`${testId}-option-${party.id}`}
                    role="option"
                    aria-selected={activeIndex === index}
                    tabIndex={-1}
                    // keep focus in the combobox so the menu survives the click
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pick(party)}
                    className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-start text-sm ${activeIndex === index ? "bg-accent" : "hover:bg-accent/60"}`}
                    data-testid={`${testId}-option`}
                  >
                    <span>{party.name}</span>
                    <span dir="ltr" className="text-xs text-muted-foreground">
                      {party.phone ?? t("partyNoPhone")}
                    </span>
                  </button>
                </li>
              ))}
              {matches.length === 0 && listReady && (
                <li role="presentation" className="px-2 py-1.5 text-sm text-muted-foreground" data-testid={`${testId}-no-match`}>
                  {t("partyNoMatches")}
                </li>
              )}
              {!listReady && (
                <li role="presentation" className="px-2 py-1.5 text-sm text-muted-foreground" data-testid={`${testId}-loading`}>
                  {t("itemsLoading")}
                </li>
              )}
            </ul>

            <div className="border-t p-1">
              {list.isError && (
                <p className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm text-destructive" role="alert" data-testid={`${testId}-list-error`}>
                  {tError(list.error.message)}
                  <button type="button" className="underline" onClick={() => void list.refetch()}>
                    {t("itemsSearchRetry")}
                  </button>
                </p>
              )}
              {/* creating while the list has not loaded could duplicate a record the owner cannot see */}
              {!createOpen && listReady && (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm font-medium text-primary hover:bg-accent"
                  onClick={openCreate}
                  disabled={disabled}
                  data-testid={`${testId}-create`}
                >
                  <Plus size={14} aria-hidden="true" />
                  {t(role === "customer" ? "partyCreateCustomer" : "partyCreateSupplier", { name: trimmedQuery })}
                </button>
              )}
              {createOpen && (
                <div className="grid gap-2 p-2" data-testid={`${testId}-create-panel`}>
                  <label className="grid gap-1 text-sm font-medium">
                    {t("partyName")}
                    <input
                      ref={createNameRef}
                      className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
                      name="partyName"
                      autoComplete="off"
                      value={createName}
                      disabled={create.isPending}
                      onChange={(event) => {
                        setCreateName(event.target.value);
                        setCreateError(null);
                      }}
                      data-testid={`${testId}-create-name`}
                    />
                  </label>
                  <label className="grid gap-1 text-sm font-medium">
                    {t("partyPhoneOptional")}
                    <input
                      className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
                      name="partyPhone"
                      autoComplete="off"
                      dir="ltr"
                      value={createPhone}
                      disabled={create.isPending}
                      onChange={(event) => {
                        setCreatePhone(event.target.value);
                        setCreateError(null);
                      }}
                      data-testid={`${testId}-create-phone`}
                    />
                  </label>

                  {phoneOwner !== undefined && (
                    <p className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" role="alert" data-testid={`${testId}-phone-owner`}>
                      {t("partyPhoneTaken", { name: phoneOwner.name })}{" "}
                      <button type="button" className="underline" onClick={() => pick(phoneOwner)} data-testid={`${testId}-pick-owner`}>
                        {t("partyPickRecord", { name: phoneOwner.name })}
                      </button>
                    </p>
                  )}
                  {phoneOwner === undefined && duplicate !== undefined && (
                    <p className="rounded border border-warning/30 bg-warning/10 p-2 text-sm" role="status" data-testid={`${testId}-duplicate`}>
                      {t("partyDuplicateName", { name: duplicate.name, phone: duplicate.phone ?? t("partyNoPhone") })}{" "}
                      <button type="button" className="underline" onClick={() => pick(duplicate)} data-testid={`${testId}-pick-duplicate`}>
                        {t("partyPickRecord", { name: duplicate.name })}
                      </button>
                    </p>
                  )}
                  {createError !== null && (
                    <p className="text-sm text-destructive" role="alert" data-testid={`${testId}-create-error`}>
                      {createError}
                    </p>
                  )}

                  <div className="flex gap-2">
                    <Button type="button" size="sm" onClick={submitCreate} disabled={createDisabled} data-testid={`${testId}-create-save`}>
                      {create.isPending ? t("partyCreating") : t("partyCreateSave")}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setCreateOpen(false)} disabled={create.isPending}>
                      {t("dialogClose")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
