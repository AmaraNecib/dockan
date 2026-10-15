import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { Party, PartyRole, PartyUpdateInput } from "@dokan/contracts";
import { displayAlgerianPhone, isPartyPhoneText, normalizePartyPhone } from "@dokan/contracts";

import { Button } from "@/components/ui/button";
import { orpc } from "@/lib/rpc";
import { tError } from "@/lib/i18n";
import { useModalDialog } from "@/lib/use-modal-dialog";

/**
 * Every party list, detail, and the pickers must see a write immediately. A
 * local-first app has a handful of active queries, so invalidation is
 * deliberately app-wide: a missed key shows a stale debtor on another screen.
 */
export function invalidateParties(queryClient: QueryClient): void {
  void queryClient.invalidateQueries();
}

interface PartyFormProps {
  role: PartyRole;
  /** null/undefined = create; a party = edit */
  party?: Party | null;
  onSaved: (party: Party, mode: "created" | "updated") => void;
  onCancel?: () => void;
}

/**
 * The one customer/supplier form: used inside the create/edit dialogs on the
 * list page and inline in the detail page's «المعلومات» tab, so the fields and
 * the phone rule can never drift between the two surfaces.
 */
export function PartyForm({ role, party, onSaved, onCancel }: PartyFormProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(party?.name ?? "");
  // the field reads the owner's local 0-prefixed form; submit still normalises
  // it back to the canonical +213 identity, so storage never changes shape
  const [phone, setPhone] = useState(displayAlgerianPhone(party?.phone ?? ""));
  const [error, setError] = useState<string | null>(null);

  // A concurrent edit in another tab refetches the party. Refresh only the
  // fields the operator has not touched, so the form shows the current record
  // without clobbering work in progress (Greptile P1.2).
  const propName = party?.name ?? "";
  const propPhone = displayAlgerianPhone(party?.phone ?? "");
  const lastProp = useRef({ name: propName, phone: propPhone });
  useEffect(() => {
    const previous = lastProp.current;
    lastProp.current = { name: propName, phone: propPhone };
    if (previous.name === propName && previous.phone === propPhone) return;
    setName((current) => (current === previous.name ? propName : current));
    setPhone((current) => (current === previous.phone ? propPhone : current));
  }, [propName, propPhone]);

  // one mutation per role/procedure; the role picks the pair actually used
  const customerCreate = useMutation(orpc.customersCreate.mutationOptions());
  const supplierCreate = useMutation(orpc.suppliersCreate.mutationOptions());
  const customerUpdate = useMutation(orpc.customersUpdate.mutationOptions());
  const supplierUpdate = useMutation(orpc.suppliersUpdate.mutationOptions());
  const create = role === "customer" ? customerCreate : supplierCreate;
  const update = role === "customer" ? customerUpdate : supplierUpdate;
  const busy = create.isPending || update.isPending;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") {
      setError(t("partyNameRequired"));
      return;
    }
    // canonical identity, not the raw spelling: re-entering the same number in
    // a local format is not a change, so it must not write or audit (Greptile
    // finding 2)
    const cleanPhone = normalizePartyPhone(phone);
    const storedPhone = party === undefined || party === null ? undefined : normalizePartyPhone(party.phone);
    // A phone is an identity key (ADR-0007): refuse text that is not a phone
    // before it can become one and never match the real number (issue 129).
    // Only a value the operator actually changed is checked, so a record that
    // already holds legacy junk text can still be renamed — the store refuses
    // only a changed phone and the untouched value is never re-written.
    if (cleanPhone !== storedPhone && !isPartyPhoneText(phone)) {
      setError(t("partyPhoneInvalid"));
      return;
    }
    const onSuccess = (saved: Party) => {
      invalidateParties(queryClient);
      onSaved(saved, party === undefined || party === null ? "created" : "updated");
    };
    const onError = (err: { message?: string }) => setError(tError(err.message));
    if (party !== undefined && party !== null) {
      // submit only what the operator changed: an untouched field keeps
      // whatever the record holds now, so a concurrent edit is never silently
      // overwritten by a stale form value (Greptile P1.2)
      const patch: PartyUpdateInput = { id: party.id };
      if (trimmed !== party.name) patch.name = trimmed;
      if (cleanPhone !== storedPhone) patch.phone = cleanPhone;
      if (patch.name === undefined && patch.phone === undefined) {
        onSaved(party, "updated");
        return;
      }
      void update.mutate(patch, { onSuccess, onError });
      return;
    }
    void create.mutate(cleanPhone === null ? { name: trimmed } : { name: trimmed, phone: cleanPhone }, { onSuccess, onError });
  }

  return (
    <form className="grid gap-3" onSubmit={submit} data-testid="party-form">
      <label className="grid gap-1 text-sm font-medium">
        {t("partyName")}
        <input
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
          name="partyName"
          autoComplete="off"
          value={name}
          disabled={busy}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          required
          data-testid="party-form-name"
        />
      </label>
      <label className="grid gap-1 text-sm font-medium">
        {t("partyPhoneOptional")}
        <input
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
          name="partyPhone"
          autoComplete="off"
          dir="ltr"
          maxLength={32}
          value={phone}
          disabled={busy}
          onChange={(event) => {
            setPhone(event.target.value);
            setError(null);
          }}
          data-testid="party-form-phone"
        />
      </label>
      {error !== null && (
        <p className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" role="alert" data-testid="party-form-error">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy} data-testid="party-form-save">
          {busy ? t("partySaving") : t("partySave")}
        </Button>
        {onCancel !== undefined && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy} data-testid="party-form-cancel">
            {t("partyCancel")}
          </Button>
        )}
      </div>
    </form>
  );
}

interface DeletePartyDialogProps {
  role: PartyRole;
  party: Party;
  onClose: () => void;
  onDeleted: () => void;
}

interface PartyFormDialogProps {
  role: PartyRole;
  /** null/undefined = create; a party = edit */
  party?: Party | null;
  title: string;
  testId: string;
  onClose: () => void;
  onSaved: (party: Party, mode: "created" | "updated") => void;
}

/**
 * Create/edit dialog with the shared modal behavior (Escape, focus trap, focus
 * restore) so the list page does not hand-roll an aria-modal overlay that lies
 * to assistive tech. The form inside is the same PartyForm the detail page
 * renders inline.
 */
export function PartyFormDialog({ role, party, title, testId, onClose, onSaved }: PartyFormDialogProps) {
  const { panelRef } = useModalDialog<HTMLDivElement>(true, onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      data-testid={testId}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-2xl border bg-popover p-5 shadow-lg">
        <h2 className="mb-3 text-lg font-bold">{title}</h2>
        <PartyForm key={party?.id ?? "new"} role={role} party={party} onSaved={onSaved} onCancel={onClose} />
      </div>
    </div>
  );
}

/**
 * Hard-delete confirmation. The caller only opens this for a zero-invoice
 * party (the list/detail button is disabled otherwise), but the store decision
 * is still authoritative: PARTY_HAS_INVOICES renders here if a race won.
 */
export function DeletePartyDialog({ role, party, onClose, onDeleted }: DeletePartyDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { panelRef } = useModalDialog<HTMLDivElement>(true, onClose);
  const customerDelete = useMutation(orpc.customersDelete.mutationOptions());
  const supplierDelete = useMutation(orpc.suppliersDelete.mutationOptions());
  const remove = role === "customer" ? customerDelete : supplierDelete;

  function confirm() {
    remove.mutate(
      { id: party.id },
      {
        onSuccess: () => {
          // navigate away first: invalidating the still-mounted detail query
          // would refetch to NOT_FOUND and flash the error state mid-delete
          onDeleted();
          invalidateParties(queryClient);
        },
        onError: (err) => setError(tError(err.message)),
      },
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      data-testid="party-delete-dialog"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={t("partyDelete")} className="w-full max-w-md rounded-2xl border bg-popover p-5 shadow-lg">
        <h2 className="text-lg font-bold" data-testid="party-delete-title">{t("partyDeleteConfirmTitle", { name: party.name })}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("partyDeleteConfirmDesc")}</p>
        {error !== null && (
          <p className="mt-3 rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" role="alert" data-testid="party-delete-error">
            {error}
          </p>
        )}
        <div className="mt-4 flex gap-2">
          <Button variant="destructive" onClick={confirm} disabled={remove.isPending} data-testid="party-delete-confirm">
            {t("partyDelete")}
          </Button>
          <Button variant="outline" onClick={onClose} disabled={remove.isPending} data-testid="party-delete-cancel">
            {t("partyCancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
