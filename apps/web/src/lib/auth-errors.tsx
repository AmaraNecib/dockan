import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { MIN_PASSWORD_LENGTH, normalizeAlgerianPhone } from "@dokan/contracts";

import type { MessageKey } from "./i18n";

/**
 * The field an auth error points the owner back to; null means the summary.
 * Shared by the auth forms (App.tsx) and the alert below, so it lives with the
 * error machinery rather than in the gate that happens to render the forms.
 */
export type AuthErrorField = "phone" | "password" | "ownerName" | "storeName" | null;

/**
 * Shared auth-form error state (issue #100). The message is announced through
 * `role="alert"` when no single field is blamed; a field-bearing failure is
 * announced through that field's `aria-describedby` instead, so the owner hears
 * it once, not twice (issue #113).
 */
export function useAuthError() {
  const [state, setState] = useState<{ message: string; field: AuthErrorField; nonce: number } | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const focusErrorRef = useRef(false);
  // monotonic: the alert is keyed by it so an identical repeated failure is a
  // fresh live region and gets announced again
  const nonceRef = useRef(0);

  useEffect(() => {
    if (!focusErrorRef.current) return;
    focusErrorRef.current = false;
    errorRef.current?.focus();
  }, [state]);

  const show = useCallback((message: string, field: AuthErrorField, target: HTMLElement | null): void => {
    focusErrorRef.current = target === null;
    nonceRef.current += 1;
    setState({ message, field, nonce: nonceRef.current });
    target?.focus();
  }, []);

  const clear = useCallback((): void => setState(null), []);

  // drop the alert as soon as the field it blames is edited: leaving it up
  // keeps the corrected field marked invalid and tied to a stale message
  const clearField = useCallback((field: Exclude<AuthErrorField, null>): void => {
    setState((current) => (current !== null && current.field === field ? null : current));
  }, []);

  return { state, show, clear, clearField, errorRef };
}

/** Which field a resolved error blames; null means the alert summary. */
export function authErrorField(key: MessageKey): AuthErrorField {
  if (key === "INVALID_PHONE_NUMBER") return "phone";
  // a short password is a password problem; "credentials" names both fields in
  // its copy, so blaming one of them would contradict the message
  if (key === "AUTH_PASSWORD_TOO_SHORT") return "password";
  // issue #109 — the two names the native `required` used to guard
  if (key === "AUTH_OWNER_NAME_REQUIRED") return "ownerName";
  if (key === "AUTH_STORE_NAME_REQUIRED") return "storeName";
  return null;
}

/**
 * The first field-level failure on a new-owner form, using the exact rules the
 * contracts enforce (phone normalization, password minimum). `null` means the
 * form may be submitted.
 */
export function authFieldKey(phone: string, password: string): MessageKey | null {
  if (normalizeAlgerianPhone(phone) === null) return "INVALID_PHONE_NUMBER";
  if (password.length < MIN_PASSWORD_LENGTH) return "AUTH_PASSWORD_TOO_SHORT";
  return null;
}

/** The input a blamed field points at, or null for the alert summary. */
function authTarget(
  field: AuthErrorField,
  refs: {
    phone: RefObject<HTMLInputElement | null>;
    password: RefObject<HTMLInputElement | null>;
    ownerName?: RefObject<HTMLInputElement | null>;
    storeName?: RefObject<HTMLInputElement | null>;
  },
): HTMLElement | null {
  if (field === "phone") return refs.phone.current;
  if (field === "password") return refs.password.current;
  if (field === "ownerName") return refs.ownerName?.current ?? null;
  if (field === "storeName") return refs.storeName?.current ?? null;
  return null;
}

/**
 * The shared wiring for an auth form's failures: the alert state plus a
 * reporter that translates a resolved key and focuses the field it blames.
 */
export function useAuthReporter(
  phoneRef: RefObject<HTMLInputElement | null>,
  passwordRef: RefObject<HTMLInputElement | null>,
  ownerNameRef?: RefObject<HTMLInputElement | null>,
  storeNameRef?: RefObject<HTMLInputElement | null>,
) {
  const { t } = useTranslation();
  const authError = useAuthError();
  const { show } = authError;
  // stable: the login form announces its setup handoff in an effect keyed on
  // the reporter, and a fresh closure every render would re-run that effect
  const report = useCallback(
    (key: MessageKey): void => {
      const field = authErrorField(key);
      show(t(key), field, authTarget(field, { phone: phoneRef, password: passwordRef, ownerName: ownerNameRef, storeName: storeNameRef }));
    },
    [show, t, phoneRef, passwordRef, ownerNameRef, storeNameRef],
  );
  return { authError, report };
}

/**
 * The one error paragraph the auth forms render. A field-less failure is a live
 * region of its own and takes focus (`role="alert"`); a failure that blames a
 * field is announced through that field's `aria-describedby` when focus lands
 * on it, so it deliberately carries no `role` — otherwise the owner hears the
 * same sentence twice (issue #113).
 */
export function AuthErrorAlert({
  id,
  message,
  errorRef,
  field,
}: {
  id: string;
  message: string | null;
  errorRef: RefObject<HTMLParagraphElement | null>;
  field: AuthErrorField;
}) {
  if (message === null) return null;
  return (
    <p id={id} ref={errorRef} tabIndex={-1} role={field === null ? "alert" : undefined} className="mt-2 text-sm text-destructive">
      {message}
    </p>
  );
}
