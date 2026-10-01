import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { Party, PartyListItem, PartyRole } from "@dokan/contracts";

import { DeletePartyDialog, PartyFormDialog } from "@/components/parties/party-forms";
import { filterParties } from "@/components/parties/party-match";
import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { orpc } from "../lib/rpc";
import { tError } from "../lib/i18n";

/** Name cell links to the role's full detail page (Q7: a page, not a modal). */
function PartyNameLink({ role, row }: { role: PartyRole; row: PartyListItem }) {
  if (role === "customer") {
    return (
      <Link to="/customers/$partyId" params={{ partyId: row.id }} className="font-medium underline-offset-4 hover:underline" data-testid="party-row-link">
        {row.name}
      </Link>
    );
  }
  return (
    <Link to="/suppliers/$partyId" params={{ partyId: row.id }} className="font-medium underline-offset-4 hover:underline" data-testid="party-row-link">
      {row.name}
    </Link>
  );
}

/** The role switch keeps the two lists on one page component (issue 120 Q6). */
function RoleTabs({ role }: { role: PartyRole }) {
  const { t } = useTranslation();
  const tabClass = (active: boolean) =>
    active
      ? "-mb-px rounded-t border-b-2 border-primary px-3 py-2 text-sm font-medium text-foreground transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      : "-mb-px rounded-t border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
  return (
    <nav className="mt-4 flex gap-1 border-b border-border" aria-label={t("navCustomers")} data-testid="party-role-tabs">
      <Link to="/customers" aria-current={role === "customer" ? "page" : undefined} className={tabClass(role === "customer")} data-testid="party-role-customer">
        {t("customersTitle")}
      </Link>
      <Link to="/suppliers" aria-current={role === "supplier" ? "page" : undefined} className={tabClass(role === "supplier")} data-testid="party-role-supplier">
        {t("suppliersTitle")}
      </Link>
    </nav>
  );
}

/**
 * Customers & suppliers list (issue 120). One component serves both roles:
 * search, the table (name, phone, invoice count, remaining), create/edit and
 * the delete rule (hard delete only at zero invoices — the button is disabled
 * otherwise). Clicking a name opens the role's full detail page.
 */
export function PartiesPage({ role }: { role: PartyRole }) {
  const { t } = useTranslation();
  // both queries declared unconditionally; the role enables exactly one
  const customerList = useQuery({ ...orpc.customersList.queryOptions(), enabled: role === "customer" });
  const supplierList = useQuery({ ...orpc.suppliersList.queryOptions(), enabled: role === "supplier" });
  const list = role === "customer" ? customerList : supplierList;

  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Party | null>(null);
  const [deleting, setDeleting] = useState<Party | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const rows = useMemo(() => filterParties(list.data?.items ?? [], search), [list.data, search]);
  const totalRemaining = rows.reduce((sum, row) => sum + row.stats.remainingAmount, 0);
  const title = t(role === "customer" ? "customersTitle" : "suppliersTitle");

  function closeDialogs() {
    setCreateOpen(false);
    setEditing(null);
  }

  return (
    <section data-testid={`parties-page-${role}`}>
      <h1 className="text-xl font-bold">{title}</h1>
      <RoleTabs role={role} />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          className="h-9 min-w-56 flex-1 rounded-lg border border-input bg-background px-3 text-sm"
          type="search"
          placeholder={t("partiesSearchPlaceholder")}
          aria-label={t("partiesSearchPlaceholder")}
          autoComplete="off"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          data-testid="parties-search"
        />
        <Button onClick={() => setCreateOpen(true)} data-testid="party-new">
          {t(role === "customer" ? "partyNewCustomer" : "partyNewSupplier")}
        </Button>
      </div>

      {notice !== null && (
        <p className="mt-3 rounded border border-success/30 bg-success/10 p-2 text-sm text-success" role="status" data-testid="parties-notice">
          {notice}
        </p>
      )}

      <div className="mt-4">
        {list.isPending ? (
          <div className="grid gap-2" data-testid="parties-loading">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : list.isError ? (
          <p className="rounded border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive" role="alert" data-testid="parties-error">
            {tError(list.error.message)}
          </p>
        ) : rows.length === 0 ? (
          <div data-testid="parties-empty">
            {search.trim() === "" ? (
              <EmptyState
                title={t(role === "customer" ? "partiesEmptyCustomer" : "partiesEmptySupplier")}
                hint={t(role === "customer" ? "partiesEmptyHintCustomer" : "partiesEmptyHintSupplier")}
                action={
                  <Button size="lg" onClick={() => setCreateOpen(true)} data-testid="parties-empty-new">
                    {t(role === "customer" ? "partyNewCustomer" : "partyNewSupplier")}
                  </Button>
                }
              />
            ) : (
              <p className="rounded border bg-card p-4 text-sm text-muted-foreground">{t("partyNoMatches")}</p>
            )}
          </div>
        ) : (
          <Table data-testid="parties-table">
            <TableHeader>
              <TableRow>
                <TableHead>{t("partiesColName")}</TableHead>
                <TableHead>{t("partiesColPhone")}</TableHead>
                <TableHead>{t("partiesColInvoices")}</TableHead>
                <TableHead>{t("partiesColRemaining")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("partyEdit")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const deleteBlocked = row.stats.invoiceCount > 0;
                return (
                  <TableRow key={row.id} data-testid="party-row">
                    <TableCell>
                      <PartyNameLink role={role} row={row} />
                    </TableCell>
                    <TableCell dir="ltr">{row.phone ?? t("partyNoPhone")}</TableCell>
                    <TableCell data-testid="party-row-count">{row.stats.invoiceCount}</TableCell>
                    <TableCell data-testid="party-row-remaining">
                      <Amount value={row.stats.remainingAmount} />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(row)} data-testid="party-row-edit" aria-label={`${t("partyEdit")} ${row.name}`}>
                          {t("partyEdit")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleting(row)}
                          disabled={deleteBlocked}
                          title={deleteBlocked ? t("partyDeleteBlocked") : undefined}
                          data-testid="party-row-delete"
                          aria-label={`${t("partyDelete")} ${row.name}`}
                        >
                          {t("partyDelete")}
                        </Button>
                        {/* the rule must be readable without a mouse: a disabled
                            button is skipped by focus and title is unreliable */}
                        {deleteBlocked && <span className="sr-only">{t("partyDeleteBlocked")}</span>}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {rows.length > 0 && search.trim() === "" && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="parties-total">
          {t("partiesTotalRemaining")}: <Amount value={totalRemaining} />
        </p>
      )}

      {createOpen && (
        <PartyFormDialog
          role={role}
          title={t(role === "customer" ? "partyNewCustomer" : "partyNewSupplier")}
          testId="party-create-dialog"
          onClose={closeDialogs}
          onSaved={() => {
            closeDialogs();
            setNotice(t("partySaved"));
          }}
        />
      )}

      {editing !== null && (
        <PartyFormDialog
          role={role}
          party={editing}
          title={t(role === "customer" ? "partyEditCustomer" : "partyEditSupplier")}
          testId="party-edit-dialog"
          onClose={() => setEditing(null)}
          onSaved={() => {
            closeDialogs();
            setNotice(t("partySaved"));
          }}
        />
      )}

      {deleting !== null && (
        <DeletePartyDialog
          role={role}
          party={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            setNotice(t("partyDeleted"));
          }}
        />
      )}
    </section>
  );
}
