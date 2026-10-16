import { act } from "react";

/**
 * Drives the themed Base UI Select in happy-dom unit tests after issue #101
 * replaced the last native `<select>` elements. Native `HTMLSelectElement`
 * helpers no longer apply, so this mirrors components/ui/select.test.tsx: a
 * mouse interaction opens the portalled popup, then pointerdown + click on the
 * option commits it through the root's onValueChange.
 */

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/** Open the popup from its trigger. */
export async function openSelect(trigger: HTMLElement): Promise<void> {
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Wait for a portalled option whose text contains `label`, or null. When a
 * trigger is given, only options in the listbox that trigger controls are
 * considered: Base UI leaves a closed popup mounted, so two selects that share
 * an option label (the sale override and discount both offer "مبلغ") would
 * otherwise resolve to the stale one. */
export async function findOption(label: string, trigger?: HTMLElement): Promise<HTMLElement | null> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const controlledId = trigger?.getAttribute("aria-controls");
    const options = Array.from(document.querySelectorAll<HTMLElement>("[role='option']"));
    const inScope =
      controlledId === null || controlledId === undefined || controlledId === ""
        ? options
        : options.filter((option) => option.closest("[role='listbox']")?.id === controlledId);
    const option = inScope.find((element) => element.textContent?.trim() === label);
    if (option !== undefined) return option;
    await settle();
  }
  return null;
}

/** Activate an already-rendered portalled option. */
export async function activateOption(option: HTMLElement): Promise<void> {
  await act(async () => {
    option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    option.dispatchEvent(new PointerEvent("click", { bubbles: true, cancelable: true, pointerType: "mouse", detail: 1 }));
  });
  await settle();
}

/** Open `trigger` and activate the option labelled `label`. */
export async function chooseOption(trigger: HTMLElement, label: string): Promise<void> {
  await openSelect(trigger);
  const option = await findOption(label, trigger);
  if (option === null) throw new Error(`select option not found: ${label}`);
  await activateOption(option);
}
