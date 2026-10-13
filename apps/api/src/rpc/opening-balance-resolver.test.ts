import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

import { pickOpeningSupplier, resolveOpeningDestination, type NamedSupplierCandidate } from "./opening-balance-resolver";

const candidate = (id: string, entries = 0, name = id): NamedSupplierCandidate => ({ id, name, entries });

describe("pickOpeningSupplier (issue 184 — the single tie-break)", () => {
  it("returns undefined for no candidates", () => {
    expect(pickOpeningSupplier([])).toBeUndefined();
  });

  it("prefers the entry-carrying party over an empty twin", () => {
    const empty = candidate("a", 0);
    const carrying = candidate("b", 2);
    expect(pickOpeningSupplier([empty, carrying])?.id).toBe("b");
    // order-independent
    expect(pickOpeningSupplier([carrying, empty])?.id).toBe("b");
  });

  it("breaks an entry-count tie by the lowest id", () => {
    expect(pickOpeningSupplier([candidate("zzz", 1), candidate("aaa", 1)])?.id).toBe("aaa");
    expect(pickOpeningSupplier([candidate("b", 0), candidate("a", 0), candidate("c", 0)])?.id).toBe("a");
  });

  it("is deterministic regardless of input order", () => {
    const rows = [candidate("m", 1), candidate("a", 3), candidate("z", 3)];
    expect(pickOpeningSupplier(rows)?.id).toBe("a");
    expect(pickOpeningSupplier([...rows].reverse())?.id).toBe("a");
  });
});

describe("resolveOpeningDestination (issue 184)", () => {
  it("falls back to the tie-break when no candidate holds the signature", async () => {
    const rows = [candidate("a", 0), candidate("b", 4)];
    const resolved = await resolveOpeningDestination(rows, { direction: "WE_OWE", amount: 500 }, async () => false);
    expect(resolved?.candidate.id).toBe("b");
    expect(resolved?.holder).toBe(false);
  });

  it("keeps a retry on the account already holding the signature, even when another candidate now has more entries", async () => {
    const original = candidate("a", 1);
    const busier = candidate("b", 9);
    const resolved = await resolveOpeningDestination([original, busier], { direction: "WE_OWE", amount: 700 }, async (row) => row.id === "a");
    expect(resolved?.candidate.id).toBe("a");
    expect(resolved?.holder).toBe(true);
  });

  it("returns undefined when no supplier folds to the name", async () => {
    expect(await resolveOpeningDestination([], { direction: "WE_OWE", amount: 1 }, async () => false)).toBeUndefined();
  });
});

describe("tie-break lives in exactly one place (issue 184, structural)", () => {
  const SKIP = /(^|[\\/])(node_modules|\.git|dist|\.scratch|test-results|playwright-report|\.turbo)([\\/]|$)/;

  it("defines the entry-count/lowest-id comparison only in the api resolver module", async () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    const offenders: string[] = [];
    for await (const file of glob.scan({ cwd: root, absolute: true })) {
      const rel = file.slice(root.length).replaceAll("\\", "/");
      if (SKIP.test(rel) || rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
      const source = await Bun.file(file).text();
      if (/entries\s*>\s*(best|bestEntries|winner|current)\b/.test(source)) offenders.push(rel);
    }
    expect(offenders).toEqual(["apps/api/src/rpc/opening-balance-resolver.ts"]);
  });

  it("does not let the web opening-balance page re-implement the resolver", async () => {
    const page = await Bun.file(fileURLToPath(new URL("../../../web/src/pages/supplier-opening-balance.tsx", import.meta.url))).text();
    expect(page).not.toContain("matchByNormalizedName");
    expect(page).toContain("suppliersResolveName");
    // no local entry-count comparator over folded siblings
    expect(page).not.toMatch(/bestEntries|\bentries\s*>/);
  });
});
