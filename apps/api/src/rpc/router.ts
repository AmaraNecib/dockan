import { implement, ORPCError } from "@orpc/server";
import { dokanContract, normalizeBarcode, type InvoiceDetail, type InvoiceLine } from "@dokan/contracts";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config";
import { rankCatalog } from "../lib/catalog-search";
import { normalizeAlgerianPhone, phoneToUsername } from "../lib/phone";
import type { DrizzleDb } from "../db/connection";
import { users, accounts } from "../db/schema";
import type { AppLogger } from "../lib/logger";
import type { StorePort } from "../store/port";
import { PartyError } from "../store/port";
import type { BetterAuthInstance } from "../auth/auth";
import { fifoOutflowCost, historyWithRemaining, projectLedger, saleMovementTime, StockLedgerError, weightedAverageCost, COST_CORRECTION_REASON } from "../lib/stock-ledger";
import { calculateSaleTotals } from "../lib/sale-calculations";
import { computeReturnRefund, returnCapViolation } from "../lib/return-calculations";
import { allocateOldestFirst, availableSupplierCredit, splitAgainstRemaining, supplierBalance, supplierReturnSplit } from "../lib/supplier-ledger";
import { createBackup } from "../lib/backups";
import { createSetupThrottle, type SetupThrottle } from "../lib/setup-throttle";
import { tokenMatches } from "../lib/boot-token";
import { localDate, localDateTime } from "../lib/logger";

/**
 * The only preference keys a client may write. Everything else — notably
 * `ui.onboarding.completed`, which `onboardingComplete` derives from real shop
 * records — is server-owned, so a client cannot fake it.
 */
const CLIENT_WRITABLE_PREFERENCE_KEYS = new Set(["ui.sidebar.collapsed", "ui.onboarding.dismissed"]);
import type { ReportRangePreset } from "@dokan/contracts";
import { resolveBoundsWindow, resolveReportRange } from "../lib/report-ranges";
import { computeProfitReport, sortExpenses, type ProfitReportRange } from "../lib/profit-report";

export type RpcContext = { request: Request };

/** The identity a guarded procedure runs as; better-auth sessions and the
 * vault-unlocked owner both project onto it. */
type SessionIdentity = { user: { id: string } };

type RpcDeps = {
  db: DrizzleDb;
  config: AppConfig;
  logger: AppLogger;
  store: StorePort;
  auth: BetterAuthInstance;
  /** injectable so tests can drive the provisioning lockout clock; a fresh
   * in-memory limiter is created per router when omitted */
  setupThrottle?: SetupThrottle;
  /** injectable so tests can pin the server day instead of reading the wall
   * clock; the real clock is used when omitted */
  now?: () => Date;
  /**
   * Unified-vault seam (ADR-0008 §4.6). Present only when the encrypted store
   * is active. An unlocked vault authenticates the owner over the
   * `x-vault-session` header; the auth layer itself is untouched, so employee
   * logins can be added later without changing the vault.
   */
  vault?: {
    sessionMatches(token: string | null | undefined): boolean;
    ownerId(): string | undefined;
    setOwnerId(ownerId: string): void;
  };
};

/**
 * Resolve the inclusive Algeria-local window for expense listing and profit
 * reports. Precedence: an explicit preset wins; non-CUSTOM presets own their
 * window (stale custom bounds never narrow them). A CUSTOM preset or a custom
 * pair sent without a preset resolves the given bounds half-open — an absent
 * upper bound clamps to now (the contract's current-time boundary), an absent
 * lower bound opens at the beginning of records; an explicit CUSTOM with no
 * bounds at all is INVALID_RANGE. With no preset and no custom pair, bare
 * from/to bounds resolve the same half-open way; neither bound sent defaults
 * to the current month — the spec's default range. Resolved bounds must be
 * ordered, else INVALID_RANGE. One instant is read for the whole resolution
 * so a call straddling local midnight never mixes two clocks.
 */
function resolveWindow(input: {
  preset?: ReportRangePreset;
  customFrom?: string;
  customTo?: string;
  from?: string;
  to?: string;
}): ProfitReportRange {
  const now = new Date();
  // resolve the caller's bounds half-open and reject a disordered window
  const windowOrThrow = (from: string | undefined, to: string | undefined): ProfitReportRange => {
    const range = resolveBoundsWindow(from, to, now);
    if (range.from > range.to) {
      throw new ORPCError("BAD_REQUEST", { message: "INVALID_RANGE" });
    }
    return range;
  };
  if (input.preset !== undefined) {
    if (input.preset === "CUSTOM") {
      // an explicit CUSTOM window with no bounds is a caller bug — nothing to resolve
      if (input.customFrom === undefined && input.customTo === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: "INVALID_RANGE" });
      }
      return windowOrThrow(input.customFrom, input.customTo);
    }
    return resolveReportRange(input.preset, now, { from: input.customFrom, to: input.customTo });
  }
  // custom pair without a preset acts as a CUSTOM window, so a client bug
  // surfaces as a window, not as wrong-but-successful data
  if (input.customFrom !== undefined || input.customTo !== undefined) {
    return windowOrThrow(input.customFrom, input.customTo);
  }
  // preset absent: honor caller-supplied bounds, half-open; neither bound sent
  // defaults to the current month
  return windowOrThrow(input.from, input.to);
}

/** Locale-neutral token burned into NEW purchase-line corrections; the line id
 * rides as a #suffix so N corrections of one line reverse the PREVIOUS effective
 * quantity instead of re-reversing the untouched original. The ui translates it. */
const CORRECTION_REASON_PREFIX = "INVOICE_CORRECTION";

/** Corrections written before the token change carry this Arabic prefix. The
 * read path matches it too (never writes it again) so historical rows keep
 * reversing the right quantity instead of silently drifting stock. */
const LEGACY_CORRECTION_REASON_PREFIX = "تصحيح فاتورة";

/** True for both the neutral token and the pre-token Arabic prefix. */
function isCorrectionReason(reason: string): boolean {
  return reason.startsWith(CORRECTION_REASON_PREFIX) || reason.startsWith(LEGACY_CORRECTION_REASON_PREFIX);
}

/** total invoiced quantity per item across a detail's lines (description-only
 * lines carry no item and are skipped) */
function aggregateLineQuantities(lines: readonly InvoiceLine[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) {
    if (line.itemId === null) continue;
    totals.set(line.itemId, (totals.get(line.itemId) ?? 0) + line.quantity);
  }
  return totals;
}

/** uninvoiced availability for one item: Σ PURCHASE movements with ref=null,
 * minus quantities already attributed by stock_links — walked oldest-first in
 * the ledger's canonical ordering so consumption matches FIFO. One spelling
 * of "oldest first", shared with projectLedger via listStockMovements order. */
async function uninvoicedAvailability(store: StorePort, itemId: string): Promise<number> {
  const movements = await store.listStockMovements(itemId);
  const consumed = new Map<string, number>();
  for (const link of await store.listStockLinksByItem(itemId)) {
    consumed.set(link.movementId, (consumed.get(link.movementId) ?? 0) + link.quantity);
  }
  let available = 0;
  for (const movement of movements) {
    if (movement.kind !== "PURCHASE" || movement.ref !== null) continue;
    available += Math.max(0, movement.delta - (consumed.get(movement.id) ?? 0));
  }
  return available;
}

/** how much of one item's line this invoice has ALREADY attributed via
 * stock_links (pure attribution rows — no movement creation happens in
 * linking). Capping re-links at (line − already) keeps repeated calls from
 * attributing more than the line claims. */
async function alreadyAttributed(store: StorePort, invoiceId: string, itemId: string): Promise<number> {
  let total = 0;
  for (const link of await store.listStockLinksByItem(itemId)) {
    if (link.invoiceId === invoiceId) total += link.quantity;
  }
  return total;
}

/**
 * The merged Dokan router: ticket 02 owns auth (session guard), ticket 03 owns
 * categories/items procedures. Every business procedure passes requireSession;
 * error texts are stable keys the ui translates.
 */
export function createRpcRouter(deps: RpcDeps) {
  const os = implement(dokanContract).$context<RpcContext>();

  const setupThrottle = deps.setupThrottle ?? createSetupThrottle();

  const requireSession = async (context: RpcContext): Promise<SessionIdentity> => {
    // Unified vault: unlocking the vault signs the owner in for this process.
    // The token is a custom header, never a cookie, so a cross-origin page
    // cannot ride the unlocked session (CSRF is refused at the preflight).
    // Vault mode accepts ONLY this credential: a legacy password account that
    // survived a migration must not act as a second, weaker credential.
    if (deps.vault !== undefined) {
      if (deps.vault.sessionMatches(context.request.headers.get("x-vault-session"))) {
        const ownerId = deps.vault.ownerId();
        if (ownerId !== undefined) return { user: { id: ownerId } };
      }
      throw new ORPCError("UNAUTHORIZED", { message: "AUTH_REQUIRED" });
    }
    // SAFETY: getSession validates the cookie against the session store and
    // returns null for anything missing or expired
    const session = await deps.auth.api.getSession({ headers: context.request.headers });
    if (session === null) throw new ORPCError("UNAUTHORIZED", { message: "AUTH_REQUIRED" });
    // single-admin boundary: only the provisioned identity may call the store.
    // Sign-up is blocked at the http layer; this check makes the guard immune
    // to any other path that could mint a session.
    const adminUserId = await deps.store.getSetting("adminUserId");
    if (adminUserId !== session.user.id) {
      throw new ORPCError("FORBIDDEN", { message: "FORBIDDEN" });
    }
    return session;
  };

  const guarded = <T>(handler: (context: RpcContext) => Promise<T>) => async ({ context }: { context: RpcContext }): Promise<T> => {
    await requireSession(context);
    return handler(context);
  };

  /** Like guarded, but passes the procedure input through as well. */
  const guardedInput = <T, I>(handler: (input: I, context: RpcContext) => Promise<T>) => async ({
    input,
    context,
  }: { input: I; context: RpcContext }): Promise<T> => {
    await requireSession(context);
    return handler(input, context);
  };

  return {
    health: os.health.handler(() => ({ ok: true as const, version: deps.config.version })),

    // --- auth ----------------------------------------------------------------
    needsSetup: os.needsSetup.handler(async () => {
      const rows = await deps.db.select({ id: users.id }).from(users).limit(1);
      if (rows.length > 0) return { needsSetup: false, setupBlocked: false };
      // Shop records without an owner are not a fresh install: provisioning
      // refuses them, so the gate must not offer setup either. The UI needs
      // the distinction to show the refusal instead of a login form that
      // cannot succeed (ADR-0008 §4.1).
      const empty = await deps.store.databaseIsEmpty();
      return { needsSetup: empty, setupBlocked: !empty };
    }),

    firstTimeSetup: os.firstTimeSetup.handler(async ({ input }) => {
      // Order matters. On an installation that already has an owner, every
      // caller must get the same refusal. The transaction below re-checks both
      // gates to close the race; these checks only make the refusal uniform and
      // fail fast before the expensive password hash.
      const alreadySetup = await deps.db.select({ id: users.id }).from(users).limit(1);
      if (alreadySetup.length > 0) throw new ORPCError("FORBIDDEN", { message: "SETUP_ALREADY_DONE" });
      // First-run provisioning creates the owner, so it is allowed only on an
      // empty database. A database that already carries shop records but no
      // owner (a tampered or half-restored data folder) must never hand out a
      // new owner; reset goes through the recovery paths instead (ADR-0008
      // §4.1). No secret gates this: the database state does.
      if (!(await deps.store.databaseIsEmpty())) {
        throw new ORPCError("FORBIDDEN", { message: "SETUP_DATABASE_NOT_EMPTY" });
      }

      // Packaged installs only: only the shell's own webview holds the
      // one-time boot token (injected into the initial navigation). Without
      // this gate any local process that found the loopback port could claim
      // a fresh install as its own owner. Dev/e2e set no boot token and keep
      // the open gate (the server is loopback-only there).
      if (deps.config.bootToken !== undefined) {
        if (input.setupToken === undefined || !tokenMatches(input.setupToken, deps.config.bootToken)) {
          throw new ORPCError("FORBIDDEN", { message: "SETUP_TOKEN_REQUIRED" });
        }
      }

      // The password hash below is a deliberate CPU cost on a public endpoint;
      // bound the attempts so an unauthenticated caller cannot use setup as a
      // KDF amplifier. Checked after the cheap gates, before the hash.
      const throttle = setupThrottle.check();
      if (!throttle.allowed) {
        deps.logger.warn("SETUP_LOCKED", `firstTimeSetup refused while the setup lockout is active (retry in ~${Math.ceil(throttle.retryAfterMs / 1000)}s)`);
        throw new ORPCError("TOO_MANY_REQUESTS", { message: "SETUP_LOCKED" });
      }
      setupThrottle.recordAttempt();

      const phone = normalizeAlgerianPhone(input.phoneNumber);
      if (phone === null) throw new ORPCError("BAD_REQUEST", { message: "INVALID_PHONE_NUMBER" });
      const username = phoneToUsername(phone);

      // Vault mode (ADR-0008 §4.6): the passphrase already authenticated the
      // owner, so no credential account is created. The legacy path keeps the
      // password contract and refuses a setup without one.
      const vaultMode = deps.vault !== undefined;
      if (!vaultMode && input.password === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: "AUTH_PASSWORD_TOO_SHORT" });
      }

      // Hashing is the slow step and needs no lock, so it runs before the unit.
      // Vault mode skips it entirely: there is no password to hash.
      const ctx = await deps.auth.$context;
      const hashed = vaultMode ? undefined : await ctx.password.hash(input.password ?? "");

      // The "no users yet" check and every provisioning write commit as one
      // BEGIN IMMEDIATE unit. Checking before the awaited hash let two
      // concurrent setups both pass and create competing owners, and a failure
      // after the user insert left a user row that made needsSetup false, so
      // setup could never be retried while no credential worked.
      let provisionedUserId: string | undefined;
      const result = await deps.store.withTransactionImmediate(async (tx) => {
        const existing = await deps.db.select({ id: users.id }).from(users).limit(1);
        if (existing.length > 0) throw new ORPCError("FORBIDDEN", { message: "SETUP_ALREADY_DONE" });
        if (!(await tx.databaseIsEmpty())) throw new ORPCError("FORBIDDEN", { message: "SETUP_DATABASE_NOT_EMPTY" });

        const userId = randomUUID();
        await deps.db.insert(users).values({
          id: userId,
          name: input.ownerName,
          image: null,
          username,
          phoneNumber: phone,
          phoneNumberVerified: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        }).run();

        if (hashed !== undefined) {
          await deps.db.insert(accounts).values({
            id: randomUUID(),
            userId,
            accountId: userId,
            providerId: "credential",
            issuer: "local:credential",
            accessToken: null,
            refreshToken: null,
            idToken: null,
            accessTokenExpiresAt: null,
            refreshTokenExpiresAt: null,
            scope: null,
            password: hashed,
            createdAt: new Date(),
            updatedAt: new Date(),
          }).run();
        }

        await tx.updateSettings({
          storeName: input.storeName,
          storePhone: phone,
          storeAddress: input.storeAddress ?? null,
        });
        await tx.setSetting("adminUserId", userId);
        await tx.insertActivity({ type: "STORE_SETUP", summary: `STORE_SETUP ${input.storeName}` });
        provisionedUserId = userId;
        deps.logger.info("FIRST_TIME_SETUP", "owner account created", { storeName: input.storeName });
        return { ok: true as const };
      });
      // publish the owner identity only after the unit committed: a rolled-back
      // provisioning must not leave a phantom owner for the session guard
      if (provisionedUserId !== undefined) deps.vault?.setOwnerId(provisionedUserId);
      // a completed setup clears the lockout for the next boot
      setupThrottle.recordSuccess();
      return result;
    }),

    // --- categories (ticket 03) ----------------------------------------------
    categoriesList: os.categoriesList.handler(guarded(async () => ({ items: await deps.store.listCategories() }))),
    categoriesCreate: os.categoriesCreate.handler(
      guardedInput(async (input) => {
        // duplicate check lives INSIDE the serialized unit; concurrent creates
        // for the same name serialize, and the UNIQUE constraint catch below
        // translates the race into the same CONFLICT response
        try {
          return await deps.store.withTransaction(async (tx) => {
            const existing = await tx.listCategories();
            if (existing.some((c) => c.name === input.name)) {
              throw new ORPCError("CONFLICT", { message: "CATEGORY_EXISTS" });
            }
            const category = await tx.createCategory({ name: input.name });
            await tx.insertActivity({ type: "CATEGORY_CREATED", summary: `CATEGORY_CREATED ${input.name}` });
            return category;
          });
        } catch (err) {
          if (err instanceof Error && isUniqueViolation(err)) {
            throw new ORPCError("CONFLICT", { message: "CATEGORY_EXISTS" });
          }
          throw err;
        }
      }),
    ),

    // --- items (ticket 03) ---------------------------------------------------
    itemsList: os.itemsList.handler(guarded(async () => ({ items: await deps.store.listItems() }))),
    itemsCreate: os.itemsCreate.handler(
      guardedInput(async (input) => {
        const categories = await deps.store.listCategories();
        if (!categories.some((c) => c.id === input.categoryId)) {
          throw new ORPCError("BAD_REQUEST", { message: "CATEGORY_NOT_FOUND" });
        }
        const barcode = requireBarcode(input.barcode);
        // item + audit entry commit in the same transaction; a barcode race
        // serializes through the UNIQUE index and maps to the same CONFLICT
        return withBarcodeConflict(async () => {
          return deps.store.withTransaction(async (tx) => {
            const item = await tx.createItem({ ...input, barcode });
            await tx.insertActivity({ type: "ITEM_CREATED", summary: `ITEM_CREATED ${input.name}`, ref: item.id });
            return item;
          });
        });
      }),
    ),
    // unknown-scan "create with stock": item + initial stock in one unit,
    // through the same setItemStockAndCost seam the invoice flows will use
    itemsCreateWithStock: os.itemsCreateWithStock.handler(
      guardedInput(async (input) => {
        const categories = await deps.store.listCategories();
        if (!categories.some((c) => c.id === input.categoryId)) {
          throw new ORPCError("BAD_REQUEST", { message: "CATEGORY_NOT_FOUND" });
        }
        const barcode = requireBarcode(input.barcode);
        return withBarcodeConflict(() =>
          deps.store.withTransaction(async (tx) => {
            const item = await tx.createItem({ ...input, barcode });
            // Initial stock is a real ledger fact, not only a cache update;
            // otherwise a subsequent sale would see an empty FIFO history.
            await tx.insertStockMovement({
              itemId: item.id,
              kind: "MANUAL_ADJUSTMENT",
              delta: input.stockOnHand,
              unitCost: input.costPrice,
              reason: "opening",
              ref: null,
              occurredAt: item.createdAt,
            });
            await tx.setItemStockAndCost(item.id, input.stockOnHand, input.costPrice);
            await tx.insertActivity({
              type: "ITEM_CREATED",
              summary: `ITEM_CREATED_WITH_STOCK ${input.stockOnHand} ${input.name}`,
              ref: item.id,
            });
            return { ...item, stockOnHand: input.stockOnHand };
          }),
        );
      }),
    ),
    itemsUpdate: os.itemsUpdate.handler(
      guardedInput(async (input) => {
        // item + audit entry commit in the same transaction; a moved item must
        // point at a real category, like create does (FK errors are not 500s)
        return withBarcodeConflict(() =>
          deps.store.withTransaction(async (tx) => {
            if (input.categoryId !== undefined) {
              const categories = await tx.listCategories();
              if (!categories.some((category) => category.id === input.categoryId)) {
                throw new ORPCError("BAD_REQUEST", { message: "CATEGORY_NOT_FOUND" });
              }
            }
            const current = (await tx.getItemsByIds([input.id])).get(input.id);
            if (current === undefined) {
              throw new ORPCError("NOT_FOUND", { message: "ITEM_NOT_FOUND" });
            }
            // The ledger is the single source of truth for cost: a changed cost
            // appends a zero-quantity correction movement (ADR-0002) and the
            // cache is recomputed from the full ledger in the same unit, so the
            // next inflow/outflow replay reproduces the owner's edit instead of
            // discarding it. Cost never rides updateItem's direct column write.
            const nextCost = input.costPrice;
            const costChanged = nextCost !== undefined && nextCost !== current.costPrice;
            let correctedCost = current.costPrice;
            if (costChanged) {
              const movements = await tx.listStockMovements(input.id);
              // The correction's precedence is its RECORDING order, not its
              // timestamp (weightedAverageCost walks by seq and splits segments
              // at each correction). It is dated at the wall clock like any
              // other new row; a future-dated row recorded earlier still sits
              // before it, and a purchase recorded later blends from it even if
              // that purchase is dated before the future row.
              const candidate = {
                kind: "MANUAL_ADJUSTMENT" as const,
                delta: 0,
                unitCost: nextCost,
                reason: COST_CORRECTION_REASON,
                occurredAt: localDateTime(),
                seq: undefined,
              };
              await tx.insertStockMovement({
                itemId: input.id,
                kind: candidate.kind,
                delta: candidate.delta,
                unitCost: candidate.unitCost,
                reason: candidate.reason,
                ref: null,
                occurredAt: candidate.occurredAt,
              });
              correctedCost = weightedAverageCost([...movements, candidate], { fallbackUnitCost: current.costPrice });
            }
            const item = await tx.updateItem(input.id, {
              ...input,
              // cost is written through the ledger + setItemStockAndCost below
              costPrice: undefined,
              barcode: input.barcode === null ? null : requireBarcode(input.barcode),
            });
            if (item === undefined) {
              throw new ORPCError("NOT_FOUND", { message: "ITEM_NOT_FOUND" });
            }
            if (costChanged) {
              await tx.setItemStockAndCost(input.id, current.stockOnHand, correctedCost);
            }
            await tx.insertActivity({ type: "ITEM_UPDATED", summary: `ITEM_UPDATED ${item.name}`, ref: item.id });
            if (costChanged) {
              await tx.insertActivity({
                type: "ITEM_COST_CORRECTED",
                summary: `ITEM_COST_CORRECTED ${correctedCost} ${item.name}`,
                ref: item.id,
              });
            }
            return costChanged ? { ...item, costPrice: correctedCost } : item;
          }),
        );
      }),
    ),
    itemsLowStock: os.itemsLowStock.handler(guarded(async () => ({ items: await deps.store.listLowStockItems() }))),

    // --- catalog search + scanning (ticket 28) --------------------------------
    catalogSearch: os.catalogSearch.handler(
      guardedInput(async ({ query, limit }) => {
        const [items, categories] = await Promise.all([deps.store.listItems(), deps.store.listCategories()]);
        return rankCatalog(items, categories, query, limit);
      }),
    ),

    // --- stock ledger (ticket 27) ----------------------------------------------
    stockAddManual: os.stockAddManual.handler(
      guardedInput(async (input) => {
        if (input.kind === "PURCHASE" && input.delta <= 0) {
          throw new ORPCError("BAD_REQUEST", { message: "PURCHASE_REQUIRES_INFLOW" });
        }
        return deps.store.withTransaction(async (tx) => {
          const item = (await tx.getItemsByIds([input.itemId])).get(input.itemId);
          if (item === undefined) {
            throw new ORPCError("BAD_REQUEST", { message: "ITEM_NOT_FOUND" });
          }
          // inflows default to the item's current cost; outflows carry no
          // unit cost — storing one would be a misleading "fact"
          const unitCost = input.delta > 0 ? (input.unitCost ?? item.costPrice) : null;

          // validate the WHOLE projected history incl. the candidate row —
          // negative stock is rejected before anything is written
          const existing = await tx.listStockMovements(item.id);
          const candidate = {
            kind: input.kind,
            delta: input.delta,
            unitCost,
            occurredAt: input.occurredAt ?? localDateTime(),
            seq: undefined,
          };
          let stockAfter: number;
          try {
            stockAfter = projectLedger([...existing, candidate]).stockOnHand;
          } catch (err) {
            if (err instanceof StockLedgerError) {
              throw new ORPCError("BAD_REQUEST", { message: err.code });
            }
            throw err;
          }

          const movement = await tx.insertStockMovement({
            itemId: item.id,
            kind: candidate.kind,
            delta: input.delta,
            unitCost,
            reason: input.reason ?? null,
            ref: null,
            occurredAt: candidate.occurredAt,
          });

          // keep the fast path in sync. cost_price is the ADR-0002 running
          // weighted average, so after ANY write — including a backdated one
          // — we recompute it by replaying the full ledger chronologically
          // (inflows blend, outflows only reduce quantity). No special-casing
          // per insertion position; the model stays uniform.
          const newCost =
            input.delta > 0 ? weightedAverageCost([...existing, candidate]) : item.costPrice;
          await tx.setItemStockAndCost(item.id, stockAfter, newCost);
          await tx.insertActivity({ type: "STOCK_ADJUSTED", summary: `STOCK_ADJUSTED ${item.name}`, ref: item.id });
          return movement;
        });
      }),
    ),

    itemsHistory: os.itemsHistory.handler(
      guardedInput(async (input) => {
        const item = (await deps.store.getItemsByIds([input.itemId])).get(input.itemId);
        if (item === undefined) {
          throw new ORPCError("NOT_FOUND", { message: "ITEM_NOT_FOUND" });
        }
        const movements = await deps.store.listStockMovements(item.id);
        const rows = historyWithRemaining(movements).map(({ seq: _seq, ...rest }) => rest);
        const { stockOnHand } = projectLedger(movements, { fallbackUnitCost: item.costPrice });
        return { movements: rows, stockOnHand };
      }),
    ),

    // --- parties (issue 120): customers & suppliers share one code path -------
    customersList: os.customersList.handler(guarded(async () => ({ items: await deps.store.listParties("customer") }))),
    customersGet: os.customersGet.handler(
      guardedInput(async ({ id }) => {
        const detail = await deps.store.partyDetail("customer", id);
        if (detail === undefined) throw new ORPCError("NOT_FOUND", { message: "PARTY_NOT_FOUND" });
        return detail;
      }),
    ),
    customersCreate: os.customersCreate.handler(
      guardedInput(async (input) =>
        withPartyPhoneConflict("CUSTOMER_PHONE_EXISTS", () =>
          deps.store.withTransactionImmediate(async (tx) => {
            const party = await tx.createParty("customer", input);
            await tx.insertActivity({ type: "PARTY_CREATED", summary: `PARTY_CREATED CUSTOMER ${party.name}`, ref: party.id });
            return party;
          }),
        ),
      ),
    ),
    customersUpdate: os.customersUpdate.handler(
      guardedInput(async (input) =>
        withPartyPhoneConflict("CUSTOMER_PHONE_EXISTS", () =>
          deps.store.withTransactionImmediate(async (tx) => {
            const party = await tx.updateParty("customer", input.id, input);
            if (party === undefined) throw new ORPCError("NOT_FOUND", { message: "PARTY_NOT_FOUND" });
            await tx.insertActivity({ type: "PARTY_UPDATED", summary: `PARTY_UPDATED CUSTOMER ${party.name}`, ref: party.id });
            return party;
          }),
        ),
      ),
    ),
    customersDelete: os.customersDelete.handler(
      guardedInput(async ({ id }) =>
        deps.store.withTransactionImmediate(async (tx) => {
          // read the identity first so the audit row can name a row that is
          // about to stop existing
          const party = await tx.getParty("customer", id);
          if (party === undefined) throw new ORPCError("NOT_FOUND", { message: "PARTY_NOT_FOUND" });
          const result = await tx.deleteParty("customer", id);
          if (result === "HAS_INVOICES") throw new ORPCError("CONFLICT", { message: "PARTY_HAS_INVOICES" });
          if (result !== "DELETED") throw new ORPCError("NOT_FOUND", { message: "PARTY_NOT_FOUND" });
          await tx.insertActivity({ type: "PARTY_DELETED", summary: `PARTY_DELETED CUSTOMER ${party.name}`, ref: id });
          return { deleted: true as const };
        }),
      ),
    ),
    suppliersList: os.suppliersList.handler(guarded(async () => ({ items: await deps.store.listParties("supplier") }))),
    suppliersGet: os.suppliersGet.handler(
      guardedInput(async ({ id }) => {
        const detail = await deps.store.partyDetail("supplier", id);
        if (detail === undefined) throw new ORPCError("NOT_FOUND", { message: "PARTY_NOT_FOUND" });
        return detail;
      }),
    ),
    suppliersCreate: os.suppliersCreate.handler(
      guardedInput(async (input) =>
        withPartyPhoneConflict("SUPPLIER_PHONE_EXISTS", () =>
          deps.store.withTransactionImmediate(async (tx) => {
            const party = await tx.createParty("supplier", input);
            await tx.insertActivity({ type: "PARTY_CREATED", summary: `PARTY_CREATED SUPPLIER ${party.name}`, ref: party.id });
            return party;
          }),
        ),
      ),
    ),
    suppliersUpdate: os.suppliersUpdate.handler(
      guardedInput(async (input) =>
        withPartyPhoneConflict("SUPPLIER_PHONE_EXISTS", () =>
          deps.store.withTransactionImmediate(async (tx) => {
            const party = await tx.updateParty("supplier", input.id, input);
            if (party === undefined) throw new ORPCError("NOT_FOUND", { message: "PARTY_NOT_FOUND" });
            await tx.insertActivity({ type: "PARTY_UPDATED", summary: `PARTY_UPDATED SUPPLIER ${party.name}`, ref: party.id });
            return party;
          }),
        ),
      ),
    ),
    suppliersDelete: os.suppliersDelete.handler(
      guardedInput(async ({ id }) =>
        deps.store.withTransactionImmediate(async (tx) => {
          const party = await tx.getParty("supplier", id);
          if (party === undefined) throw new ORPCError("NOT_FOUND", { message: "PARTY_NOT_FOUND" });
          const result = await tx.deleteParty("supplier", id);
          if (result === "HAS_INVOICES") throw new ORPCError("CONFLICT", { message: "PARTY_HAS_INVOICES" });
          if (result !== "DELETED") throw new ORPCError("NOT_FOUND", { message: "PARTY_NOT_FOUND" });
          await tx.insertActivity({ type: "PARTY_DELETED", summary: `PARTY_DELETED SUPPLIER ${party.name}`, ref: id });
          return { deleted: true as const };
        }),
      ),
    ),

    // --- supplier account (issue 161) ----------------------------------------
    // Every money path is ONE BEGIN IMMEDIATE unit: the signed entry and the
    // invoice's paid/remaining cache move together, and the DB-level conditional
    // UPDATE is the authoritative boundary (never check-then-act).
    suppliersPay: os.suppliersPay.handler(
      guardedInput(async (input) =>
        deps.store.withTransactionImmediate(async (tx) => {
          const supplier = await tx.getParty("supplier", input.supplierId);
          if (supplier === undefined) throw new ORPCError("NOT_FOUND", { message: "PARTY_NOT_FOUND" });
          const method = input.method ?? "CASH";
          const note = input.note == null || input.note.trim() === "" ? null : input.note.trim();
          const occurredAt = localDateTime();
          const target = input.target ?? { kind: "OLDEST" as const };

          /** Attach the part that fits, keep a payment history row, and turn the
           * excess into a credit entry. */
          const payInvoice = async (invoiceId: string, amount: number): Promise<number> => {
            const detail = await tx.getInvoiceDetail(invoiceId);
            if (detail === undefined || detail.kind !== "PURCHASE" || detail.counterpartyId !== input.supplierId) {
              throw new ORPCError("BAD_REQUEST", { message: "INVOICE_NOT_PURCHASE" });
            }
            const { attached, credit } = splitAgainstRemaining(amount, detail.remainingAmount);
            if (attached > 0) {
              await tx.insertSupplierEntry({ supplierId: input.supplierId, kind: "PAYMENT", amount: attached, invoiceId: detail.id, method, note, occurredAt });
              if (!(await tx.applyPaymentToInvoice(detail.id, attached))) {
                throw new ORPCError("BAD_REQUEST", { message: "PAYMENT_EXCEEDS_REMAINING" });
              }
              await tx.insertPayment({ invoiceId: detail.id, amount: attached, method, note, paidAt: occurredAt });
            }
            return credit;
          };

          let credit = 0;
          if (target.kind === "CREDIT") {
            credit = input.amount;
          } else if (target.kind === "INVOICE") {
            // SAFETY: the contract superRefine requires an invoiceId for INVOICE
            credit = await payInvoice(target.invoiceId!, input.amount);
          } else {
            const outstanding = await tx.listOutstandingPurchaseInvoices(input.supplierId);
            const plan = allocateOldestFirst(outstanding, input.amount);
            let left = input.amount;
            for (const line of plan) {
              if (line.applied <= 0) continue;
              // allocateOldestFirst caps each applied at that invoice's
              // remaining, so the split never yields credit here; any residue
              // is the undistributed tail below
              await payInvoice(line.invoice.id, line.applied);
              left -= line.applied;
            }
            // SAFETY: plan never applies more than `amount`; any residue is credit
            credit += left;
          }
          if (credit > 0) {
            await tx.insertSupplierEntry({ supplierId: input.supplierId, kind: "PAYMENT", amount: credit, invoiceId: null, method, note, occurredAt });
          }
          await tx.insertActivity({ type: "PAYMENT_RECORDED", summary: `SUPPLIER_PAYMENT ${input.amount} ${supplier.name}`, ref: supplier.id });
          const entries = await tx.listSupplierEntries(input.supplierId);
          return { balance: supplierBalance(entries), entries };
        }),
      ),
    ),
    suppliersReturn: os.suppliersReturn.handler(
      guardedInput(async (input) =>
        deps.store.withTransactionImmediate(async (tx) => {
          const supplier = await tx.getParty("supplier", input.supplierId);
          if (supplier === undefined) throw new ORPCError("NOT_FOUND", { message: "PARTY_NOT_FOUND" });
          const occurredAt = localDateTime();
          const reason = input.reason == null || input.reason.trim() === "" ? null : input.reason.trim();
          const returnNumber = await tx.allocateSupplierReturnNumber();
          const invoiceLinked = input.invoiceId !== undefined && input.lines !== undefined;

          // Snapshot every returned line first so the header amounts and the
          // stock movements are computed from one consistent read.
          const lines: Array<{ invoiceLineId: string | null; itemId: string; description: string; quantity: number; unitCost: number; amount: number }> = [];
          let amount = 0;
          let invoiceRemaining: number | null = null;
          let invoiceId: string | null = null;
          if (invoiceLinked) {
            // SAFETY: the contract superRefine guarantees both fields here
            const detail = await tx.getInvoiceDetail(input.invoiceId!);
            if (detail === undefined || detail.kind !== "PURCHASE" || detail.counterpartyId !== input.supplierId) {
              throw new ORPCError("BAD_REQUEST", { message: "INVOICE_NOT_PURCHASE" });
            }
            const linesById = new Map(detail.lines.map((line) => [line.id, line]));
            for (const entry of input.lines!) {
              const line = linesById.get(entry.invoiceLineId);
              if (line === undefined) throw new ORPCError("BAD_REQUEST", { message: "LINE_NOT_ON_INVOICE" });
              if (line.itemId === null) throw new ORPCError("BAD_REQUEST", { message: "RETURN_LINE_NOT_RETURNABLE" });
            }
            // cap: bought minus already returned, per original line
            const already = await tx.returnedByPurchaseLine(detail.id);
            const violation = returnCapViolation(
              input.lines!,
              detail.lines.map((line) => ({ id: line.id, quantity: line.quantity })),
              already,
            );
            if (violation !== null) throw new ORPCError("BAD_REQUEST", { message: "RETURN_EXCEEDS_RETURNABLE" });
            invoiceId = detail.id;
            invoiceRemaining = detail.remainingAmount;
            for (const entry of input.lines!) {
              // SAFETY: every requested line was resolved above
              const line = linesById.get(entry.invoiceLineId)!;
              const lineAmount = entry.quantity * line.unitPrice;
              lines.push({ invoiceLineId: line.id, itemId: line.itemId!, description: line.description, quantity: entry.quantity, unitCost: line.unitPrice, amount: lineAmount });
              amount += lineAmount;
            }
          } else {
            // SAFETY: the contract superRefine guarantees the free-standing trio
            const item = (await tx.getItemsByIds([input.itemId!])).get(input.itemId!);
            if (item === undefined) throw new ORPCError("NOT_FOUND", { message: "ITEM_NOT_FOUND" });
            amount = input.amount!;
            lines.push({ invoiceLineId: null, itemId: item.id, description: item.name, quantity: input.quantity!, unitCost: item.costPrice, amount });
          }

          const split = supplierReturnSplit(amount, invoiceRemaining);
          const cashBack = input.cashBack ?? 0;

          const { id: returnId } = await tx.insertSupplierReturn({
            returnNumber,
            supplierId: input.supplierId,
            invoiceId,
            kind: invoiceLinked ? "INVOICE_LINKED" : "FREE_STANDING",
            amount,
            debtReduction: split.debtReduction,
            credit: split.credit,
            cashBack,
            reason,
            occurredAt,
          });
          for (const line of lines) {
            await tx.insertSupplierReturnLine({
              returnId,
              invoiceLineId: line.invoiceLineId,
              itemId: line.itemId,
              description: line.description,
              quantity: line.quantity,
              unitCost: line.unitCost,
              amount: line.amount,
            });
            const item = (await tx.getItemsByIds([line.itemId])).get(line.itemId);
            if (item === undefined) throw new ORPCError("NOT_FOUND", { message: "ITEM_NOT_FOUND" });
            const existing = await tx.listStockMovements(item.id);
            const candidate = { kind: "MANUAL_ADJUSTMENT" as const, delta: -line.quantity, unitCost: null, occurredAt, seq: undefined };
            let stockAfter: number;
            try {
              stockAfter = projectLedger([...existing, candidate], { fallbackUnitCost: item.costPrice }).stockOnHand;
            } catch (err) {
              if (err instanceof StockLedgerError) throw new ORPCError("BAD_REQUEST", { message: err.code });
              throw err;
            }
            await tx.insertStockMovement({ itemId: item.id, kind: "MANUAL_ADJUSTMENT", delta: -line.quantity, unitCost: null, reason: "SUPPLIER_RETURN", ref: returnId, occurredAt });
            const newCost = weightedAverageCost([...existing, candidate], { fallbackUnitCost: item.costPrice });
            await tx.setItemStockAndCost(item.id, stockAfter, newCost);
          }

          // the signed entries: the debt-reducing part names the invoice, the
          // credit part does not. A cash-back records cash received from the
          // supplier (a REFUND) and may never exceed the resulting credit.
          if (split.debtReduction > 0 && invoiceId !== null) {
            await tx.insertSupplierEntry({ supplierId: input.supplierId, kind: "RETURN", amount: split.debtReduction, invoiceId, note: reason, ref: returnNumber, occurredAt });
            if (!(await tx.applyDebtOffsetToInvoice(invoiceId, split.debtReduction))) {
              throw new ORPCError("BAD_REQUEST", { message: "RETURN_DEBT_OFFSET_REFUSED" });
            }
          }
          if (split.credit > 0) {
            await tx.insertSupplierEntry({ supplierId: input.supplierId, kind: "RETURN", amount: split.credit, invoiceId: null, note: reason, ref: returnNumber, occurredAt });
          }
          if (cashBack > 0) {
            const before = await tx.listSupplierEntries(input.supplierId);
            const availableCredit = availableSupplierCredit(supplierBalance(before));
            if (cashBack > availableCredit) throw new ORPCError("BAD_REQUEST", { message: "REFUND_EXCEEDS_CREDIT" });
            await tx.insertSupplierEntry({ supplierId: input.supplierId, kind: "REFUND", amount: cashBack, invoiceId: null, note: reason, ref: returnNumber, occurredAt });
          }
          await tx.insertActivity({ type: "RETURN_RECORDED", summary: `SUPPLIER_RETURN ${returnNumber} ${amount} ${supplier.name}`, ref: returnId });
          const entries = await tx.listSupplierEntries(input.supplierId);
          return { balance: supplierBalance(entries), entries };
        }),
      ),
    ),
    suppliersRefund: os.suppliersRefund.handler(
      guardedInput(async (input) =>
        deps.store.withTransactionImmediate(async (tx) => {
          const supplier = await tx.getParty("supplier", input.supplierId);
          if (supplier === undefined) throw new ORPCError("NOT_FOUND", { message: "PARTY_NOT_FOUND" });
          const entries = await tx.listSupplierEntries(input.supplierId);
          const availableCredit = availableSupplierCredit(supplierBalance(entries));
          if (input.amount > availableCredit) throw new ORPCError("BAD_REQUEST", { message: "REFUND_EXCEEDS_CREDIT" });
          const occurredAt = localDateTime();
          await tx.insertSupplierEntry({
            supplierId: input.supplierId,
            kind: "REFUND",
            amount: input.amount,
            invoiceId: null,
            method: input.method ?? "CASH",
            note: input.note == null || input.note.trim() === "" ? null : input.note.trim(),
            occurredAt,
          });
          await tx.insertActivity({ type: "PAYMENT_RECORDED", summary: `SUPPLIER_REFUND ${input.amount} ${supplier.name}`, ref: supplier.id });
          const next = await tx.listSupplierEntries(input.supplierId);
          return { balance: supplierBalance(next), entries: next };
        }),
      ),
    ),
    suppliersReturnsList: os.suppliersReturnsList.handler(
      guardedInput(async ({ supplierId }) => ({ items: await deps.store.listSupplierReturns({ supplierId }) })),
    ),

    // --- invoices (ticket 29: PURCHASE; ticket #30: SALE) ---------------------
    invoicesCreate: os.invoicesCreate.handler(
      guardedInput(async (input) => {
        // Resolve items and persist inside ONE serialized unit so pricing,
        // FIFO consumption, and writes all observe the same committed state.
        // Reading item snapshots before the transaction let a queued request
        // (e.g. an updateItem price change) land between the read and the
        // unit, persisting stale unitPrice/costAtSale (greptile P1). Bad ids
        // still fail before any invoice, movement, or sequence write because
        // resolution is the first thing inside the unit.
        return deps.store.withTransaction(async (tx) => {
        const itemsById = await tx.getItemsByIds(input.lines.map((line) => line.itemId));
        for (const line of input.lines) {
          if (!itemsById.has(line.itemId)) throw new ORPCError("BAD_REQUEST", { message: "ITEM_NOT_FOUND" });
        }
        // identity integrity (issue 120): a picked party must exist AND belong
        // to the invoice's role. Without this a stale picker id (party deleted
        // in another tab) or a wrong-role id would silently land as an orphan
        // the party pages can never show, while its debt stays name-grouped.
        // The resolved record's name is authoritative for the label too, so a
        // client cannot group a debt under one party and print another name.
        let partyName = input.counterpartyName ?? null;
        if (input.counterpartyId !== undefined && input.counterpartyId !== null) {
          const partyRole = input.kind === "SALE" ? "customer" : "supplier";
          const party = await tx.getParty(partyRole, input.counterpartyId);
          if (party === undefined) throw new ORPCError("BAD_REQUEST", { message: "PARTY_NOT_FOUND" });
          partyName = party.name;
        }

        if (input.kind === "SALE") {
          const discount = input.discount ??
            (input.discountType !== undefined && input.discountValue !== undefined
              ? { type: input.discountType, value: input.discountValue }
              : undefined);
          const totals = calculateSaleTotals(
            input.lines.map((line) => {
              const item = itemsById.get(line.itemId)!;
              return {
                quantity: line.quantity,
                price: {
                  defaultUnitPrice: item.sellingPrice,
                  unitPrice: line.unitPrice,
                  priceOverride: line.priceOverride,
                  priceOverrideType: line.priceOverrideType,
                  priceOverrideValue: line.priceOverrideValue,
                },
              };
            }),
            discount,
          );
          const paidAmount = input.initialPaid ?? 0;
          if (paidAmount > totals.totalAmount) throw new ORPCError("BAD_REQUEST", { message: "PAID_EXCEEDS_TOTAL" });
          const invoiceDate = input.invoiceDate ?? localDate();
          // Undated invoices keep wall-clock movement timestamps exactly as
          // before; an EXPLICIT invoiceDate backdates the stock movements too
          // (saleMovementTime bounds them), so the item history and day-level
          // stockAsOf slices agree with the invoice's business date.
          const backdated = input.invoiceDate !== undefined;
          // SAFETY: allocation is a database-atomic UPDATE inside the same
          // transaction as the invoice insert, so separate app processes
          // cannot select the same INV-#### between a read and the insert.
          const invoiceNumber = await tx.allocateInvoiceNumber();
            const invoice = await tx.insertInvoice({
              invoiceNumber,
              kind: "SALE",
              counterpartyId: input.counterpartyId ?? null,
              counterpartyName: partyName,
              invoiceDate,
              subtotalAmount: totals.subtotalAmount,
              discountType: totals.discountType,
              discountValue: totals.discountValue,
              discountAmount: totals.discountAmount,
              totalAmount: totals.totalAmount,
              paidAmount,
              remainingAmount: totals.totalAmount - paidAmount,
              notes: input.notes ?? null,
            });
            const insertedLines: InvoiceDetail["lines"] = [];
            for (const [index, line] of input.lines.entries()) {
              // SAFETY: every itemId was resolved in itemsById at the start of
              // this unit, and the map is immutable while it runs.
              const item = itemsById.get(line.itemId)!;
              const calculated = totals.lines[index]!;
              const existing = await tx.listStockMovements(item.id);
              const occurredAt = backdated ? saleMovementTime(invoiceDate, existing) : localDateTime();
              const candidate = {
                kind: "SALE" as const,
                delta: -line.quantity,
                unitCost: null,
                occurredAt,
                seq: undefined,
              };
              let costAtSale: number;
              let cogsExact: number;
              try {
                const cost = fifoOutflowCost(existing, line.quantity, { fallbackUnitCost: item.costPrice });
                costAtSale = cost.unitCost;
                cogsExact = cost.totalCost;
                projectLedger([...existing, candidate]);
              } catch (err) {
                if (err instanceof StockLedgerError) throw new ORPCError("BAD_REQUEST", { message: err.code });
                throw err;
              }
              const inserted = await tx.insertInvoiceLine({
                invoiceId: invoice.id,
                itemId: item.id,
                description: item.name,
                quantity: line.quantity,
                defaultUnitPrice: item.sellingPrice,
                unitPrice: calculated.unitPrice,
                costAtSale,
                cogsExact,
                total: calculated.grossTotal,
                discountAllocated: calculated.discountAllocated,
                netTotal: calculated.netTotal,
              });
              insertedLines.push(inserted);
              await tx.insertStockMovement({
                itemId: item.id,
                kind: "SALE",
                delta: -line.quantity,
                unitCost: null,
                reason: null,
                ref: invoice.id,
                occurredAt,
              });
              const projected = projectLedger([...existing, candidate], { fallbackUnitCost: item.costPrice });
              const newCost = weightedAverageCost([...existing, candidate], { fallbackUnitCost: item.costPrice });
              await tx.setItemStockAndCost(item.id, projected.stockOnHand, newCost);
            }
            const insertedPayments: InvoiceDetail["payments"] = [];
            if (paidAmount > 0) {
              insertedPayments.push(
                await tx.insertPayment({
                  invoiceId: invoice.id,
                  amount: paidAmount,
                  method: input.paymentMethod ?? "CASH",
                  note: null,
                  paidAt: localDateTime(),
                }),
              );
            }
            await tx.insertActivity({ type: "SALE_CREATED", summary: `SALE_CREATED ${invoiceNumber}`, ref: invoice.id });
            // a brand-new invoice has no returns yet, so no debt was relieved
            return { ...invoice, lines: insertedLines, payments: insertedPayments, returnCreditAmount: 0 } satisfies InvoiceDetail;
        }

        if (input.discount !== undefined || input.discountType !== undefined || input.discountValue !== undefined) {
          throw new ORPCError("BAD_REQUEST", { message: "DISCOUNT_ONLY_SALE" });
        }
        // Existing purchase intake behavior: omitted line prices default to the
        // item's cost because purchase prices are the stock cost basis.
        const totalAmount = input.lines.reduce((sum, line) => sum + line.quantity * (line.unitPrice ?? itemsById.get(line.itemId)!.costPrice), 0);
        const paidAmount = input.initialPaid ?? 0;
        if (paidAmount > totalAmount) throw new ORPCError("BAD_REQUEST", { message: "PAID_EXCEEDS_TOTAL" });
        const invoiceDate = input.invoiceDate ?? localDate();
          // SAFETY: allocation is a database-atomic UPDATE inside the same
          // transaction as the invoice insert, so separate app processes
          // cannot select the same INV-#### between a read and the insert.
          const invoiceNumber = await tx.allocateInvoiceNumber();
          const invoice = await tx.insertInvoice({
            invoiceNumber,
            kind: "PURCHASE",
            counterpartyId: input.counterpartyId ?? null,
            counterpartyName: partyName,
            invoiceDate,
            subtotalAmount: totalAmount,
            discountType: null,
            discountValue: null,
            discountAmount: 0,
            totalAmount,
            paidAmount,
            remainingAmount: totalAmount - paidAmount,
            notes: input.notes ?? null,
          });
          const insertedLines: InvoiceDetail["lines"] = [];
          for (const line of input.lines) {
            // SAFETY: every itemId was resolved in itemsById at the start of
            // this unit, and the map is immutable while it runs.
            const item = itemsById.get(line.itemId)!;
            const unitCost = line.unitPrice ?? item.costPrice;
            // For PURCHASE, the line price is the cost basis feeding ADR-0002.
            const inserted = await tx.insertInvoiceLine({
              invoiceId: invoice.id,
              itemId: line.itemId,
              description: item.name,
              quantity: line.quantity,
              defaultUnitPrice: item.costPrice,
              unitPrice: unitCost,
              costAtSale: unitCost,
              cogsExact: line.quantity * unitCost,
              total: line.quantity * unitCost,
              discountAllocated: 0,
              netTotal: line.quantity * unitCost,
            });
            insertedLines.push(inserted);
            const existing = await tx.listStockMovements(line.itemId);
            const candidate = { kind: "PURCHASE" as const, delta: line.quantity, unitCost, occurredAt: localDateTime(), seq: undefined };
            let stockAfter: number;
            try {
              stockAfter = projectLedger([...existing, candidate]).stockOnHand;
            } catch (err) {
              if (err instanceof StockLedgerError) throw new ORPCError("BAD_REQUEST", { message: err.code });
              throw err;
            }
            await tx.insertStockMovement({ itemId: line.itemId, kind: "PURCHASE", delta: line.quantity, unitCost, reason: null, ref: invoice.id, occurredAt: candidate.occurredAt });
            const newCost = weightedAverageCost([...existing, candidate], { fallbackUnitCost: item.costPrice });
            await tx.setItemStockAndCost(line.itemId, stockAfter, newCost);
          }
          const insertedPayments: InvoiceDetail["payments"] = [];
          if (paidAmount > 0) {
            insertedPayments.push(
              await tx.insertPayment({
                invoiceId: invoice.id,
                amount: paidAmount,
                method: input.paymentMethod ?? "CASH",
                note: null,
                paidAt: localDateTime(),
              }),
            );
          }
          await tx.insertActivity({ type: "PURCHASE_CREATED", summary: `PURCHASE_CREATED ${invoiceNumber}${partyName ? ` ${partyName}` : ""}`, ref: invoice.id });
          // Supplier account (issue 161): an id-backed purchase is a signed
          // charge, and a down payment is a signed payment entry. Typed-name
          // purchases (no supplier record) stay invoice-based like customers.
          if (input.kind === "PURCHASE" && input.counterpartyId !== undefined && input.counterpartyId !== null) {
            const occurredAt = localDateTime();
            await tx.insertSupplierEntry({
              supplierId: input.counterpartyId,
              kind: "PURCHASE",
              amount: totalAmount,
              invoiceId: invoice.id,
              occurredAt,
            });
            if (paidAmount > 0) {
              await tx.insertSupplierEntry({
                supplierId: input.counterpartyId,
                kind: "PAYMENT",
                amount: paidAmount,
                invoiceId: invoice.id,
                method: input.paymentMethod ?? "CASH",
                occurredAt,
              });
            }
          }
          // a brand-new invoice has no returns yet, so no debt was relieved
          return { ...invoice, lines: insertedLines, payments: insertedPayments, returnCreditAmount: 0 } satisfies InvoiceDetail;
        });
      }),
    ),
    invoicesGet: os.invoicesGet.handler(
      guardedInput(async ({ id }) => {
        const detail = await deps.store.getInvoiceDetail(id);
        if (detail === undefined) {
          throw new ORPCError("NOT_FOUND", { message: "INVOICE_NOT_FOUND" });
        }
        return detail;
      }),
    ),
    invoicesList: os.invoicesList.handler(guardedInput(async (filters) => deps.store.listInvoices(filters))),
    // ticket 8 — later payments in instalments. Payment row + paid/remaining
    // recompute + PAYMENT_RECORDED audit commit in ONE write-first unit, so a
    // concurrent pay or a crash mid-way can never leave paidAmount out of
    // sync with the payments history (high-assurance: amounts are never
    // allowed to exceed an invoice's remaining amount).
    invoicesPay: os.invoicesPay.handler(
      guardedInput(async (input) =>
        deps.store.withTransactionImmediate(async (tx) => {
          const detail = await tx.getInvoiceDetail(input.invoiceId);
          if (detail === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "INVOICE_NOT_FOUND" });
          }
          // the money boundary: an instalment may never exceed what is still
          // owed, exactly-remaining included (that is the settling payment).
          // The fast-fail read keeps the SQL free, but the AUTHORITATIVE guard
          // is the conditional UPDATE inside the unit (applyPaymentToInvoice
          // below), which stays atomic even if a second process races this one
          // on the same database file — no check-then-act gap survives.
          if (input.amount > detail.remainingAmount) {
            throw new ORPCError("BAD_REQUEST", { message: "PAYMENT_EXCEEDS_REMAINING" });
          }
          await tx.insertPayment({
            invoiceId: detail.id,
            amount: input.amount,
            method: input.method ?? "CASH",
            note: input.note == null || input.note.trim() === "" ? null : input.note.trim(),
            paidAt: localDateTime(),
          });
          const applied = await tx.applyPaymentToInvoice(detail.id, input.amount);
          if (!applied) {
            // the DB refused the instalment (remaining dropped below the
            // amount between our read and the write); the whole unit rolls
            // back, so the payment row above never persists
            throw new ORPCError("BAD_REQUEST", { message: "PAYMENT_EXCEEDS_REMAINING" });
          }
          // A purchase invoice paid in place is a signed supplier payment too
          // (issue 161), so the account balance stays the one truth.
          if (detail.kind === "PURCHASE" && detail.counterpartyId !== null) {
            await tx.insertSupplierEntry({
              supplierId: detail.counterpartyId,
              kind: "PAYMENT",
              amount: input.amount,
              invoiceId: detail.id,
              method: input.method ?? "CASH",
              note: input.note == null || input.note.trim() === "" ? null : input.note.trim(),
              occurredAt: localDateTime(),
            });
          }
          await tx.insertActivity({
            type: "PAYMENT_RECORDED",
            summary: `PAYMENT_RECORDED ${input.amount} ${detail.invoiceNumber}`,
            ref: detail.id,
          });
          // return the fresh header + appended history from inside the unit
          // (SAFETY: the invoice was just read in this handler; it cannot
          // vanish mid-transaction)
          return (await tx.getInvoiceDetail(detail.id))!;
        }),
      ),
    ),

    // --- returns & refunds ----------------------------------------------------
    returnsGet: os.returnsGet.handler(
      guardedInput(async ({ returnId }) => {
        const detail = await deps.store.getReturnDetail(returnId);
        if (detail === undefined) {
          throw new ORPCError("NOT_FOUND", { message: "RETURN_NOT_FOUND" });
        }
        return detail;
      }),
    ),
    // Cash refund against a past SALE. One BEGIN IMMEDIATE unit owns the whole
    // write: return record + lines + one marked SALE-reversal movement per line
    // (stock straight back in, review-pending) + the live stock/cost caches +
    // the audit entry — so a failure anywhere rolls everything back and the
    // returned goods can never half-land in the ledger.
    returnsCreate: os.returnsCreate.handler(
      guardedInput(async (input) =>
        deps.store.withTransactionImmediate(async (tx) => {
          const invoice = await tx.getInvoiceDetail(input.invoiceId);
          if (invoice === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "INVOICE_NOT_FOUND" });
          }
          if (invoice.kind !== "SALE") {
            throw new ORPCError("BAD_REQUEST", { message: "RETURN_NOT_SALE" });
          }
          const linesById = new Map(invoice.lines.map((line) => [line.id, line]));
          for (const entry of input.lines) {
            const line = linesById.get(entry.invoiceLineId);
            if (line === undefined) {
              throw new ORPCError("BAD_REQUEST", { message: "LINE_NOT_ON_INVOICE" });
            }
            if (line.itemId === null) {
              // description-only lines have no stock to return
              throw new ORPCError("BAD_REQUEST", { message: "RETURN_LINE_NOT_RETURNABLE" });
            }
          }
          // the refund cap is per invoice line: sold − already returned (the
          // sums include duplicate entries WITHIN this request, so an item
          // can never be returned past what it sold). The per-line aggregates
          // also feed the sequence-aware refund (cumulative refunded value
          // and how much of the line remains unreturned).
          const returnedByLine = await tx.returnedByLine(invoice.id);
          const alreadyReturnedQty = new Map([...returnedByLine].map(([lineId, row]) => [lineId, row.quantity]));
          // SAFETY: every requested line was resolved above, so the violation
          // check indexes the same line set the refund math uses
          const violation = returnCapViolation(
            input.lines,
            invoice.lines.map((line) => ({ id: line.id, quantity: line.quantity })),
            alreadyReturnedQty,
          );
          if (violation !== null) {
            throw new ORPCError("BAD_REQUEST", { message: "RETURN_EXCEEDS_RETURNABLE" });
          }

          // refund math reads the authoritative line snapshots (netTotal after
          // the allocated invoice discount, divided by the line's SOLD count), never
          // client-sent prices — a partial return prices at what the customer
          // paid, and the COMPLETING return settles the exact remainder so the
          // line never over-refunds cumulatively
          const refund = computeReturnRefund(
            input.lines.map((entry) => {
              const line = linesById.get(entry.invoiceLineId)!;
              return {
                invoiceLineId: entry.invoiceLineId,
                quantity: entry.quantity,
                netTotal: line.netTotal,
                lineQuantity: line.quantity,
              };
            }),
            returnedByLine,
          );
          // Settlement (owner-approved split): the owner picks how much cash to
          // hand back now; the remainder is deducted from the invoice's old
          // debt, capped so the debt can never go negative — any excess flows
          // back to cash. cashPaidOut + debtOffset always sums to the return
          // value. All-cash on an unpaid invoice is allowed (the ui warns; the
          // api only enforces the split's own bounds).
          const requestedCash = input.cashPaidOut ?? refund.refundTotal;
          if (requestedCash > refund.refundTotal) {
            throw new ORPCError("BAD_REQUEST", { message: "REFUND_SPLIT_INVALID" });
          }
          const requestedDebt = refund.refundTotal - requestedCash;
          const debtOffset = Math.min(requestedDebt, invoice.remainingAmount);
          const cashPaidOut = refund.refundTotal - debtOffset;

          // SAFETY: allocation is a database-atomic UPDATE inside the same
          // transaction as the return insert, so separate app processes
          // cannot select the same RTN-#### between a read and the insert.
          const returnNumber = await tx.allocateReturnNumber();
          const occurredAt = localDateTime();
          const { id: returnId } = await tx.insertReturn({
            returnNumber,
            invoiceId: invoice.id,
            refundAmount: refund.refundTotal,
            cashPaidOut,
            debtOffset,
            payoutMethod: input.payoutMethod ?? "CASH",
            reason: input.reason == null || input.reason.trim() === "" ? null : input.reason.trim(),
            status: "PENDING_REVIEW",
            occurredAt,
          });
          for (const lineRefund of refund.lines) {
            // SAFETY: the line was validated to have an item above; the map is immutable while it runs
            const line = linesById.get(lineRefund.invoiceLineId)!;
            const item = (await tx.getItemsByIds([line.itemId!])).get(line.itemId!);
            if (item === undefined) {
              throw new ORPCError("NOT_FOUND", { message: "ITEM_NOT_FOUND" });
            }
            await tx.insertReturnLine({
              returnId,
              invoiceLineId: line.id,
              itemId: item.id,
              description: line.description,
              quantity: lineRefund.quantity,
              refundUnitPrice: lineRefund.refundUnitPrice,
              refundAmount: lineRefund.refundAmount,
            });
            // Returned units join the FIFO layers straight away at the item's
            // current weighted average — "pure cost into the basis", no
            // special valuation (ADR-0002/0005 unchanged). One movement per
            // line, marked PENDING for the owner's review.
            const existing = await tx.listStockMovements(item.id);
            const candidate = {
              kind: "SALE" as const,
              delta: lineRefund.quantity,
              unitCost: item.costPrice,
              occurredAt,
              seq: undefined,
            };
            // an inflow can never dip stock, but the whole-history projection
            // still fails loudly on corrupt history before any write
            const stockAfter = projectLedger([...existing, candidate], { fallbackUnitCost: item.costPrice }).stockOnHand;
            await tx.insertStockMovement({
              itemId: item.id,
              kind: "SALE",
              delta: lineRefund.quantity,
              unitCost: item.costPrice,
              // visible marker in the item history: this stock-in is a return.
              // Locale-neutral key; the ui translates it (the ref carries the
              // return number).
              reason: "RETURN_RECORDED",
              ref: returnId,
              returnMark: "PENDING",
              occurredAt,
            });
            const newCost = weightedAverageCost([...existing, candidate], { fallbackUnitCost: item.costPrice });
            await tx.setItemStockAndCost(item.id, stockAfter, newCost);
          }
          // #68: the debt portion is NOT settled while the return is pending —
          // the voucher records the owner's chosen split, but the invoice keeps
          // its debt until the owner accepts the goods (a rejected return never
          // relieves it). The ledger application moves to returnsAccept.
          await tx.insertActivity({
            type: "RETURN_RECORDED",
            // locale-neutral tokens: key + data; the activity ui translates
            summary: `RETURN_RECORDED ${returnNumber} ${refund.refundTotal} ${invoice.invoiceNumber} ${debtOffset}`, 
            ref: returnId,
          });
          // SAFETY: the return was just created in this transaction; it cannot vanish
          return (await tx.getReturnDetail(returnId))!;
        }),
      ),
    ),
    returnsList: os.returnsList.handler(guardedInput(async ({ invoiceId }) => ({ items: await deps.store.listReturns({ invoiceId }) }))),
    returnsPendingCount: os.returnsPendingCount.handler(guarded(async () => ({ count: await deps.store.pendingReturnsCount() }))),
    // Review accept: consumes the pending stock mark — the returned goods are
    // confirmed salable. The ledger facts are untouched; only the review tag
    // transitions, in the same unit as the status (append-only preserved).
    returnsAccept: os.returnsAccept.handler(
      guardedInput(async (input) =>
        deps.store.withTransactionImmediate(async (tx) => {
          const existing = await tx.getReturnDetail(input.returnId);
          if (existing === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "RETURN_NOT_FOUND" });
          }
          // the conditional UPDATE is the authoritative guard: a stale read can
          // never consume the mark twice
          if (!(await tx.transitionReturnStatus(existing.id, "ACCEPTED"))) {
            throw new ORPCError("BAD_REQUEST", { message: "RETURN_NOT_PENDING" });
          }
          await tx.setReturnMarks(existing.id, "ACCEPTED");
          // #68: the promised debt offset settles NOW, capped at the debt still
          // owed — two pending returns recorded against the same debt can each
          // carry the full promise, and the first acceptance shrinks it, so the
          // second may only relieve what remains (it never pushes below zero).
          // Only an ACCEPTED return relieves debt; a rejected one never does.
          // debtOffset − debtApplied skips the portion that was already settled
          // at creation by pre-#68 builds, so an upgrade can never double-relieve.
          const acceptedInvoice = await tx.getInvoiceDetail(existing.invoiceId);
          if (acceptedInvoice !== undefined) {
            const stillPromised = Math.max(0, existing.debtOffset - existing.debtApplied);
            const applied = Math.min(stillPromised, acceptedInvoice.remainingAmount);
            // SAFETY: the read happens inside this BEGIN IMMEDIATE unit and
            // applied <= remaining, so the conditional UPDATE boundary can only
            // be tripped by corruption — the whole unit would then roll back,
            // which is why the reviewer-visible state stays consistent.
            if (applied > 0) {
              if (!(await tx.applyDebtOffsetToInvoice(existing.invoiceId, applied))) {
                throw new ORPCError("BAD_REQUEST", { message: "RETURN_DEBT_OFFSET_REFUSED" });
              }
              const totalApplied = existing.debtApplied + applied;
              await tx.setDebtApplied(existing.id, totalApplied);
            }
          }
          await tx.insertActivity({
            type: "RETURN_REVIEWED",
            // locale-neutral tokens; the activity ui translates
            summary: `RETURN_REVIEWED ${existing.returnNumber} ACCEPTED ${existing.refundAmount}`,
            ref: existing.id,
          });
          // SAFETY: the return was just read in this handler; it cannot vanish mid-transaction
          return (await tx.getReturnDetail(existing.id))!;
        }),
      ),
    ),
    // Review reject (damaged): instead of accepting, the quantity is removed
    // as a MANUAL_ADJUSTMENT outflow in the same unit that consumes the mark —
    // the shop's stock ends exactly where it was before the return, and the
    // ledger stays append-only. The removal is CLAMPED to what is actually on
    // hand (returned goods are salable immediately, so by review time some may
    // already have been resold), allocated across the return's lines of each
    // item first-come-first-served. ONE scrapping movement per RETURN LINE,
    // each carrying the line's id as a reason suffix — the profit report's
    // scrap attribution joins on that suffix so a multi-line return of one
    // item never double-attributes a movement. Reasons/summaries are
    // locale-neutral keys; the ui translates.
    returnsReject: os.returnsReject.handler(
      guardedInput(async (input) =>
        deps.store.withTransactionImmediate(async (tx) => {
          const existing = await tx.getReturnDetail(input.returnId);
          if (existing === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "RETURN_NOT_FOUND" });
          }
          if (!(await tx.transitionReturnStatus(existing.id, "REJECTED_DAMAGED"))) {
            throw new ORPCError("BAD_REQUEST", { message: "RETURN_NOT_PENDING" });
          }
          const note = input.reason && input.reason.trim() !== "" ? input.reason.trim() : null;
          const reasonKey = `RETURN_REJECTED_DAMAGED ${existing.returnNumber}${note ? ` — ${note}` : ""}`;
          if (note !== null) {
            // the review annotation lands on the return record too, so the
            // voucher and the returns list tell the full story
            await tx.setReturnReason(existing.id, existing.reason && existing.reason.trim() !== "" ? `${existing.reason} — ${note}` : note);
          }
          const occurredAt = localDateTime();
          const itemIds = [...new Set(existing.lines.flatMap((line) => (line.itemId === null ? [] : [line.itemId]))) ];
          for (const itemId of itemIds) {
            const item = (await tx.getItemsByIds([itemId])).get(itemId);
            if (item === undefined) {
              throw new ORPCError("NOT_FOUND", { message: "ITEM_NOT_FOUND" });
            }
            const linesOfItem = existing.lines.filter((line) => line.itemId === itemId);
            const returnedQty = linesOfItem.reduce((sum, line) => sum + line.quantity, 0);
            const movements = await tx.listStockMovements(item.id);
            const projection = projectLedger(movements, { fallbackUnitCost: item.costPrice });
            // clamp: never remove more than is actually in stock (some returned
            // units may already have been resold between create and review)
            const removalBudget = Math.min(returnedQty, projection.stockOnHand);
            if (removalBudget <= 0) continue;
            const candidate = {
              kind: "MANUAL_ADJUSTMENT" as const,
              delta: -removalBudget,
              unitCost: null,
              occurredAt,
              seq: undefined,
            };
            // SAFETY: the clamp guarantees the reversal never drives stock
            // negative; the whole-history projection still fails loudly on
            // corrupt history before anything is written.
            const stockAfter = projectLedger([...movements, candidate], { fallbackUnitCost: item.costPrice }).stockOnHand;
            // allocate the scrapped units across this item's return lines,
            // first-come-first-served; each line's movement carries its id as
            // the reason suffix for exact report attribution
            let remaining = removalBudget;
            for (const line of linesOfItem) {
              const take = Math.min(line.quantity, remaining);
              if (take <= 0) continue;
              await tx.insertStockMovement({
                itemId: item.id,
                kind: "MANUAL_ADJUSTMENT",
                delta: -take,
                unitCost: null,
                reason: `${reasonKey} #${line.id}`,
                ref: existing.id,
                occurredAt,
              });
              remaining -= take;
            }
            const newCost = weightedAverageCost([...movements, candidate], { fallbackUnitCost: item.costPrice });
            await tx.setItemStockAndCost(item.id, stockAfter, newCost);
          }
          await tx.setReturnMarks(existing.id, "REJECTED");
          await tx.insertActivity({
            type: "RETURN_REVIEWED",
            // locale-neutral tokens; the activity ui translates
            summary: `RETURN_REVIEWED ${existing.returnNumber} REJECTED ${existing.refundAmount}`,
            ref: existing.id,
          });
          // SAFETY: the return was just read in this handler; it cannot vanish mid-transaction
          return (await tx.getReturnDetail(existing.id))!;
        }),
      ),
    ),

    // --- purchase intake: deferred linking + corrections (ticket 29) ----------
    purchasesProposal: os.purchasesProposal.handler(
      guardedInput(async ({ invoiceId }) => {
        const detail = await deps.store.getInvoiceDetail(invoiceId);
        if (detail === undefined || detail.kind !== "PURCHASE") {
          throw new ORPCError("NOT_FOUND", { message: "INVOICE_NOT_FOUND" });
        }
        const itemsById = await deps.store.getItemsByIds(detail.lines.filter((l) => l.itemId !== null).map((l) => l.itemId!));
        const quantitiesByItem = aggregateLineQuantities(detail.lines);
        const proposalRows = [];
        for (const [itemId, lineQuantity] of quantitiesByItem) {
          const uninvoicedQty = await uninvoicedAvailability(deps.store, itemId);
          const alreadyLinked = await alreadyAttributed(deps.store, invoiceId, itemId);
          const remainingLineQty = Math.max(0, lineQuantity - alreadyLinked);
          const proposedLinkQty = Math.min(uninvoicedQty, remainingLineQty);
          proposalRows.push({
            itemId,
            itemName: itemsById.get(itemId)?.name ?? "",
            lineQuantity,
            uninvoicedQty,
            proposedLinkQty,
            // Once the line's attribution cap is consumed, there is no
            // remainder to offer even if uninvoiced stock remains available.
            remainderQty: Math.max(0, remainingLineQty - proposedLinkQty),
          });
        }
        return { invoiceId, items: proposalRows };
      }),
    ),
    purchasesLinkStock: os.purchasesLinkStock.handler(
      guardedInput(async (input) => {
        return deps.store.withTransaction(async (tx) => {
          const detail = await tx.getInvoiceDetail(input.invoiceId);
          if (detail === undefined || detail.kind !== "PURCHASE") {
            throw new ORPCError("NOT_FOUND", { message: "INVOICE_NOT_FOUND" });
          }
          const itemsById = await tx.getItemsByIds(input.allocations.map((a) => a.itemId));
          const quantitiesByItem = aggregateLineQuantities(detail.lines);
          let linked = 0;
          let remainderMoved = 0;
          for (const allocation of input.allocations) {
            const lineQuantity = quantitiesByItem.get(allocation.itemId);
            if (lineQuantity === undefined || !itemsById.has(allocation.itemId)) {
              throw new ORPCError("BAD_REQUEST", { message: "ITEM_NOT_ON_INVOICE" });
            }
            if (allocation.quantity > lineQuantity) {
              throw new ORPCError("BAD_REQUEST", { message: "LINK_EXCEEDS_LINE" });
            }
            // idempotency cap: a re-link can never attribute more than what is
            // still missing from this line (previous links count toward it)
            const attributed = await alreadyAttributed(tx, detail.id, allocation.itemId);
            let remainingToLink = Math.min(allocation.quantity, Math.max(0, lineQuantity - attributed));
            if (remainingToLink === 0) continue;
            // FIFO walk over that item's uninvoiced PURCHASE movements
            const movements = await tx.listStockMovements(allocation.itemId);
            const alreadyLinked = new Map<string, number>();
            for (const link of await tx.listStockLinksByItem(allocation.itemId)) {
              alreadyLinked.set(link.movementId, (alreadyLinked.get(link.movementId) ?? 0) + link.quantity);
            }
            for (const movement of movements) {
              if (remainingToLink === 0) break;
              if (movement.kind !== "PURCHASE" || movement.ref !== null) continue;
              const consumed = alreadyLinked.get(movement.id) ?? 0;
              const available = movement.delta - consumed;
              if (available <= 0) continue;
              const take = Math.min(available, remainingToLink);
              await tx.insertStockLink({ invoiceId: input.invoiceId, movementId: movement.id, quantity: take });
              remainingToLink -= take;
              linked += take;
            }
            // SAFETY: no new stock is minted here. invoicesCreate already
            // posted the FULL line quantity as the invoice's own PURCHASE
            // movement, so units beyond the uninvoiced pool are already in the
            // ledger — creating a "remainder" movement would double-count
            // them and overstate inventory (greptile finding). The unmatched
            // share is reported back as remainderMoved instead.
            remainderMoved += remainingToLink;
          }
          await tx.insertActivity({
            type: "STOCK_ADJUSTED",
            summary: `STOCK_LINKED ${detail.invoiceNumber}`,
            ref: detail.id,
          });
          return { linked, remainderMoved };
        });
      }),
    ),
    purchasesCorrectLine: os.purchasesCorrectLine.handler(
      guardedInput(async (input) => {
        const line = await deps.store.getInvoiceLine(input.lineId);
        if (line === undefined || line.itemId === null) {
          throw new ORPCError("NOT_FOUND", { message: "LINE_NOT_FOUND" });
        }
        const detail = await deps.store.getInvoiceDetail(line.invoiceId);
        if (detail === undefined || detail.kind !== "PURCHASE") {
          throw new ORPCError("BAD_REQUEST", { message: "INVOICE_NOT_PURCHASE" });
        }
        return deps.store.withTransaction(async (tx) => {
          const item = (await tx.getItemsByIds([line.itemId!])).get(line.itemId!);
          if (item === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "ITEM_NOT_FOUND" });
          }
          // append-only correction: reverse the PREVIOUS EFFECTIVE quantity of
          // this line (original + net of prior corrections, keyed by the
          // #lineId reason suffix), then record the corrected one. Re-reversing
          // the untouched original would double-reverse on every re-correction
          // and drift stock with each pass. Nothing is rewritten; settled
          // sales keep their original cost basis; only the live cache follows
          // the replay.
          const existing = await tx.listStockMovements(item.id);
          const suffix = `#${line.id}`;
          const priorNet = existing
            .filter(
              (movement) =>
                movement.ref === detail.id &&
                movement.reason !== null &&
                isCorrectionReason(movement.reason) &&
                movement.reason.endsWith(suffix),
            )
            .reduce((sum, movement) => sum + movement.delta, 0);
          const effectiveOriginal = line.quantity + priorNet;
          const reason = `${CORRECTION_REASON_PREFIX} ${detail.invoiceNumber} ${suffix}`;
          // One timestamp keeps the replacement and reversal in the same
          // ledger instant. The corrected inflow is inserted first, and the
          // store's rowid seq tie-breaker preserves that inflow-first order.
          const correctionOccurredAt = localDateTime();
          const reversal = {
            kind: "MANUAL_ADJUSTMENT" as const,
            delta: -effectiveOriginal,
            unitCost: null,
            occurredAt: correctionOccurredAt,
            seq: undefined,
          };
          const corrected = {
            kind: "PURCHASE" as const,
            delta: input.quantity,
            unitCost: input.unitCost,
            occurredAt: correctionOccurredAt,
            seq: undefined,
          };
          // SAFETY: the corrected INFLOW must precede the reversal OUTFLOW — in
          // the validation below AND in the stored rows. Reversal-first would
          // drive the projection below zero whenever any invoiced unit was
          // already sold (even for pure cost fixes) and would poison every
          // future replay of the stored ledger. Inflow-first fails exactly
          // when the corrected quantity drops below what was already sold.
          try {
            projectLedger([...existing, corrected, reversal]);
          } catch (err) {
            if (err instanceof StockLedgerError) {
              throw new ORPCError("BAD_REQUEST", { message: err.code });
            }
            throw err;
          }
          await tx.insertStockMovement({
            itemId: item.id,
            kind: corrected.kind,
            delta: corrected.delta,
            unitCost: corrected.unitCost,
            reason,
            ref: detail.id,
            occurredAt: corrected.occurredAt,
          });
          await tx.insertStockMovement({
            itemId: item.id,
            kind: reversal.kind,
            delta: reversal.delta,
            unitCost: null,
            reason,
            ref: detail.id,
            occurredAt: reversal.occurredAt,
          });
          const all = [...existing, corrected, reversal];
          const stockAfter = projectLedger(all).stockOnHand;
          const newCost = weightedAverageCost(all, { fallbackUnitCost: item.costPrice });
          await tx.setItemStockAndCost(item.id, stockAfter, newCost);
          await tx.insertActivity({ type: "STOCK_ADJUSTED", summary: `PURCHASE_CORRECTED ${item.name}`, ref: item.id });
          const refreshed = await tx.getInvoiceDetail(detail.id);
          // SAFETY: the invoice was just read inside this handler; it cannot vanish mid-transaction
          return refreshed!;
        });
      }),
    ),
    // --- debts screen (ticket 9) -------------------------------------------
    reportsDebts: os.reportsDebts.handler(
      guarded(async () => {
        const summaries = await deps.store.debtSummaries();
        // SAFETY: debtSummary.kind is enum-constrained, so every row lands in
        // exactly one bucket; the resulting buckets match the acceptance split.
        return {
          owedToUs: summaries.filter((d) => d.kind === "SALE"),
          weOwe: summaries.filter((d) => d.kind === "PURCHASE"),
        };
      }),
    ),
    debtsByParty: os.debtsByParty.handler(
      guardedInput(async ({ kind, counterpartyId, counterpartyName }) => {
        const items = await deps.store.listUnpaidInvoicesByParty(kind, counterpartyId, counterpartyName);
        // the party query has no pagination cap, so the count is the list size
        return { items, totalCount: items.length };
      }),
    ),

    // --- profit report (ticket 31): computed from raw records at read time ---
    reportsProfit: os.reportsProfit.handler(
      guardedInput(async (input) => {
        const range = resolveWindow({ preset: input.preset, customFrom: input.customFrom, customTo: input.customTo });
        const [saleLines, expenses, categories] = await Promise.all([
          deps.store.listSaleLinesForProfit(range.from, range.to),
          deps.store.listExpenseRecords({ from: range.from, to: range.to }),
          deps.store.listExpenseCategories(),
        ]);
        return computeProfitReport({ saleLines, expenses, categories, range });
      }),
    ),

    // --- dashboard (issue 84) ------------------------------------------------
    dashboardSummary: os.dashboardSummary.handler(
      guarded(async () => {
        const day = localDate(deps.now?.() ?? new Date());
        return { day, ...(await deps.store.dashboardSummary(day)) };
      }),
    ),

    // --- getting started (issue 97) ------------------------------------------
    onboardingProgress: os.onboardingProgress.handler(
      guarded(async () => {
        const progress = await deps.store.onboardingProgress();
        // Reading the progress is when the server learns the shop has all four
        // records, so the milestone is recorded right here. The dashboard used
        // to be the only writer, which lost the milestone whenever the owner
        // navigated away before the client's write landed — or completed the
        // flow from /invoices and settled the debt without ever coming back.
        // The store re-checks the four records, so this stays idempotent.
        if (progress.hasItems && progress.hasPurchase && progress.hasSale && progress.hasDebt) {
          await deps.store.recordOnboardingCompletion();
        }
        return progress;
      }),
    ),
    onboardingComplete: os.onboardingComplete.handler(
      guarded(async () => ({
        // the store re-checks every record and records the milestone
        // idempotently, so a client retry can never mark a half-done checklist
        completed: await deps.store.recordOnboardingCompletion(),
      })),
    ),

    // --- expenses (ticket 31) ------------------------------------------------
    expenseCategoriesList: os.expenseCategoriesList.handler(guarded(async () => ({ items: await deps.store.listExpenseCategories() }))),
    expenseCategoriesCreate: os.expenseCategoriesCreate.handler(
      guardedInput(async (input) => {
        // duplicate check lives INSIDE the serialized unit, same as categoriesCreate
        try {
          return await deps.store.withTransaction(async (tx) => {
            const existing = await tx.listExpenseCategories();
            if (existing.some((category) => category.name === input.name)) {
              throw new ORPCError("CONFLICT", { message: "EXPENSE_CATEGORY_EXISTS" });
            }
            const category = await tx.createExpenseCategory(input);
            // the flag choice rides in the audit summary so a misclassification
            // is traceable (the flag itself is create-only today, by design)
            await tx.insertActivity({ type: "EXPENSE_CATEGORY_CREATED", summary: `EXPENSE_CATEGORY_CREATED ${input.isOwnerWithdrawal === true ? "WITHDRAWAL" : "OPERATING"} ${input.name}` });
            return category;
          });
        } catch (err) {
          if (err instanceof Error && isUniqueViolation(err)) {
            throw new ORPCError("CONFLICT", { message: "EXPENSE_CATEGORY_EXISTS" });
          }
          throw err;
        }
      }),
    ),
    expensesCreate: os.expensesCreate.handler(
      guardedInput(async (input) => {
        // category existence is validated INSIDE the transaction unit, so an
        // FK violation on a race (category vanishing mid-call) surfaces as the
        // translated CATEGORY_NOT_FOUND instead of a raw constraint error
        return deps.store.withTransaction(async (tx) => {
          const categories = await tx.listExpenseCategories();
          if (!categories.some((category) => category.id === input.categoryId)) {
            throw new ORPCError("BAD_REQUEST", { message: "CATEGORY_NOT_FOUND" });
          }
          const expense = await tx.insertExpense({
            categoryId: input.categoryId,
            amount: input.amount,
            note: input.note ?? null,
            occurredAt: input.occurredAt ?? localDateTime(),
          });
          await tx.insertActivity({ type: "EXPENSE_RECORDED", summary: `EXPENSE_RECORDED ${input.amount}`, ref: expense.id });
          return expense;
        });
      }),
    ),
    expensesList: os.expensesList.handler(
      guardedInput(async (input) => {
        // the spec's default range is the current month; an explicit preset or
        // bounds overrides it. Single source of truth: resolveReportRange.
        const preset =
          input.preset ??
          ((input.from === undefined && input.to === undefined && input.customFrom === undefined && input.customTo === undefined
            ? "CURRENT_MONTH"
            : undefined));
        const range = resolveWindow({ preset, customFrom: input.customFrom, customTo: input.customTo, from: input.from, to: input.to });
        const rows = await deps.store.listExpenseRecords({ categoryIds: input.categoryIds, from: range.from, to: range.to });
        return { items: sortExpenses(rows, input.sortBy, input.sortDir) };
      }),
    ),

    // --- settings (ticket 10: store identity for the invoice header) ----
    settingsGet: os.settingsGet.handler(guarded(async () => deps.store.getSettings())),
    settingsUpdate: os.settingsUpdate.handler(
      guardedInput(async (input) => {
        // semantic phone handling at the boundary, like requireBarcode: zod
        // kept the shape; this normalizes to the canonical +213 form and
        // maps empty strings to a cleared phone (null) so the invoice header
        // never shows a raw, half-normalized number
        const storePhone =
          input.storePhone === undefined
            ? undefined
            : input.storePhone === null || input.storePhone.trim() === ""
              ? null
              : requireStorePhone(input.storePhone);
        // the address travels with the identity: an empty or cleared value
        // means "remove it", not "leave the stored one alone"
        const storeAddress =
          input.storeAddress === undefined
            ? undefined
            : input.storeAddress === null || input.storeAddress.trim() === ""
              ? null
              : input.storeAddress.trim();
        // identity write + audit land in ONE transaction: a failed audit
        // insert rolls the settings change back instead of persisting an
        // un-audited identity that a retry would misrepresent (greptile P1)
        return deps.store.withTransaction(async (tx) => {
          const updated = await tx.updateSettings({ storeName: input.storeName, storePhone, storeAddress });
          await tx.insertActivity({ type: "SETTINGS_UPDATED", summary: "SETTINGS_UPDATED" });
          return updated;
        });
      }),
    ),

    // --- UI preferences (issue 97 follow-up) ---------------------------------
    // shell state, not store identity: cheap read/write, no audit entry (the
    // sidebar toggle alone would spam the activity log)
    preferencesGet: os.preferencesGet.handler(guarded(async () => ({ values: await deps.store.getPreferences() }))),
    preferencesSet: os.preferencesSet.handler(
      guardedInput(async (input) => {
        // the completion milestone is derived from shop records, so a client
        // must not be able to write it: setting it would hide the checklist
        // forever with nothing behind it. Only the keys the owner owns pass.
        if (!CLIENT_WRITABLE_PREFERENCE_KEYS.has(input.key)) {
          throw new ORPCError("BAD_REQUEST", { message: "PREFERENCE_NOT_WRITABLE" });
        }
        await deps.store.setPreference(input.key, input.value);
        return { key: input.key, value: input.value };
      }),
    ),

    activitiesList: os.activitiesList.handler(
      guardedInput(async ({ limit }) => ({ items: await deps.store.listActivities(limit ?? 50) })),
    ),

    diagnosticsLogsTail: os.diagnosticsLogsTail.handler(
      // today's JSONL tail; the contract clamps `lines` to 1..500 so the
      // bounded read is the caller's choice, newest-last (chronological)
      guardedInput(async ({ lines }) => deps.logger.tail(lines ?? 100)),
    ),
    backupManual: os.backupManual.handler(
      guarded(async () => {
        // checkpoint+copy through the store seam; the audit entry lands only
        // after the file exists, so a failed copy never logs a phantom backup
        const result = await createBackup({ store: deps.store, dataDir: deps.config.dataDir });
        await deps.store.insertActivity({
          type: "BACKUP_CREATED",
          summary: `BACKUP_CREATED ${result.path.split(/[\\/]/).pop()}`,
          ref: result.path,
        });
        return result;
      }),
    ),
  };
}

/** The router object type, for AppDeps. */
export type RpcRouter = ReturnType<typeof createRpcRouter>;

/** bun:sqlite surfaces the categories.name UNIQUE constraint as this text */
function isUniqueViolation(err: Error): boolean {
  return err.message.includes("UNIQUE constraint failed") || err.message.includes("unique constraint");
}

/**
 * Translate the store's party identity refusal (and a cross-process race that
 * lands on the partial phone unique index) into the role-specific CONFLICT key
 * the ui translates (issue 120).
 */
async function withPartyPhoneConflict<T>(phoneKey: "CUSTOMER_PHONE_EXISTS" | "SUPPLIER_PHONE_EXISTS", fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PartyError && err.code === "PHONE_EXISTS") throw new ORPCError("CONFLICT", { message: phoneKey });
    if (err instanceof Error && isUniqueViolation(err)) throw new ORPCError("CONFLICT", { message: phoneKey });
    throw err;
  }
}

/** Maps the sqlite UNIQUE race on items.barcode to the stable BARCODE_EXISTS key. */
async function withBarcodeConflict<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error && isUniqueViolation(err)) {
      throw new ORPCError("CONFLICT", { message: "BARCODE_EXISTS" });
    }
    throw err;
  }
}

/**
 * Normalize a store phone at the boundary, like auth's reset flow: valid
 * Algerian numbers land in canonical +213XXXXXXXXX form; anything else is a
 * stable INVALID_PHONE_NUMBER (the ui already translates it). The clear
 * signal is handled by the caller: both null and trimmed-empty map to null,
 * so an API consumer can clear the phone with either.
 */
function requireStorePhone(raw: string): string {
  const normalized = normalizeAlgerianPhone(raw);
  if (normalized === null) throw new ORPCError("BAD_REQUEST", { message: "INVALID_PHONE_NUMBER" });
  return normalized;
}

/**
 * Normalize an optional client-supplied barcode at the boundary. The zod
 * schema keeps invalid shapes out earlier; this catches case/space
 * normalization and any junk that slipped past validation defensively.
 */
function requireBarcode(raw: string | undefined): string | undefined {
  if (raw === undefined) return raw;
  const normalized = normalizeBarcode(raw);
  if (normalized === null) throw new ORPCError("BAD_REQUEST", { message: "INVALID_BARCODE" });
  return normalized;
}