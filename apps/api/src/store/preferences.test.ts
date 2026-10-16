import { afterAll, describe, expect } from "bun:test";
import { itHeavy } from "../test-support/heavy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { createDrizzleStore } from "./drizzle-store";
import type { StorePort } from "./port";

/**
 * UI preferences store seam (issue 97 follow-up). These are shell state, not
 * store identity: a separate key/value table behind StorePort, persisted in
 * sqlite so a packaged restart keeps the sidebar and checklist choices.
 */

const tempDirs: string[] = [];
const conns: Connection[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function removeTempDirRetry(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(50);
    }
  }
}

async function freshStore(): Promise<StorePort> {
  const dir = tempDir("dokan-prefs-");
  const conn = openConnection(
    createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") }),
  );
  conns.push(conn);
  const store = createDrizzleStore(conn);
  await store.setup();
  return store;
}

afterAll(() => {
  for (const conn of conns) conn.close();
  for (const dir of tempDirs) removeTempDirRetry(dir);
});

describe("UI preferences (issue 97 follow-up)", () => {
  itHeavy("returns an empty map on a fresh store", async () => {
    const store = await freshStore();
    expect(await store.getPreferences()).toEqual({});
  });

  itHeavy("round-trips a preference and updates it in place", async () => {
    const store = await freshStore();
    await store.setPreference("ui.sidebar.collapsed", "true");
    expect(await store.getPreferences()).toEqual({ "ui.sidebar.collapsed": "true" });
    await store.setPreference("ui.sidebar.collapsed", "false");
    expect(await store.getPreferences()).toEqual({ "ui.sidebar.collapsed": "false" });
  });

  itHeavy("keeps preferences out of store-identity settings", async () => {
    const store = await freshStore();
    await store.setPreference("ui.onboarding.dismissed", "true");
    // the settings row must not grow a preference key
    expect(await store.getSetting("ui.onboarding.dismissed")).toBeUndefined();
    expect((await store.getSettings()).storeName).toBe("Dokan");
    expect((await store.getPreferences())["ui.onboarding.dismissed"]).toBe("true");
  });

  itHeavy("survives re-opening the same database file (restart persistence)", async () => {
    const dir = tempDir("dokan-prefs-restart-");
    const config = createAppConfig({
      DOKAN_DATA_DIR: dir,
      DOKAN_DB_PATH: path.join(dir, "test.db"),
    });

    const first = openConnection(config);
    const firstStore = createDrizzleStore(first);
    await firstStore.setup();
    await firstStore.setPreference("ui.onboarding.completed", "true");
    first.close();

    const second = openConnection(config);
    conns.push(second);
    const secondStore = createDrizzleStore(second);
    await secondStore.setup();
    expect(await secondStore.getPreferences()).toEqual({ "ui.onboarding.completed": "true" });
  });
});
