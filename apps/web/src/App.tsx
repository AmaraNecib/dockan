import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { authClient, useSession } from "./lib/auth-client";
import { tError } from "./lib/i18n";
import "./lib/i18n";
import { normalizeAlgerianPhone } from "@dokan/contracts";
import { rpcClient } from "./lib/rpc";

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
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [view, setView] = useState<"login" | "forgot">("login");

  useEffect(() => {
    rpcClient.needsSetup().then((res) => setNeedsSetup(res.needsSetup)).catch(() => setNeedsSetup(false));
  }, []);

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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await rpcClient.firstTimeSetup({
        ownerName,
        phoneNumber: phone,
        password,
        storeName,
        storeAddress: storeAddress || undefined,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? tError(err.message) : t("unexpected"));
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
          <input className="rounded border border-input bg-background px-3 py-2" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} required />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("setupStoreName")}
          <input className="rounded border border-input bg-background px-3 py-2" value={storeName} onChange={(e) => setStoreName(e.target.value)} required />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("setupStoreAddress")}
          <input className="rounded border border-input bg-background px-3 py-2" value={storeAddress} onChange={(e) => setStoreAddress(e.target.value)} />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("username")}
          <input className="rounded border border-input bg-background px-3 py-2" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="username" required dir="ltr" placeholder="0550123456" />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("password")}
          <input type="password" className="rounded border border-input bg-background px-3 py-2" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={4} />
        </label>

        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const loginName = (normalizeAlgerianPhone(username) ?? "").slice(1);
    const result = await authClient.signIn.username({ username: loginName, password });
    if (result.error) {
      setError(tError(result.error.message ?? "UNEXPECTED"));
      setBusy(false);
      return;
    }
    window.location.reload();
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <form onSubmit={signIn} className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-sm" dir="rtl">
        <h1 className="text-center text-2xl font-bold">{t("appTitle")}</h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">{t("appSub")}</p>

        <h2 className="mt-6 font-semibold">{t("loginHeading")}</h2>
        <label className="mt-3 grid gap-1 text-sm">
          {t("username")}
          <input className="rounded border border-input bg-background px-3 py-2" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required dir="ltr" />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("password")}
          <input type="password" className="rounded border border-input bg-background px-3 py-2" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>

        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
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
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  async function reset(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await rpcClient.authResetPassword({ secret, phoneNumber: phone, newPassword });
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? tError(err.message) : t("unexpected"));
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
          <input className="rounded border border-input bg-background px-3 py-2" value={secret} onChange={(e) => setSecret(e.target.value)} required dir="ltr" />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("username")}
          <input className="rounded border border-input bg-background px-3 py-2" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="username" required dir="ltr" />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("password")}
          <input type="password" className="rounded border border-input bg-background px-3 py-2" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" required minLength={4} />
        </label>

        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
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
