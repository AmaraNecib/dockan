import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";

import { SCAN_MAX_GAP_MS, useBarcodeScanner } from "./use-barcode-scanner";

/**
 * Unit tests for the wedge-scanner hook (ticket 34). happy-dom provides the
 * DOM globals; the clock is a stubbed performance.now driven by an explicit
 * millisecond counter so gap/duplicate timing is exact, never slept through
 * (see .agents/wisdom/e2e/deterministic-timing-tests.md).
 */

/** mutable fake clock consumed by the stubbed performance.now */
let clock = 0;
const advance = (ms: number) => {
  clock += ms;
};

// happy-dom's performance rejects swapped receivers on its methods, so shadow
// just now() with an own property reading the fake clock — everything else
// (mark, measure, React's scheduler reads) keeps working untouched.
const realPerformance = globalThis.performance;
const realNow = realPerformance.now.bind(realPerformance);
const stubPerformance = () => {
  realPerformance.now = () => clock;
};
const restorePerformance = () => {
  realPerformance.now = realNow;
};

const keydown = (key: string, target: EventTarget = window, composing = false) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  // SAFETY: KeyboardEventInit lacks isComposing in happy-dom's constructor map
  Object.defineProperty(event, "isComposing", { value: composing });
  target.dispatchEvent(event);
};

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** mounts the hook; inference keeps the committed-codes array concrete */
function mountScanner() {
  const codes: string[] = [];

  function Harness() {
    const collector = useRef(codes);
    // SAFETY: the hook runs in the component body, never inside an effect
    const onScan = useCallback((code: string) => collector.current.push(code), []);
    useBarcodeScanner(onScan);
    return null;
  }

  const host = document.createElement("div");
  document.body.appendChild(host);
  let root: ReturnType<typeof createRoot> | null = null;
  act(() => {
    root = createRoot(host);
    root.render(<Harness />);
  }); // act flushes passive effects so the keydown listener is attached
  let unmounted = false;
  return {
    codes,
    unmount: () => {
      if (unmounted) return;
      unmounted = true;
      root?.unmount();
      host.remove();
    },
  };
}

const focusInput = (): HTMLInputElement => {
  const input = document.createElement("input");
  document.body.appendChild(input);
  input.focus();
  return input;
};

describe("use-barcode-scanner", () => {
  let scanner: ReturnType<typeof mountScanner>;

  beforeEach(() => {
    stubPerformance();
    clock = 0;
    scanner = mountScanner();
  });
  afterEach(() => {
    scanner.unmount();
    document.body.innerHTML = "";
    restorePerformance();
  });

  it("commits a wedge burst outside editable targets regardless of gaps", () => {
    keydown("A");
    advance(500); // huge gap — irrelevant outside editables
    keydown("B");
    advance(500);
    keydown("C");
    advance(10);
    keydown("Enter");
    expect(scanner.codes).toEqual(["ABC"]);
  });

  it("resets the buffer when typing slowly inside an editable field", () => {
    const input = focusInput();
    keydown("a", input);
    advance(SCAN_MAX_GAP_MS + 30); // > the gap — human pace
    keydown("b", input);
    advance(SCAN_MAX_GAP_MS + 30);
    keydown("c", input);
    advance(10);
    keydown("Enter", input);
    expect(scanner.codes).toEqual([]); // half-bursts never leak into forms
  });

  it("commits a tight burst inside an editable field exactly once", () => {
    const input = focusInput();
    for (const key of ["1", "2", "3"]) {
      keydown(key, input);
      advance(10);
    }
    keydown("Enter", input);
    expect(scanner.codes).toEqual(["123"]);
  });

  it("claims a scan's Enter before it reaches the focused field", () => {
    const input = focusInput();
    let enterReachedField = 0;
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") enterReachedField += 1;
    });

    for (const key of ["1", "2", "3"]) {
      keydown(key, input);
      advance(10);
    }
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(enter);

    expect(scanner.codes).toEqual(["123"]);
    // the wedge's Enter belongs to the scan: it must not reach the field, an
    // inline editor's Enter handler, or the form around them
    expect(enterReachedField).toBe(0);
    expect(enter.defaultPrevented).toBe(true);
  });

  it("detaches its capture listener on unmount", () => {
    const input = focusInput();
    scanner.unmount();

    for (const key of ["9", "0", "1"]) {
      keydown(key, input);
      advance(5);
    }
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(enter);

    // a leaked capture listener would keep committing scans (and swallowing
    // Enter) on every screen after the items page unmounted
    expect(scanner.codes).toEqual([]);
    expect(enter.defaultPrevented).toBe(false);
  });

  it("ignores IME-composing keystrokes entirely", () => {
    const input = focusInput();
    keydown("ا", input, true);
    keydown("ل", input, true);
    advance(5);
    keydown("Enter", input, true); // Enter that closes a composition session
    expect(scanner.codes).toEqual([]);
    // the composing keys left nothing buffered: the next real scan is clean
    keydown("X", input);
    advance(5);
    keydown("Y", input);
    advance(5);
    keydown("Z", input);
    advance(5);
    keydown("Enter", input);
    expect(scanner.codes).toEqual(["XYZ"]);
  });

  it("drops an identical rescan inside the duplicate window, allows it after", () => {
    keydown("6");
    advance(5);
    keydown("2");
    advance(5);
    keydown("1");
    advance(5);
    keydown("Enter");
    expect(scanner.codes).toEqual(["621"]);

    // same code again well inside SCAN_DUPLICATE_WINDOW_MS — swallowed
    advance(100);
    keydown("6");
    advance(5);
    keydown("2");
    advance(5);
    keydown("1");
    advance(5);
    keydown("Enter");
    expect(scanner.codes).toEqual(["621"]);

    // past the window the same code commits again
    advance(900);
    keydown("6");
    advance(5);
    keydown("2");
    advance(5);
    keydown("1");
    advance(5);
    keydown("Enter");
    expect(scanner.codes).toEqual(["621", "621"]);
  });

  it("clears a partial buffer on window blur", () => {
    keydown("A");
    keydown("B");
    window.dispatchEvent(new Event("blur"));
    keydown("C");
    advance(5);
    keydown("D");
    advance(5);
    keydown("E");
    advance(5);
    keydown("Enter");
    // only the post-blur keys commit; the pre-blur prefix was dropped
    expect(scanner.codes).toEqual(["CDE"]);
  });
});
