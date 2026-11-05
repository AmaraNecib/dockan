import { describe, expect, it } from "bun:test";
import { replaceLocalStorage } from "../tests/local-storage-control";
import { authLossReason, clearAuthLost, markSignedOut } from "./auth-refusal";
import { sessionRefreshGeneration, subscribeSessionRefresh, publishSessionRefresh } from "./session-refresh";

function storage(value: string | null, key = "better-auth.message") {
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
}

describe("session refresh protocol", () => {
  it("accepts advisory session events without echo and releases the managed listener", () => {
    const start = sessionRefreshGeneration();
    let calls = 0;
    const stop = subscribeSessionRefresh(() => { calls += 1; });
    expect(stop).toBeInstanceOf(Function);
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

  it("does not re-read its own published message as a missed session refresh", () => {
    const start = sessionRefreshGeneration();
    let calls = 0;
    const stop = subscribeSessionRefresh(() => { calls += 1; });
    window.localStorage.removeItem("better-auth.message");

    publishSessionRefresh();
    const ownMessage = window.localStorage.getItem("better-auth.message");
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(calls).toBe(0);
    expect(sessionRefreshGeneration()).toBe(start);
    expect(ownMessage).not.toBeNull();
    stop();
  });

  it("leaves a concurrent sibling overwrite eligible for focus verification", () => {
    const start = sessionRefreshGeneration();
    let calls = 0;
    const stop = subscribeSessionRefresh(() => { calls += 1; });
    const original = window.localStorage;
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    const restore = replaceLocalStorage({
      setItem: (key, _value) => {
        original.setItem(key, JSON.stringify({ event: "session", data: { trigger: "signout" }, clientId: "sibling", timestamp: 1 }));
      },
    });
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    try {
      expect(stop).toBeInstanceOf(Function);
      expect(restore).toBeInstanceOf(Function);
      publishSessionRefresh();
      window.dispatchEvent(new Event("focus"));
      expect(calls).toBe(1);
      expect(sessionRefreshGeneration()).toBe(start + 1);
    } finally {
      restore?.();
      if (visibilityDescriptor !== undefined) Object.defineProperty(document, "visibilityState", visibilityDescriptor);
      else Reflect.deleteProperty(document, "visibilityState");
      if (descriptor !== undefined) Object.defineProperty(window, "localStorage", descriptor);
      stop?.();
    }
    expect(Object.getOwnPropertyDescriptor(window, "localStorage")).toEqual(descriptor);
    expect(window.localStorage).toBe(original);
  });

  it("publishes an advisory without clearing an unconfirmed sign-out hold", () => {
    markSignedOut();
    window.localStorage.removeItem("better-auth.message");
    try {
      publishSessionRefresh();
      expect(JSON.parse(window.localStorage.getItem("better-auth.message") ?? "null")).toEqual({
        event: "session",
        data: { trigger: "signout" },
        clientId: expect.any(String),
        timestamp: expect.any(Number),
      });
      expect(authLossReason()).toBe("signed-out");
    } finally {
      clearAuthLost();
    }
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

  it("does not retire a credential scope when storage reads are blocked on focus", () => {
    const start = sessionRefreshGeneration();
    let calls = 0;
    const stop = subscribeSessionRefresh(() => { calls += 1; });
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
    const original = window.localStorage;
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    expect(descriptor).toBeDefined();
    const restore = replaceLocalStorage({ getItem: () => { throw new Error("blocked"); } });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    try {
      expect(() => window.localStorage.getItem("better-auth.message")).toThrow("blocked");
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      expect(calls).toBe(0);
      expect(sessionRefreshGeneration()).toBe(start);
      storage('{"event":"session","data":{"trigger":"signout"},"timestamp":99}');
      expect(calls).toBe(1);
      expect(sessionRefreshGeneration()).toBe(start + 1);
    } finally {
      restore?.();
      if (visibilityDescriptor !== undefined) Object.defineProperty(document, "visibilityState", visibilityDescriptor);
      else Reflect.deleteProperty(document, "visibilityState");
      if (descriptor !== undefined) Object.defineProperty(window, "localStorage", descriptor);
      stop?.();
    }
    expect(Object.getOwnPropertyDescriptor(window, "localStorage")).toEqual(descriptor);
    expect(window.localStorage).toBe(original);
    expect(Object.getOwnPropertyDescriptor(document, "visibilityState")).toEqual(visibilityDescriptor);
    expect(() => original.getItem("better-auth.message")).not.toThrow();
  });

  it("tolerates blocked writes without inventing a refresh, and reads a missed valid signal on focus", () => {
    let calls = 0;
    const stop = subscribeSessionRefresh(() => { calls += 1; });
    const original = window.localStorage;
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    expect(descriptor).toBeDefined();
    original.removeItem("better-auth.message");
    const restore = replaceLocalStorage({ setItem: () => { throw new Error("blocked write"); } });
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    try {
      expect(() => window.localStorage.setItem("probe", "1")).toThrow("blocked write");
      expect(() => publishSessionRefresh()).not.toThrow();
      window.dispatchEvent(new Event("focus"));
      expect(calls).toBe(0);
      original.setItem("better-auth.message", '{"event":"session","data":{"trigger":"getSession"},"timestamp":42}');
      window.dispatchEvent(new Event("focus"));
      expect(calls).toBe(1);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(calls).toBe(1);
    } finally {
      restore?.();
      if (visibilityDescriptor !== undefined) Object.defineProperty(document, "visibilityState", visibilityDescriptor);
      else Reflect.deleteProperty(document, "visibilityState");
      if (descriptor !== undefined) Object.defineProperty(window, "localStorage", descriptor);
      stop?.();
    }
    expect(Object.getOwnPropertyDescriptor(window, "localStorage")).toEqual(descriptor);
    expect(window.localStorage).toBe(original);
    expect(Object.getOwnPropertyDescriptor(document, "visibilityState")).toEqual(visibilityDescriptor);
    expect(() => original.setItem("probe", "restored")).not.toThrow();
    original.removeItem("probe");
  });
});
