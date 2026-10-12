import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useCallback, useRef, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

type PasswordInputProps = Omit<ComponentProps<"input">, "type"> & {
  "data-testid"?: string;
};

/**
 * A password field with an app-controlled reveal toggle (#167).
 *
 * The browser's native reveal control is suppressed in `index.css`, so this is
 * the only eye on the field. The toggle is a `type="button"` element that never
 * submits the surrounding form, it stays rendered while the field is mounted,
 * and it is pinned to the field's inline end — the left edge in this RTL app —
 * so every password field lines up the same way.
 */
export function PasswordInput({ className, disabled, ref, "data-testid": testId, ...props }: PasswordInputProps) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const detachRef = useRef<(() => void) | undefined>(undefined);
  const ToggleIcon = revealed ? EyeOffIcon : EyeIcon;

  // One node reference serves the toggle's focus hand-back; the caller's ref
  // (App focuses the field to point at a validation error) gets the same node.
  const attachInput = useCallback(
    (node: HTMLInputElement | null) => {
      // clear the focus node first, so a detached field can never be focused
      inputRef.current = node;
      if (ref === undefined || ref === null) return;
      // React hands a component either a ref object or a ref callback
      if ("current" in ref) {
        ref.current = node;
        return;
      }
      if (node === null) {
        // Detached. A callback that returned a cleanup expects that cleanup;
        // one that returned nothing expects the legacy null call. React skips
        // the null call for us because this wrapper always returns undefined.
        if (detachRef.current === undefined) ref(null);
        else {
          detachRef.current();
          detachRef.current = undefined;
        }
        return;
      }
      // React 19 callback refs may return a cleanup function. Hold it and run
      // it from the detach path above; returning it here would make React skip
      // that path and leave inputRef pointing at the removed node.
      // SAFETY: React types a callback ref's return as void | (() => void);
      // void and undefined are the same "no cleanup" value at runtime
      detachRef.current = ref(node) as (() => void) | undefined;
    },
    [ref],
  );

  return (
    <span className="relative block w-full">
      <input
        {...props}
        ref={attachInput}
        type={revealed ? "text" : "password"}
        disabled={disabled}
        data-testid={testId}
        className={cn("w-full rounded border border-input bg-background py-2 ps-3 pe-10", className)}
      />
      <button
        type="button"
        disabled={disabled}
        aria-label={revealed ? t("hidePassword") : t("showPassword")}
        aria-pressed={revealed}
        data-testid={testId === undefined ? undefined : `${testId}-toggle`}
        onClick={() => {
          setRevealed((open) => !open);
          // the native control left the caret in the field; do the same
          inputRef.current?.focus();
        }}
        className="absolute end-1 inset-y-0 my-auto flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
      >
        <ToggleIcon className="h-4 w-4" aria-hidden="true" />
      </button>
    </span>
  );
}
