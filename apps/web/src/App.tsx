import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { authClient, useSession } from "./lib/auth-client";
import { authErrorKey, serverErrorKey, type MessageKey } from "./lib/i18n";
import "./lib/i18n";
import { normalizeAlgerianPhone, phoneToUsername } from "@dokan/contracts";
import { rpcClient } from "./lib/rpc";

/** The field an auth error points the owner back to; null means the summary. */
type AuthErrorField = "phone" | "password" | null;

type AuthErrorFocus = { field: AuthErrorField; target: HTMLInputElement | null };

/** Mirrors the contract's password rule (packages/contracts/src/core.ts `min(4)`). */
const MIN_PASSWORD_LENGTH = 4;

/**
 * Shared auth-form error state (issue #100). The message is announced through
 * `role="alert"`; focus lands on the blamed field, or on the alert itself
 * when the failure names no single field.
 */
function useAuthError() {
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

  return { state, show, clear, errorRef };
}

/** Which field a resolved error blames, and where focus should land. */
function authErrorFocus(
  key: MessageKey,
  fields: { phone: HTMLInputElement | null; password: HTMLInputElement | null },
): AuthErrorFocus {
  if (key === "INVALID_PHONE_NUMBER") return { field: "phone", target: fields.phone };
  // credentials blame either field and a short password blames the password;
  // the alert (role="alert") names the problem, focus lands where the fix is
  // typed, and nothing steals focus back after the request resolves
  if (key === "AUTH_INVALID_CREDENTIALS" || key === "AUTH_PASSWORD_TOO_SHORT") {
    return { field: "password", target: fields.password };
  }
  return { field: null, target: null };
}

/**
 * The first field-level failure on a new-owner form, using the exact rules the
 * contracts enforce (phone normalization, password minimum). `null` means the
 * form may be submitted.
 */
function authFieldKey(phone: string, password: string): MessageKey | null {
  if (normalizeAlgerianPhone(phone) === null) return "INVALID_PHONE_NUMBER";
  if (password.length < MIN_PASSWORD_LENGTH) return "AUTH_PASSWORD_TOO_SHORT";
  return null;
}

/**
 * The shared wiring for an auth form's failures: the alert state plus a
 * reporter that translates a resolved key and focuses the field it blames.
 */
function useAuthReporter(
  phoneRef: RefObject<HTMLInputElement | null>,
  passwordRef: RefObject<HTMLInputElement | null>,
) {
  const { t } = useTranslation();
  const authError = useAuthError();
  function report(key: MessageKey): void {
    const focus = authErrorFocus(key, { phone: phoneRef.current, password: passwordRef.current });
    authError.show(t(key), focus.field, focus.target);
  }
  return { authError, report };
}

/** The one error paragraph the auth forms render; focusable and announced. */
function AuthErrorAlert({
  id,
  message,
  errorRef,
}: {
  id: string;
  message: string | null;
  errorRef: RefObject<HTMLParagraphElement | null>;
}) {
  if (message === null) return null;
  return (
    <p id={id} ref={errorRef} tabIndex={-1} role="alert" className="mt-2 text-sm text-destructive">
      {message}
    </p>
  );
}

/** Blocks children until a session exists. */
export function RequireSession({ children }: { children: ReactNode }) {
  const sessionResult = useSession();
  const { t } = useTranslation();
  if (sessionResult.isPending) {
    return <main className="grid min-h-screen place-items-center bg-background text-muted-foreground">{t("appSub")}</main>;
  }
  if (sessionResult.data === null) {
    return <AuthGate />;
  }
  return <>{children}</>;
}

/** Decides whether to show setup, login, or forgot-password. */
function AuthGate() {
  const { t } = useTranslation();
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [view, setView] = useState<"login" | "forgot">("login");
  // only the newest check may write state: Strict Mode starts two of them, and
  // without this a slow failure can overwrite a success and strand the owner on
  // the retry screen after a check that actually worked
  const checkSeqRef = useRef(0);

  const checkSetup = useCallback(() => {
    const seq = ++checkSeqRef.current;
    setNeedsSetup(null);
    setCheckFailed(false);
    rpcClient
      .needsSetup()
      .then((res) => {
        if (seq === checkSeqRef.current) setNeedsSetup(res.needsSetup);
      })
      // A failed check must not read as "setup not needed". On an empty
      // installation that shows login, which has no account to accept, and the
      // owner has to guess that refreshing would help.
      .catch(() => {
        if (seq === checkSeqRef.current) setCheckFailed(true);
      });
  }, []);

  useEffect(() => {
    checkSetup();
  }, [checkSetup]);

  if (checkFailed) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-4">
        <div className="grid w-full max-w-sm gap-3 rounded-2xl border border-border bg-card p-6 text-center shadow-sm" dir="rtl">
          <p className="text-sm text-destructive" role="alert">
            {t("startupCheckFailed")}
          </p>
          <button type="button" onClick={checkSetup} className="rounded-lg bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/80" data-testid="startup-retry">
            {t("itemsSearchRetry")}
          </button>
        </div>
      </main>
    );
  }

  if (needsSetup === null) return <LoadingScreen />;

  if (needsSetup) return <SetupPage onDone={() => setNeedsSetup(false)} />;
  if (view === "forgot") return <ForgotPasswordPage onDone={() => setView("login")} />;
  return <LoginPage onForgotPassword={() => setView("forgot")} />;
}

function LoadingScreen() {
  const { t } = useTranslation();
  return <main className="grid min-h-screen place-items-center bg-background text-muted-foreground">{t("appSub")}</main>;
}

/* ------------------------------------------------------------------ */
/*  Setup page — first time only                                       */
/* ------------------------------------------------------------------ */

function SetupPage({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [ownerName, setOwnerName] = useState("");
  const [storeName, setStoreName] = useState("");
  const [storeAddress, setStoreAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const phoneRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const { authError, report } = useAuthReporter(phoneRef, passwordRef);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // same rules the contracts enforce, checked before the request so the owner
    // is told which field is wrong instead of seeing a generic failure
    const fieldKey = authFieldKey(phone, password);
    if (fieldKey !== null) {
      report(fieldKey);
      return;
    }
    setBusy(true);
    authError.clear();
    try {
      await rpcClient.firstTimeSetup({
        ownerName,
        phoneNumber: phone,
        password,
        storeName,
        storeAddress: storeAddress || undefined,
        secret,
      });
      onDone();
    } catch (err) {
      report(serverErrorKey(err instanceof Error ? err.message : undefined));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-sm" dir="rtl">
        <h1 className="text-center text-2xl font-bold">{t("appTitle")}</h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">{t("appSub")}</p>

        <h2 className="mt-6 font-semibold">{t("setupWelcome")}</h2>

        <label className="mt-3 grid gap-1 text-sm">
          {t("setupOwnerName")}
          <input className="rounded border border-input bg-background px-3 py-2" name="ownerName" autoComplete="name" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} required />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("setupStoreName")}
          <input className="rounded border border-input bg-background px-3 py-2" name="storeName" autoComplete="organization" value={storeName} onChange={(e) => setStoreName(e.target.value)} required />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("setupStoreAddress")}
          <input className="rounded border border-input bg-background px-3 py-2" name="storeAddress" autoComplete="street-address" value={storeAddress} onChange={(e) => setStoreAddress(e.target.value)} />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("username")}
          <input ref={phoneRef} type="tel" inputMode="tel" className="rounded border border-input bg-background px-3 py-2" name="phone" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="username" required dir="ltr" placeholder={t("phoneExample")} aria-invalid={authError.state?.field === "phone"} aria-describedby={authError.state?.field === "phone" ? "setup-error" : undefined} />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("password")}
          <input ref={passwordRef} type="password" className="rounded border border-input bg-background px-3 py-2" name="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required aria-invalid={authError.state?.field === "password"} aria-describedby={authError.state?.field === "password" ? "setup-error" : undefined} />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("setupSecret")}
          <input type="password" className="rounded border border-input bg-background px-3 py-2" name="secret" value={secret} onChange={(e) => setSecret(e.target.value)} required dir="ltr" data-testid="setup-secret" />
        </label>

        <AuthErrorAlert key={authError.state?.nonce ?? 0} id="setup-error" message={authError.state?.message ?? null} errorRef={authError.errorRef} />
        <button type="submit" disabled={busy} className="mt-4 w-full rounded-lg bg-primary py-2 text-primary-foreground hover:bg-primary/80 disabled:opacity-50">
          {busy ? t("settingsSaving") : t("setupCreate")}
        </button>
      </form>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/*  Login page                                                         */
/* ------------------------------------------------------------------ */

function LoginPage({ onForgotPassword }: { onForgotPassword: () => void }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const phoneRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const { authError, report } = useAuthReporter(phoneRef, passwordRef);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    const normalizedPhone = normalizeAlgerianPhone(username);
    // a phone that cannot be a login name is a phone problem, not a password
    // problem; say so here instead of posting an empty username
    if (normalizedPhone === null) {
      report("INVALID_PHONE_NUMBER");
      return;
    }
    setBusy(true);
    authError.clear();
    try {
      const result = await authClient.signIn.username({ username: phoneToUsername(normalizedPhone), password });
      if (result.error) {
        report(authErrorKey(result.error));
        return;
      }
      window.location.reload();
    } catch (err) {
      // a rejected call (network or proxy failure) must still release the
      // button, or the user cannot retry without reloading the page
      report(serverErrorKey(err instanceof Error ? err.message : undefined));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <form onSubmit={signIn} className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-sm" dir="rtl">
        <h1 className="text-center text-2xl font-bold">{t("appTitle")}</h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">{t("appSub")}</p>

        <h2 className="mt-6 font-semibold">{t("loginHeading")}</h2>
        <label className="mt-3 grid gap-1 text-sm">
          {t("username")}
          <input ref={phoneRef} type="tel" inputMode="tel" className="rounded border border-input bg-background px-3 py-2" name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required dir="ltr" placeholder={t("phoneExample")} aria-invalid={authError.state?.field === "phone"} aria-describedby={authError.state?.field === "phone" ? "login-error" : undefined} />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("password")}
          <input ref={passwordRef} type="password" className="rounded border border-input bg-background px-3 py-2" name="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required aria-invalid={authError.state?.field === "password"} aria-describedby={authError.state?.field === "password" ? "login-error" : undefined} />
        </label>

        <AuthErrorAlert key={authError.state?.nonce ?? 0} id="login-error" message={authError.state?.message ?? null} errorRef={authError.errorRef} />
        <button type="submit" disabled={busy} className="mt-4 w-full rounded-lg bg-primary py-2 text-primary-foreground hover:bg-primary/80 disabled:opacity-50" data-testid="login-submit">
          {busy ? t("settingsSaving") : t("login")}
        </button>

        <button type="button" className="mt-4 text-xs text-muted-foreground underline" onClick={onForgotPassword}>
          {t("forgotPassword")}
        </button>
      </form>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/*  Forgot password — uses build secret                                */
/* ------------------------------------------------------------------ */

function ForgotPasswordPage({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [secret, setSecret] = useState("");
  const [phone, setPhone] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const phoneRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const { authError, report } = useAuthReporter(phoneRef, passwordRef);

  async function reset(e: React.FormEvent) {
    e.preventDefault();
    const fieldKey = authFieldKey(phone, newPassword);
    if (fieldKey !== null) {
      report(fieldKey);
      return;
    }
    setBusy(true);
    authError.clear();
    try {
      await rpcClient.authResetPassword({ secret, phoneNumber: phone, newPassword });
      setSuccess(true);
    } catch (err) {
      report(serverErrorKey(err instanceof Error ? err.message : undefined));
    } finally {
      setBusy(false);
    }
  }

  if (success) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-4">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-sm text-center" dir="rtl">
          <p className="text-sm text-muted-foreground">{t("forgotPasswordDone")}</p>
          <button onClick={onDone} className="mt-4 rounded-lg bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/80">
            {t("login")}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <form onSubmit={reset} className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-sm" dir="rtl">
        <h1 className="text-center text-2xl font-bold">{t("appTitle")}</h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">{t("forgotPasswordHint")}</p>

        <label className="mt-3 grid gap-1 text-sm">
          {t("setupSecret")}
          <input type="password" className="rounded border border-input bg-background px-3 py-2" name="secret" value={secret} onChange={(e) => setSecret(e.target.value)} required dir="ltr" />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("username")}
          <input ref={phoneRef} type="tel" inputMode="tel" className="rounded border border-input bg-background px-3 py-2" name="phone" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="username" required dir="ltr" placeholder={t("phoneExample")} aria-invalid={authError.state?.field === "phone"} aria-describedby={authError.state?.field === "phone" ? "forgot-error" : undefined} />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("password")}
          <input ref={passwordRef} type="password" className="rounded border border-input bg-background px-3 py-2" name="newPassword" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" required aria-invalid={authError.state?.field === "password"} aria-describedby={authError.state?.field === "password" ? "forgot-error" : undefined} />
        </label>

        <AuthErrorAlert key={authError.state?.nonce ?? 0} id="forgot-error" message={authError.state?.message ?? null} errorRef={authError.errorRef} />
        <button type="submit" disabled={busy} className="mt-4 w-full rounded-lg bg-primary py-2 text-primary-foreground hover:bg-primary/80 disabled:opacity-50">
          {busy ? t("settingsSaving") : t("forgotPasswordReset")}
        </button>

        <button type="button" className="mt-4 text-xs text-muted-foreground underline" onClick={onDone}>
          {t("login")}
        </button>
      </form>
    </main>
  );
}
