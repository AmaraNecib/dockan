import { useState, type ReactNode } from "react";

import { authClient, toLoginName, useSession } from "./lib/auth-client";
import { rpcClient } from "./lib/rpc";

const A = {
  title: "دكان",
  appSub: "متجر إكسسوارات السيارات",
  loginHeading: "تسجيل الدخول",
  username: "رقم الهاتف",
  password: "كلمة السر",
  login: "دخول",
  logout: "خروج",
  wrongCredentials: "رقم الهاتف أو كلمة السر غير صحيحة",
  firstTime: "المرة الأولى؟ أنشئ كلمة السر بالرمز السري",
  setupHeading: "الإعداد الأول (الرمز السري)",
  secret: "الرمز السري",
  resetDone: "تم الإعداد، سجّل الدخول الآن",
  resetBusy: "…",
  home: "تم تسجيل الدخول بنجاح",
  homeHint: "يمكنك القدوم إلى المتجر وبدء البيع.",
  unexpected: "حدث خطأ غير متوقع",
};

/** Blocks children until a session exists. */
export function RequireSession({ children }: { children: ReactNode }) {
  const sessionResult = useSession();
  if (sessionResult.isPending) {
    return <main className="grid min-h-screen place-items-center bg-stone-100 text-stone-500">{A.appSub}</main>;
  }
  if (sessionResult.data === null) {
    return <LoginPage />;
  }
  return <>{children}</>;
}

function LoginPage() {
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
      setError(result.error.message ?? A.wrongCredentials);
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
      setSetupMessage(A.resetDone);
      setUsername(toLoginName(setupPhone));
      setPassword(setupPassword);
      setShowSetup(false);
    } catch (err) {
      setSetupMessage(err instanceof Error ? err.message : A.unexpected);
    } finally {
      setSetupBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-stone-100 p-4">
      <form onSubmit={signIn} className="w-full max-w-sm rounded-2xl border bg-white p-6 shadow-sm" dir="rtl">
        <h1 className="text-center text-2xl font-bold">{A.title}</h1>
        <p className="mt-1 text-center text-sm text-stone-500">{A.appSub}</p>

        <h2 className="mt-6 font-semibold">{A.loginHeading}</h2>
        <label className="mt-3 grid gap-1 text-sm">
          {A.username}
          <input className="rounded border px-3 py-2" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required dir="ltr" />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {A.password}
          <input type="password" className="rounded border px-3 py-2" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <button className="mt-4 w-full rounded-lg bg-stone-900 py-2 text-white hover:bg-stone-700" data-testid="login-submit">
          {A.login}
        </button>

        <button type="button" className="mt-4 text-xs text-stone-500 underline" onClick={() => setShowSetup(!showSetup)}>
          {A.firstTime}
        </button>
        {setupMessage && <p className="mt-2 text-sm text-stone-600" data-testid="setup-message">{setupMessage}</p>}
        {showSetup && (
          <fieldset className="mt-3 rounded border border-dashed p-3">
            <legend className="px-1 text-xs">{A.setupHeading}</legend>
            <label className="grid gap-1 text-sm">
              {A.secret}
              <input type="password" className="rounded border px-3 py-2" value={secret} onChange={(e) => setSecret(e.target.value)} data-testid="setup-secret" required />
            </label>
            <label className="mt-2 grid gap-1 text-sm">
              {A.username}
              <input className="rounded border px-3 py-2" value={setupPhone} onChange={(e) => setSetupPhone(e.target.value)} data-testid="setup-phone" required dir="ltr" />
            </label>
            <label className="mt-2 grid gap-1 text-sm">
              {A.password}
              <input type="password" className="rounded border px-3 py-2" value={setupPassword} onChange={(e) => setSetupPassword(e.target.value)} data-testid="setup-password" required />
            </label>
            <button type="button" disabled={setupBusy} onClick={runFirstTimeSetup} className="mt-3 w-full rounded-lg border py-2 text-sm hover:bg-stone-100" data-testid="setup-submit">
              {setupBusy ? A.resetBusy : A.setupHeading}
            </button>
          </fieldset>
        )}
      </form>
    </main>
  );
}

export function App() {
  const sessionResult = useSession();
  return (
    <RequireSession>
      <main className="min-h-screen bg-stone-100 p-6">
        <h1 className="text-xl font-bold">{A.home}</h1>
        <p className="mt-2 text-stone-600">{A.homeHint}</p>
        {sessionResult.data && (
          <button
            className="mt-6 rounded-lg border bg-white px-4 py-2 text-sm"
            onClick={() => {
              void authClient.signOut().finally(() => window.location.reload());
            }}
          >
            {A.logout}
          </button>
        )}
      </main>
    </RequireSession>
  );
}