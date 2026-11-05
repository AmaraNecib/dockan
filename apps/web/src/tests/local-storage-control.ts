/** Replace the configurable window getter, never happy-dom's method-hiding Storage proxy. */
export function replaceLocalStorage(overrides: Partial<Pick<Storage, "getItem" | "setItem">>): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  if (!descriptor?.configurable) throw new Error("Test requires a configurable localStorage getter");
  const original = window.localStorage;
  const controlled: Storage = {
    get length() { return original.length; },
    clear: () => original.clear(),
    key: (index) => original.key(index),
    removeItem: (key) => original.removeItem(key),
    getItem: overrides.getItem ?? ((key) => original.getItem(key)),
    setItem: overrides.setItem ?? ((key, value) => original.setItem(key, value)),
  };
  Object.defineProperty(window, "localStorage", { configurable: true, get: () => controlled });
  return () => { Object.defineProperty(window, "localStorage", descriptor); };
}
