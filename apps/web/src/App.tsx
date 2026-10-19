import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { authClient, useSession } from "./lib/auth-client";
import { authErrorKey, ltrIsolate, serverErrorKey, type MessageKey } from "./lib/i18n";
import "./lib/i18n";
import { AuthErrorAlert, authFieldKey, useAuthReporter } from "./lib/auth-errors";
import { MIN_PASSWORD_LENGTH, normalizeAlgerianPhone, phoneToUsername, type Preferences } from "@dokan/contracts";
import { VaultGate, useVaultStatus } from "./components/vault/vault-gate";
import { PasswordInput } from "./components/ui/password-input";
import { readVaultSessionToken, requestVaultReclaim, type VaultLockHolder } from "./lib/vault-client";
import { useQueryClient } from "@tanstack/react-query";
import { rpcClient } from "./lib/rpc";
import { readSetupToken } from "./lib/setup-token";
import { PREFERENCES_QUERY_KEY, onPreferenceWriteSettled } from "./lib/preferences";
import { SIDEBAR_COLLAPSED_KEY, migrateLegacySidebarCollapsed } from "./components/app/sidebar-state";

/** The longest accepted login name: "+213550123123". */
const PHONE_MAX_LENGTH = 13;

/**
 * The setup name rules (`firstTimeSetupInputSchema`: `z.string().trim().min(1)`),
 * checked before the request so an empty or whitespace-only name is named in
 * Arabic instead of reaching the API and reading as a generic failure.
 */
function setupNameKey(ownerName: string, storeName: string): MessageKey | null {
  if (ownerName.trim() === "") return "AUTH_OWNER_NAME_REQUIRED";
  if (storeName.trim() === "") return "AUTH_STORE_NAME_REQUIRED";
  return null;
}

/** Blocks children until a session exists; preferences import in the background. */
export function RequireSession({ children }: { children: ReactNode }) {
  const vault = useVaultStatus();
  /**
   * The in-use screen's retry asks the refused instance to re-check the folder
   * before it re-reads the status (#277). Only the button does this: a poll is
   * not a retry, or the client's rate becomes the reclaim rate (greptile P2 on
   * #298).
   */
  const retryRefusedFolder = useCallback(() => {
    void requestVaultReclaim().then(() => vault.refresh());
  }, [vault.refresh]);
  // The vault gate owns the first paint: no app route exists until the
  // encrypted store is open (ADR-0008 §4.6).
  if (vault.status !== undefined && vault.status.mode === "vault") {
    const vaultStatus = vault.status;
    // A client without the in-process session token is treated as locked even
    // when the server stays unlocked: a new window must re-enter the passphrase
    // rather than inherit access it was never given.
    const hasSession = readVaultSessionToken() !== undefined;
    if (vaultStatus.state !== "unlocked" || !hasSession) {
      return (
        <VaultGate
          status={vaultStatus}
          onUnlocked={() => vault.setStatus({ ...vaultStatus, state: "unlocked", unlocked: true })}
        />
      );
    }
    return <VaultOwnerGate>{children}</VaultOwnerGate>;
  }
  // A status route that 404s means this build has no vault gate (legacy
  // plaintext) and falls through to the auth screens. A refusal that names a
  // cause gets its own screen; any other failure shows RETRY, never the legacy
  // login (finding 5).
  if (vault.failure?.kind === "in-use") return <VaultLockedByOtherInstance holder={vault.failure.holder} onRetry={retryRefusedFolder} />;
  if (vault.failure?.kind === "stale-lock") return <VaultLockStaleHeartbeat onRetry={vault.refresh} />;
  if (vault.failure?.kind === "unreachable") return <VaultUnavailable onRetry={vault.refresh} />;
  if (vault.status === undefined && vault.failure === undefined) return <LoadingScreen />;
  return <LegacySessionGate>{children}</LegacySessionGate>;
}

/**
 * A vault status that could not be read. Both causes keep the owner on this
 * screen instead of the legacy login; only the story differs.
 */
function VaultStatusScreen({ message, testId, onRetry }: { message: string; testId: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <div className="grid w-full max-w-sm gap-3 rounded-2xl border border-border bg-card p-6 text-center shadow-sm" dir="rtl">
        <p className="text-sm text-destructive" role="alert" data-testid={testId}>
          {message}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/80"
          data-testid="vault-status-retry"
        >
          {t("itemsSearchRetry")}
        </button>
      </div>
    </main>
  );
}

/** The API booted but the vault status could not be read: retry, never login. */
function VaultUnavailable({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return <VaultStatusScreen message={t("startupCheckFailed")} testId="vault-status-unavailable" onRetry={onRetry} />;
}

/**
 * Another copy of Dokan holds the data folder. The API refuses with
 * VAULT_LOCKED_BY_OTHER_INSTANCE, so the owner is told to close that copy
 * instead of being told to start a server that is already answering. Retry is
 * the same call: it succeeds once that copy has released the folder, and it
 * never becomes an unlock form while the refusal stands (#276).
 *
 * The refusal names the holder — its machine and its process (#274) — so the
 * owner can tell WHICH copy to close when several are open. A refusal that
 * named no holder keeps the sentence without one: naming a copy nobody can
 * point at is worse than naming none.
 */
function VaultLockedByOtherInstance({ holder, onRetry }: { holder: VaultLockHolder | undefined; onRetry: () => void }) {
  const { t } = useTranslation();
  const message =
    holder === undefined
      ? t("VAULT_LOCKED_BY_OTHER_INSTANCE")
      : t("vaultLockHeldBy", { host: ltrIsolate(holder.host), pid: ltrIsolate(String(holder.pid)) });
  return <VaultStatusScreen message={message} testId="vault-status-in-use" onRetry={onRetry} />;
}

/**
 * The folder is locked by an alive pid that stopped beating (#283), which most
 * likely means a dead holder's pid the OS recycled. There may be no other Dokan
 * copy to close, so the copy names the lock file as the exit, under the one
 * condition that keeps it safe: the owner first confirms no other copy is open.
 */
function VaultLockStaleHeartbeat({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return <VaultStatusScreen message={t("vaultLockStaleHeartbeat")} testId="vault-status-stale-lock" onRetry={onRetry} />;
}

/** Owner provisioning after the vault is open (no separate login exists). */
const OWNER_CHECK_RETRY_DELAYS_MS = [200, 500, 1_000] as const;

function VaultOwnerGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [setupBlocked, setSetupBlocked] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const checkSeqRef = useRef(0);
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useSidebarPreferenceMigration(needsSetup === false);

  const checkSetup = useCallback(() => {
    const seq = ++checkSeqRef.current;
    if (retryTimerRef.current !== undefined) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = undefined;
    }
    setNeedsSetup(null);
    setSetupBlocked(false);
    setCheckFailed(false);
    rpcClient
      .needsSetup()
      .then((res) => {
        if (seq !== checkSeqRef.current) return;
        retryAttemptRef.current = 0;
        setNeedsSetup(res.needsSetup);
        setSetupBlocked(res.setupBlocked);
      })
      .catch(() => {
        if (seq !== checkSeqRef.current) return;
        // a brief proxy/API interruption after unlock must not hang the
        // loading screen forever: retry a bounded number of times, then show
        // the owner a working retry button (round-7 finding 4)
        const delay = OWNER_CHECK_RETRY_DELAYS_MS[retryAttemptRef.current];
        if (delay !== undefined) {
          retryAttemptRef.current += 1;
          retryTimerRef.current = setTimeout(() => checkSetup(), delay);
          return;
        }
        setCheckFailed(true);
      });
  }, []);

  useEffect(() => {
    checkSetup();
    return () => {
      if (retryTimerRef.current !== undefined) clearTimeout(retryTimerRef.current);
    };
  }, [checkSetup]);

  if (checkFailed) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-4">
        <div className="grid w-full max-w-sm gap-3 rounded-2xl border border-border bg-card p-6 text-center shadow-sm" dir="rtl">
          <p className="text-sm text-destructive" role="alert" data-testid="owner-check-failed">
            {t("startupCheckFailed")}
          </p>
          <button
            type="button"
            onClick={() => {
              retryAttemptRef.current = 0;
              checkSetup();
            }}
            className="rounded-lg bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/80"
            data-testid="owner-check-retry"
          >
            {t("itemsSearchRetry")}
          </button>
        </div>
      </main>
    );
  }
  if (needsSetup === null) return <LoadingScreen />;
  if (setupBlocked) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-4">
        <div className="grid w-full max-w-sm gap-3 rounded-2xl border border-border bg-card p-6 text-center shadow-sm" dir="rtl">
          <p className="text-sm text-destructive" role="alert" data-testid="setup-blocked">
            {t("SETUP_DATABASE_NOT_EMPTY")}
          </p>
          <button type="button" onClick={checkSetup} className="rounded-lg bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/80" data-testid="setup-blocked-retry">
            {t("itemsSearchRetry")}
          </button>
        </div>
      </main>
    );
  }
  if (needsSetup) return <SetupPage vaultMode onDone={() => setNeedsSetup(false)} />;
  return <>{children}</>;
}

/**
 * One-time background import of the pre-server sidebar preference, plus a
 * retry when the owner's competing write loses.
 *
 * The import must never block the scanner, so it runs once per mount and skips
 * itself while the owner's write is in flight (that write should win). But if
 * that write fails, the skipped import would leave the sidebar at the default
 * until the next launch; the settled-write subscription re-runs the import
 * instead (issue #115). The import's own direct write does not notify, so this
 * cannot loop.
 *
 * A refusal to run while an import is in flight must remember the request:
 * when the migration read and the failed write settle in the same turn, the
 * failure listener runs before the in-flight guard clears, and "not now"
 * quietly becomes "never". One pending bit, not a queue — a second request
 * while one is pending is the same request (issue #115, PR #241 review).
 */
function useSidebarPreferenceMigration(enabled: boolean): void {
  const queryClient = useQueryClient();
  const migrationStarted = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    let importing = false;
    // a retry asked for while an import is in flight; one bit, not a queue
    let retryPending = false;
    const importLegacy = () => {
      if (importing) {
        retryPending = true;
        return;
      }
      importing = true;
      void migrateLegacySidebarCollapsed()
        .then((imported) => {
          if (imported === null) return;
          // install the imported value so the sidebar does not wait for the
          // next refetch, then reconcile the full map
          queryClient.setQueryData<Preferences>(PREFERENCES_QUERY_KEY, (previous) =>
            previous === undefined ? previous : { ...previous, [SIDEBAR_COLLAPSED_KEY]: imported },
          );
          void queryClient.invalidateQueries({ queryKey: PREFERENCES_QUERY_KEY });
        })
        .finally(() => {
          importing = false;
          // the import this retry was refused for has settled: run it now
          if (retryPending) {
            retryPending = false;
            importLegacy();
          }
        });
    };

    // one-shot per mount: StrictMode's double effect must not import twice
    if (!migrationStarted.current) {
      migrationStarted.current = true;
      importLegacy();
    }

    // ...but a competing write that fails means the import was skipped for a
    // choice that never landed, so re-run it now (issue #115)
    return onPreferenceWriteSettled((key, ok) => {
      if (key === SIDEBAR_COLLAPSED_KEY && !ok) importLegacy();
    });
  }, [enabled, queryClient]);
}

/** The legacy plaintext path: better-auth session, setup or login. */
function LegacySessionGate({ children }: { children: ReactNode }) {
  const sessionResult = useSession();
  useSidebarPreferenceMigration(sessionResult.data !== null && !sessionResult.isPending);

  if (sessionResult.isPending) {
    return <LoadingScreen />;
  }
  if (sessionResult.data === null) {
    return <AuthGate />;
  }
  return <>{children}</>;
}

/** Decides whether to show setup, the blocked screen, or login. */
function AuthGate() {
  const { t } = useTranslation();
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [setupBlocked, setSetupBlocked] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  /** the reason the setup form handed the owner to the login form */
  const [loginNotice, setLoginNotice] = useState<MessageKey | null>(null);
  const consumeLoginNotice = useCallback(() => setLoginNotice(null), []);
  // only the newest check may write state: Strict Mode starts two of them, and
  // without this a slow failure can overwrite a success and strand the owner on
  // the retry screen after a check that actually worked
  const checkSeqRef = useRef(0);

  const checkSetup = useCallback(() => {
    const seq = ++checkSeqRef.current;
    setNeedsSetup(null);
    setSetupBlocked(false);
    setCheckFailed(false);
    rpcClient
      .needsSetup()
      .then((res) => {
        if (seq !== checkSeqRef.current) return;
        setNeedsSetup(res.needsSetup);
        setSetupBlocked(res.setupBlocked);
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

  // No owner, but the database already holds shop data: setup is refused and
  // login has no account to accept. Say what happened instead of showing a
  // form that cannot succeed (ADR-0008 §4.1).
  if (setupBlocked) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-4">
        <div className="grid w-full max-w-sm gap-3 rounded-2xl border border-border bg-card p-6 text-center shadow-sm" dir="rtl">
          <p className="text-sm text-destructive" role="alert" data-testid="setup-blocked">
            {t("SETUP_DATABASE_NOT_EMPTY")}
          </p>
          <button type="button" onClick={checkSetup} className="rounded-lg bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/80" data-testid="setup-blocked-retry">
            {t("itemsSearchRetry")}
          </button>
        </div>
      </main>
    );
  }

  if (needsSetup) {
    return (
      <SetupPage
        onDone={(notice) => {
          setLoginNotice(notice ?? null);
          setNeedsSetup(false);
        }}
      />
    );
  }
  return <LoginPage notice={loginNotice} onNoticeConsumed={consumeLoginNotice} />;
}

function LoadingScreen() {
  const { t } = useTranslation();
  return <main className="grid min-h-screen place-items-center bg-background text-muted-foreground">{t("appSub")}</main>;
}

/* ------------------------------------------------------------------ */
/*  Setup page — first time only                                       */
/* ------------------------------------------------------------------ */

function SetupPage({ onDone, vaultMode = false }: { onDone: (notice?: MessageKey) => void; vaultMode?: boolean }) {
  const { t } = useTranslation();
  const [ownerName, setOwnerName] = useState("");
  const [storeName, setStoreName] = useState("");
  const [storeAddress, setStoreAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const ownerNameRef = useRef<HTMLInputElement>(null);
  const storeNameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const { authError, report } = useAuthReporter(phoneRef, passwordRef, ownerNameRef, storeNameRef);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // the disabled button does not stop an implicit Enter submit
    if (busyRef.current) return;
    // the native `required` is off (noValidate), so the same non-empty rule has
    // to be written here — empty or whitespace-only names included
    const nameKey = setupNameKey(ownerName, storeName);
    if (nameKey !== null) {
      report(nameKey);
      return;
    }
    // same rules the contracts enforce, checked before the request so the owner
    // is told which field is wrong instead of seeing a generic failure. In
    // vault mode the passphrase already exists, so only the phone is checked.
    if (vaultMode) {
      if (normalizeAlgerianPhone(phone) === null) {
        report("INVALID_PHONE_NUMBER");
        return;
      }
    } else {
      const fieldKey = authFieldKey(phone, password);
      if (fieldKey !== null) {
        report(fieldKey);
        return;
      }
    }
    busyRef.current = true;
    setBusy(true);
    authError.clear();
    try {
      await rpcClient.firstTimeSetup({
        ownerName,
        phoneNumber: phone,
        // vault mode: no password exists; the passphrase is the credential
        password: vaultMode ? undefined : password,
        storeName,
        storeAddress: storeAddress || undefined,
        // Packaged installs: the one-time token the shell put in the URL
        // fragment. Absent in dev/e2e; the api ignores it there.
        setupToken: readSetupToken(),
      });
      onDone();
    } catch (err) {
      const key = serverErrorKey(err instanceof Error ? err.message : undefined);
      // another client finished setup first: the instruction is "sign in", so
      // hand the owner to the form that can carry it out, message included
      if (key === "SETUP_ALREADY_DONE") {
        onDone(key);
        return;
      }
      report(key);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <form onSubmit={submit} noValidate className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-sm" dir="rtl">
        <h1 className="text-center text-2xl font-bold">{t("appTitle")}</h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">{t("appSub")}</p>

        <h2 className="mt-6 font-semibold">{t("setupWelcome")}</h2>

        <label className="mt-3 grid gap-1 text-sm">
          {t("setupOwnerName")}
          <input ref={ownerNameRef} className="rounded border border-input bg-background px-3 py-2" name="ownerName" autoComplete="name" value={ownerName} onChange={(e) => { setOwnerName(e.target.value); authError.clearField("ownerName"); }} required aria-invalid={authError.state?.field === "ownerName"} aria-describedby={authError.state?.field === "ownerName" ? "setup-error" : undefined} />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("setupStoreName")}
          <input ref={storeNameRef} className="rounded border border-input bg-background px-3 py-2" name="storeName" autoComplete="organization" value={storeName} onChange={(e) => { setStoreName(e.target.value); authError.clearField("storeName"); }} required aria-invalid={authError.state?.field === "storeName"} aria-describedby={authError.state?.field === "storeName" ? "setup-error" : undefined} />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("setupStoreAddress")}
          <input className="rounded border border-input bg-background px-3 py-2" name="storeAddress" autoComplete="street-address" value={storeAddress} onChange={(e) => setStoreAddress(e.target.value)} />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("username")}
          <input ref={phoneRef} type="tel" inputMode="tel" maxLength={PHONE_MAX_LENGTH} className="rounded border border-input bg-background px-3 py-2" name="phone" value={phone} onChange={(e) => { setPhone(e.target.value); authError.clearField("phone"); }} autoComplete="username" required dir="ltr" placeholder={t("phoneExample")} aria-invalid={authError.state?.field === "phone"} aria-describedby={authError.state?.field === "phone" ? "setup-error" : undefined} />
        </label>
        {!vaultMode && (
          <label className="mt-3 grid gap-1 text-sm">
            {t("password")}
            <PasswordInput ref={passwordRef} minLength={MIN_PASSWORD_LENGTH} name="password" value={password} onChange={(e) => { setPassword(e.target.value); authError.clearField("password"); }} autoComplete="new-password" required aria-invalid={authError.state?.field === "password"} aria-describedby={authError.state?.field === "password" ? "setup-error" : undefined} data-testid="setup-password" />
          </label>
        )}


        <AuthErrorAlert key={authError.state?.nonce ?? 0} id="setup-error" message={authError.state?.message ?? null} errorRef={authError.errorRef} field={authError.state?.field ?? null} />
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

function LoginPage({ notice, onNoticeConsumed }: { notice: MessageKey | null; onNoticeConsumed: () => void }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const phoneRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const { authError, report } = useAuthReporter(phoneRef, passwordRef);

  // setup hands over the reason it sent the owner here; announce it once and
  // consume it, so a later return to this form does not repeat it
  const noticeShownRef = useRef(false);
  useEffect(() => {
    if (notice === null || noticeShownRef.current) return;
    noticeShownRef.current = true;
    report(notice);
    onNoticeConsumed();
  }, [notice, report, onNoticeConsumed]);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    if (busyRef.current) return;
    const normalizedPhone = normalizeAlgerianPhone(username);
    // a phone that cannot be a login name is a phone problem, not a password
    // problem; say so here instead of posting an empty username
    if (normalizedPhone === null) {
      report("INVALID_PHONE_NUMBER");
      return;
    }
    // the native `required`/`minLength` are off (noValidate): an empty or short
    // password is refused here rather than posting a request that cannot pass
    if (password.length < MIN_PASSWORD_LENGTH) {
      report("AUTH_PASSWORD_TOO_SHORT");
      return;
    }
    busyRef.current = true;
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
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <form onSubmit={signIn} noValidate className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-sm" dir="rtl">
        <h1 className="text-center text-2xl font-bold">{t("appTitle")}</h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">{t("appSub")}</p>

        <h2 className="mt-6 font-semibold">{t("loginHeading")}</h2>
        <label className="mt-3 grid gap-1 text-sm">
          {t("username")}
          <input ref={phoneRef} type="tel" inputMode="tel" maxLength={PHONE_MAX_LENGTH} className="rounded border border-input bg-background px-3 py-2" name="username" value={username} onChange={(e) => { setUsername(e.target.value); authError.clearField("phone"); }} autoComplete="username" required dir="ltr" placeholder={t("phoneExample")} aria-invalid={authError.state?.field === "phone"} aria-describedby={authError.state?.field === "phone" ? "login-error" : undefined} />
        </label>
        <label className="mt-3 grid gap-1 text-sm">
          {t("password")}
          <PasswordInput ref={passwordRef} minLength={MIN_PASSWORD_LENGTH} name="password" value={password} onChange={(e) => { setPassword(e.target.value); authError.clearField("password"); }} autoComplete="current-password" required aria-invalid={authError.state?.field === "password"} aria-describedby={authError.state?.field === "password" ? "login-error" : undefined} data-testid="login-password" />
        </label>

        <AuthErrorAlert key={authError.state?.nonce ?? 0} id="login-error" message={authError.state?.message ?? null} errorRef={authError.errorRef} field={authError.state?.field ?? null} />
        <button type="submit" disabled={busy} className="mt-4 w-full rounded-lg bg-primary py-2 text-primary-foreground hover:bg-primary/80 disabled:opacity-50" data-testid="login-submit">
          {busy ? t("settingsSaving") : t("login")}
        </button>
      </form>
    </main>
  );
}
