import { describe, expect, it } from "bun:test";
import { sessionRefreshGeneration, subscribeSessionRefresh, publishSessionRefresh } from "./session-refresh";

function storage(value: string | null, key = "better-auth.message") {
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
}

describe("session refresh protocol", () => {
  it("accepts advisory session events without echo and releases the managed listener", () => {
    const start = sessionRefreshGeneration();
    let calls = 0;
    const stop = subscribeSessionRefresh(() => { calls += 1; });
    window.localStorage.removeItem("better-auth.message");
    for (const value of [null, "{", "null", "[]", '{"event":"other","data":{}}', '{"event":"session"}']) storage(value);
    storage('{"event":"session","data":{"trigger":"signout"},"clientId":"sibling","timestamp":1}', "unrelated");
    expect(calls).toBe(0);
    storage('{"event":"session","data":{"trigger":"signout"},"clientId":"sibling","timestamp":1}');
    expect(calls).toBe(1);
    expect(sessionRefreshGeneration()).toBe(start + 1);
    expect(window.localStorage.getItem("better-auth.message")).toBeNull();
    stop();
    storage('{"event":"session","data":{"trigger":"signout"},"clientId":"sibling","timestamp":2}');
    expect(calls).toBe(1);
    expect(sessionRefreshGeneration()).toBe(start + 1);
  });

  it("publishes credential-free unique messages without telling the sender to recover", () => {
    const start = sessionRefreshGeneration();
    publishSessionRefresh();
    const first = window.localStorage.getItem("better-auth.message");
    publishSessionRefresh();
    const second = window.localStorage.getItem("better-auth.message");
    expect(first).not.toBe(second);
    expect(JSON.parse(second ?? "null")).toMatchObject({ event: "session", data: { trigger: "signout" } });
    expect(Object.keys(JSON.parse(second ?? "null")).sort()).toEqual(["clientId", "data", "event", "timestamp"]);
    expect(sessionRefreshGeneration()).toBe(start);
  });

  it("falls back to visible focus checks when storage writes are blocked", () => {
    let calls = 0;
    const stop = subscribeSessionRefresh(() => { calls += 1; });
    const original = window.localStorage.setItem;
    const originalRead = window.localStorage.getItem;
    window.localStorage.setItem = () => { throw new Error("blocked"); };
    window.localStorage.getItem = () => { throw new Error("blocked"); };
    try {
      expect(() => publishSessionRefresh()).not.toThrow();
      expect(calls).toBe(0);
      window.dispatchEvent(new Event("focus"));
      expect(calls).toBe(1);
    } finally {
      window.localStorage.setItem = original;
      window.localStorage.getItem = originalRead;
      stop();
    }
  });
});
