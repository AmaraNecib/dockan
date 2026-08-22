import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { authClient, useSession } from "./lib/auth-client";
import { tError } from "./lib/i18n";
import "./lib/i18n";
import { normalizeAlgerianPhone } from "@dokan/contracts";
import { rpcClient } from "./lib/rpc";

const toLoginName = (raw: string): string => (normalizeAlgerianPhone(raw) ?? "").slice(1);

/** Blocks children until a session exists. */
export function RequireSession({ children }: { children: ReactNode }) {
  const sessionResult = useSession();
  const { t } = useTranslation();
  if (sessionResult.isPending) {
    return <main className="grid min-h-screen place-items-center bg-stone-100 text-stone-500">{t("appSub")}</main>;
  }
  if (sessionResult.data === null) {
    return <LoginPage />;
  }
  return <>{children}</>;
}

function LoginPage() {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [showSetup, setShowSetup] = useState(false);
  const [secret, setSecret] = useState("");
  const [setupPhone, setSetupPhone] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupMessage, setSetupMessage] = useState<string | null>(null);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const result = await authClient.signIn.username({
      username: toLoginName(username),
      password,
    });
    if (result.error) {
      setError(tError(result.error.message ?? "UNEXPECTED"));
      return;
    }
    window.location.reload();
  }

  async function runFirstTimeSetup(event: React.FormEvent) {
    event.preventDefault();
    setSetupBusy(true);
    setSetupMessage(null);
    try {
      await rpcClient.authResetPassword({
        secret,
        phoneNumber: setupPhone,
        newPassword: setupPassword,
      });
      setSetupMessage(t("resetDone"));
      setUsername(toLoginName(setupPhone));
      setPassword(setupPassword);
      setShowSetup(false);
    } catch (err) {
      setSetupMessage(err instanceof Error ? tError(err.message) : t("unexpected"));
    } finally {
      setSetupBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-stone-100 p-4">
      <form onSubmit={signIn} className="w-full max-w-sm rounded-2xl border bg-white p-6 shadow-sm" dir="rtl">
        <h1 className="text-center text-2xl font-bold">{t("appTitle")}</h1>
        <p className="mt-1 text-center text-sm text-stone-500">{t("appSub")}</p>

        <h2 className="mt-6 font-semibold">{t("loginHeading")}</h2>
        <label className="mt-3 grid gap-1 text-sm">
          {t("username")}
          <input className="rounded border px-3 py-2" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required dir="ltr" />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("password")}
          <input type="password" className="rounded border px-3 py-2" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <button className="mt-4 w-full rounded-lg bg-stone-900 py-2 text-white hover:bg-stone-700" data-testid="login-submit">
          {t("login")}
        </button>

        <button type="button" className="mt-4 text-xs text-stone-500 underline" onClick={() => setShowSetup(!showSetup)}>
          {t("firstTime")}
        </button>
        {setupMessage && <p className="mt-2 text-sm text-stone-600" data-testid="setup-message">{setupMessage}</p>}
        {showSetup && (
          <fieldset className="mt-3 rounded border border-dashed p-3">
            <legend className="px-1 text-xs">{t("setupHeading")}</legend>
            <label className="grid gap-1 text-sm">
              {t("secret")}
              <input type="password" className="rounded border px-3 py-2" value={secret} onChange={(e) => setSecret(e.target.value)} data-testid="setup-secret" required />
            </label>
            <label className="mt-2 grid gap-1 text-sm">
              {t("username")}
              <input className="rounded border px-3 py-2" value={setupPhone} onChange={(e) => setSetupPhone(e.target.value)} data-testid="setup-phone" required dir="ltr" />
            </label>
            <label className="mt-2 grid gap-1 text-sm">
              {t("password")}
              <input type="password" className="rounded border px-3 py-2" value={setupPassword} onChange={(e) => setSetupPassword(e.target.value)} data-testid="setup-password" required />
            </label>
            <button type="button" disabled={setupBusy} onClick={runFirstTimeSetup} className="mt-3 w-full rounded-lg border py-2 text-sm hover:bg-stone-100" data-testid="setup-submit">
              {setupBusy ? t("resetBusy") : t("setupHeading")}
            </button>
          </fieldset>
        )}
      </form>
    </main>
  );
}

export function App() {
  const { t } = useTranslation();
  const sessionResult = useSession();
  return (
    <RequireSession>
      <main className="min-h-screen bg-stone-100 p-6">
        <h1 className="text-xl font-bold">{t("home")}</h1>
        <p className="mt-2 text-stone-600">{t("homeHint")}</p>
        {sessionResult.data && (
          <button
            className="mt-6 rounded-lg border bg-white px-4 py-2 text-sm"
            onClick={() => {
              void authClient.signOut().finally(() => window.location.reload());
            }}
          >
            {t("logout")}
          </button>
        )}
      </main>
    </RequireSession>
  );
}