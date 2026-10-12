import { afterEach, describe, expect, it } from "bun:test";
import { act, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "@/lib/i18n";
import { PasswordInput } from "./password-input";

let mountedRoots: Array<ReturnType<typeof createRoot>> = [];

function render(ui: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  act(() => root.render(ui));
  return { host, root };
}

/** Unmount inside a test without leaking the root into the afterEach teardown. */
function unmountRoot(root: ReturnType<typeof createRoot>): void {
  act(() => root.unmount());
  mountedRoots = mountedRoots.filter((mounted) => mounted !== root);
}

afterEach(() => {
  const roots = mountedRoots;
  mountedRoots = [];
  for (const root of roots) act(() => root.unmount());
  document.body.innerHTML = "";
});

const inputOf = (host: HTMLElement): HTMLInputElement => {
  const input = host.querySelector<HTMLInputElement>('[data-testid="password"]');
  if (input === null) throw new Error("missing password input");
  return input;
};

const queryToggle = (host: HTMLElement): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>('[data-testid="password-toggle"]');

const toggleOf = (host: HTMLElement): HTMLButtonElement => {
  const button = queryToggle(host);
  if (button === null) throw new Error("missing password toggle");
  return button;
};

const click = (element: HTMLElement): void => {
  act(() => element.click());
};

describe("PasswordInput (#167)", () => {
  it("keeps the toggle mounted across repeated toggles and flips the input type", () => {
    const { host } = render(<PasswordInput data-testid="password" value="" onChange={() => undefined} />);

    expect(inputOf(host).type).toBe("password");
    expect(queryToggle(host)).not.toBeNull();

    click(toggleOf(host));
    expect(inputOf(host).type).toBe("text");
    expect(queryToggle(host)).not.toBeNull();

    click(toggleOf(host));
    expect(inputOf(host).type).toBe("password");
    // the reported bug: the control must still be there after one round trip
    expect(queryToggle(host)).not.toBeNull();
  });

  it("never submits the surrounding form", () => {
    let submits = 0;
    const { host } = render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submits += 1;
        }}
      >
        <PasswordInput data-testid="password" value="" onChange={() => undefined} />
      </form>,
    );

    expect(toggleOf(host).type).toBe("button");
    click(toggleOf(host));
    click(toggleOf(host));
    expect(submits).toBe(0);
  });

  it("exposes the toggle state through aria-pressed and aria-label", () => {
    const { host } = render(<PasswordInput data-testid="password" value="" onChange={() => undefined} />);

    expect(toggleOf(host).getAttribute("aria-pressed")).toBe("false");
    expect(toggleOf(host).getAttribute("aria-label")).toBe("إظهار كلمة المرور");

    click(toggleOf(host));

    expect(toggleOf(host).getAttribute("aria-pressed")).toBe("true");
    expect(toggleOf(host).getAttribute("aria-label")).toBe("إخفاء كلمة المرور");
  });

  it("forwards the ref and the native input props to the input element", () => {
    // SAFETY: the ref starts empty; React fills it with the rendered input element
    const ref = { current: null as HTMLInputElement | null };
    const { host } = render(
      <PasswordInput
        ref={ref}
        data-testid="password"
        name="passphrase"
        required
        autoComplete="current-password"
        aria-invalid
        value="secret"
        onChange={() => undefined}
      />,
    );
    const input = inputOf(host);

    expect(ref.current).toBe(input);
    expect(input.name).toBe("passphrase");
    expect(input.required).toBe(true);
    expect(input.getAttribute("autocomplete")).toBe("current-password");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.value).toBe("secret");
  });

  it("keeps the same input node and its text through a reveal and hide round trip", () => {
    function Harness() {
      const [value, setValue] = useState("keep me");
      return <PasswordInput data-testid="password" value={value} onChange={(event) => setValue(event.target.value)} />;
    }
    const { host } = render(<Harness />);
    const before = inputOf(host);

    click(toggleOf(host));
    expect(inputOf(host).type).toBe("text");
    click(toggleOf(host));
    expect(inputOf(host).type).toBe("password");
    // node identity: a remount would drop the caret and any browser state
    expect(inputOf(host)).toBe(before);
    expect(inputOf(host).value).toBe("keep me");
  });

  it("returns focus to the input after a toggle", () => {
    const { host } = render(<PasswordInput data-testid="password" value="" onChange={() => undefined} />);
    const toggle = toggleOf(host);
    // focus the toggle first: a programmatic click does not move focus, so an
    // assertion without this setup would pass even if the hand-back were gone
    toggle.focus();
    expect(document.activeElement).toBe(toggle);

    click(toggle);

    expect(document.activeElement).toBe(inputOf(host));
  });

  it("runs a callback ref's cleanup on unmount and drops the detached node", () => {
    const attachedNodes: HTMLInputElement[] = [];
    let cleanups = 0;
    const ref = (node: HTMLInputElement | null): (() => void) | undefined => {
      if (node === null) return undefined;
      attachedNodes.push(node);
      return () => {
        cleanups += 1;
      };
    };

    const { root } = render(<PasswordInput ref={ref} data-testid="password" value="" onChange={() => undefined} />);
    expect(attachedNodes).toHaveLength(1);
    expect(cleanups).toBe(0);

    unmountRoot(root);

    // the detach path runs the callback ref's cleanup and nulls the internal
    // focus ref in the same branch, so a toggle can never focus a dead field
    expect(cleanups).toBe(1);
    expect(attachedNodes[0]?.isConnected).toBe(false);
  });

  it("disables the toggle together with the field", () => {
    const { host } = render(<PasswordInput data-testid="password" disabled value="" onChange={() => undefined} />);

    expect(inputOf(host).disabled).toBe(true);
    expect(toggleOf(host).disabled).toBe(true);
  });
});
