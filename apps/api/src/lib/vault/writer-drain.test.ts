import { expect, it } from "bun:test";
import { VaultWriterDrain } from "./writer-drain";

it("refuses new requests while waiting for admitted writes and background jobs before closing", async () => {
  const drain = new VaultWriterDrain();
  const events: string[] = [];
  let releaseRequest = () => {};
  let releaseBackup = () => {};
  const request = drain.run(async () => {
    await new Promise<void>((resolve) => { releaseRequest = resolve; });
    events.push("request persisted");
  });
  const backup = drain.run(async () => {
    await new Promise<void>((resolve) => { releaseBackup = resolve; });
    events.push("backup finished");
  });
  const closed = drain.stop(async () => { events.push("closed"); });
  await expect(drain.run(async () => { events.push("late write"); })).rejects.toThrow("VAULT_STOPPING");
  releaseRequest();
  await request;
  expect(events).toEqual(["request persisted"]);
  releaseBackup();
  await Promise.all([backup, closed]);
  expect(events).toEqual(["request persisted", "backup finished", "closed"]);
  await drain.stop(async () => { events.push("closed twice"); });
  expect(events).not.toContain("closed twice");
});
