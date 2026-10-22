import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { authClient, useSession } from "./lib/auth-client";
import { authErrorKey, serverErrorKey, type MessageKey } from "./lib/i18n";
import "./lib/i18n";
import { AuthErrorAlert, authFieldKey, useAuthReporter } from "./lib/auth-errors";
import { MIN_PASSWORD_LENGTH, normalizeAlgerianPhone, phoneToUsername, type Preferences } from "@dokan/contracts";
import { VaultGate, useVaultStatus } from "./components/vault/vault-gate";
import { PasswordInput } from "./components/ui/password-input";
import { readVaultSessionToken, requestVaultReclaim, type VaultBootStatus } from "./lib/vault-client";
import { useQueryClient } from "@tanstack/react-query";
import { rpcClient } from "./lib/rpc";
import { clearAuthLost, recoverAuthLost, useAuthLossReason } from "./lib/auth-refusal";
import { readSetupToken } from "./lib/setup-token";
import { PREFERENCES_QUERY_KEY, onPreferenceWriteSettled } from "./lib/preferences";
import { SIDEBAR_COLLAPSED_KEY, migrateLegacySidebarCollapsed } from "./components/app/sidebar-state";

/** The longest accepted login name: "+213550123123". */
const PHONE_MAX_LENGTH = 13;

/**
 * Whether a status answer says THIS request's credential is the live session.
 *
 * One predicate for both readers of the answer — the one probe after a refusal
 * and the re-check on focus — so they cannot disagree about what "live" means.
 * Broker mode is never a live answer here: its token lives in this page, and a
 * token the server refused cannot become live again by being asked.
 */
function isLiveSessionAnswer(fresh: VaultBootStatus | undefined): boolean {
  // a build with no vault has no vault session to be live: the legacy gate is
  // the session there
  if (fresh === undefined || fresh.mode === "disabled") return false;
  return fresh !== undefined && fresh.mode === "vault" && !fresh.broker && fresh.session;
}

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
   * The session can die under a live window — another window replaced it, the
   * owner logged out, the vault was locked. The refusal that says so must
   * land on the unlock screen, not on a page of failed queries (#319).
   *
   * Read only inside the `mode === "vault"` branch below, and that is the whole
   * scope it has. A plaintext build has no unlock screen to hold and no vault
   * cookie to protect, so a hold there could only strand the owner on a screen
   * with no exit (or, reloaded, loop on the persisted flag). The unconfirmed
   * sign-out on that build is answered where the decision is made instead: with
   * no vault route, `logout.ts` treats the local clear as the whole credential
   * and reloads (#319 round 5 P3).
   */
  const authLoss = useAuthLossReason();
  const authLost = authLoss !== undefined;
  /**
   * The gate has a second reason the re-check must cover, and it took a different
   * review family to see it (#341 fresh-eyes P1): the boot path. `vaultStatus.session`
   * describes the cookie the browser attached when that request LEFT. Window B's
   * unlock rotates the token; window A's boot read leaves with the dead cookie and
   * is answered `session: false`; B's reply then installs the live one; A's answer
   * arrives and A gates — for good, because a gated window makes no RPC call, so no
   * refusal ever arrives, and `focus`/`visibilitychange` were only wired for a
   * refusal. The only visible exit was the passphrase, which rotates the token and
   * locks B out: the ping-pong the ADR names as the thing to avoid.
   *
   * So the re-check listens when the gate is up for EITHER reason a live session
   * could clear: a refusal, or "the vault is unlocked and this page's credential is
   * not the live one".
   */
  const vaultStatusNow = vault.status;
  /**
   * Is the gate up for a reason a LIVE session could clear? That covers the boot
   * race ("unlocked, but this page's credential is not the live one") AND the
   * waiting windows (#341 round 7 P1): two windows opened before any unlock both
   * read `locked`/`unconfigured`, so a window that is still waiting had no listener
   * and never noticed the other window's unlock — it kept asking for a passphrase
   * over a vault that was already open.
   *
   * A sign-out is the one reason a live session must NOT clear, so it is the one
   * reason this is false.
   */
  const gateOpenForSession =
    vaultStatusNow !== undefined &&
    vaultStatusNow.mode === "vault" &&
    (vaultStatusNow.state !== "unlocked" ||
      (vaultStatusNow.broker ? readVaultSessionToken() !== undefined : vaultStatusNow.session) === false);
  /**
   * The in-use screen's retry asks the refused instance to re-check the folder
   * before it re-reads the status (#277). Only the button does this: a poll is
   * not a retry, or the client's rate becomes the reclaim rate (greptile P2 on
   * #298).
   */
  const retryRefusedFolder = useCallback(() => {
    void requestVaultReclaim().then(() => vault.refresh());
  }, [vault.refresh]);
  /**
   * A refusal can be TRANSIENT, and the unlock screen must not be the only way
   * out of it (#319 review P1). A query in flight across another window's
   * `changeVaultPassphrase` rotation is refused with a perfectly live cookie
   * behind it; the only other exit was re-entering the passphrase, which
   * rotates the token and refuses the window that was working — two windows
   * taking turns locking each other out. So while the refusal is up, ask the
   * server ONCE whether this request's credential is live again, and drop the
   * refusal only on that fresh answer. Recovery is a status read, not a
   * rotation.
   *
   * The answer has to be the one the probe read, not the status already on
   * screen: that one was read before the refusal, and deciding on it recovers a
   * refusal that is real. The ref bounds it to one probe per episode, because a
   * real loss would otherwise probe on every re-render. Broker mode is not
   * recoverable by asking — its token lives in this page, and a token the server
   * refused cannot become live again — so recovery there stays a reload or a
   * passphrase.
   *
   * What this can NOT promise, and does not pretend to: the answer is true at the
   * moment it was BUILT. `appliedRef` discards a read a local unlock overtook,
   * but a lock has no local `setStatus` to race — so a reply built while the
   * session was live and delivered after the lock clears the refusal and mounts
   * the app for as long as it takes the first query to come back refused, which
   * raises the gate again. Closing that window needs a value the refusal itself
   * carries (a session epoch) for the page to compare the answer against, and
   * that is a contract change, not a guard. It is not a way in: every route
   * behind the mounted app refuses on the dead session (#319 round 4).
   */
  const reprobedRef = useRef(false);
  useEffect(() => {
    if (!authLost) {
      reprobedRef.current = false;
      return;
    }
    if (reprobedRef.current) return;
    reprobedRef.current = true;
    void vault.refresh().then((fresh) => {
      // `recoverAuthLost`, not `clearAuthLost`: a sign-out the server never
      // confirmed is not undone by a live cookie (see auth-refusal.ts).
      if (isLiveSessionAnswer(fresh)) recoverAuthLost();
    });
  }, [authLost, vault.refresh]);
  /**
   * The ONE probe per episode above is answered once, and that is the round-6
   * finding (3 and 4): two windows share one cookie, and the probe can lose the
   * race for it. Window B rotates the token; window A's next call is refused; A's
   * probe leaves with the OLD cookie and reads `session: false` — and only then
   * does B's reply install the replacement in the shared jar. A holds a working
   * credential and sits on the gate, because nothing looks again.
   *
   * So while the screen is up for a REFUSAL — or for the boot race above, which
   * is the same shape one step earlier — re-check when the window becomes visible
   * again (focus, or a tab switch back). That is the cheapest shared
   * signal a browser gives two windows, it needs no channel of our own, and the
   * ordering above is exactly what it closes: probe said false, cookie was then
   * replaced, the owner comes back to this window, the next read says live.
   *
   * Bounded, and by construction rather than by a counter: a listener is not a
   * timer, so a real refusal costs one read per time the owner looks at the
   * window and never a poll — the app is not the caller's rate (the same rule
   * greptile P2 on #298 set for the reclaim tick). A read already in flight is
   * not stacked on. And it cannot demote a sign-out: the effect is attached for a
   * refusal or for a missing credential, never for `"signed-out"`, and
   * `recoverAuthLost()` refuses every other reason anyway.
   */
  const recheckInFlightRef = useRef(false);
  useEffect(() => {
    // a refusal, or the boot race above — the two reasons a LIVE session clears
    if (authLoss === "signed-out" || !gateOpenForSession) return;
    const recheck = (): void => {
      // `visibilitychange` fires for a hidden page too, and a page nobody is
      // looking at is not where a refusal gets resolved
      if (document.visibilityState === "hidden") return;
      if (recheckInFlightRef.current) return;
      recheckInFlightRef.current = true;
      void vault.refresh().then((fresh) => {
        recheckInFlightRef.current = false;
        if (isLiveSessionAnswer(fresh)) recoverAuthLost();
      });
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    // Look ONCE the moment a CREDENTIAL gate appears: the owner may be looking at
    // the window already, so no focus event will ever come. Not for a refusal —
    // that path already probed once, and a second read per episode is the thing
    // the ref exists to bound.
    recheck();
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [authLoss, gateOpenForSession, vault.refresh]);
  // The vault gate owns the first paint: no app route exists until the
  // encrypted store is open (ADR-0008 §4.6).
  if (vault.status !== undefined && vault.status.mode === "vault") {
    const vaultStatus = vault.status;
    // The browser path's credential is a cookie this page cannot read, so
    // whether this window holds one is the server's business — and the status
    // route answers it for THIS request (#319), so a window with no valid
    // cookie lands on the unlock screen instead of mounting the app and being
    // sent back there by its first refused query. The broker path's token
    // lives in this page, so a window without it has no session at all.
    const hasSession = vaultStatus.broker ? readVaultSessionToken() !== undefined : vaultStatus.session;
    if (vaultStatus.state !== "unlocked" || !hasSession || authLost) {
      return (
        <VaultGate
          status={vaultStatus}
          onUnlocked={() => {
            clearAuthLost();
            // the unlock minted a fresh credential, which is exactly what the
            // status route would now report: this window holds the live session
            vault.setStatus({ ...vaultStatus, state: "unlocked", unlocked: true, session: true });
          }}
        />
      );
    }
    return <VaultOwnerGate>{children}</VaultOwnerGate>;
  }
  // A status route that 404s means this build has no vault gate (legacy
  // plaintext) and falls through to the auth screens. A refusal that names a
  // cause gets its own screen; any other failure shows RETRY, never the legacy
  // login (finding 5).
  if (vault.failure === "in-use") return <VaultLockedByOtherInstance onRetry={retryRefusedFolder} />;
  // The stale-pid screen promises the same self-take as the in-use one, so its
  // button asks the folder too; a plain status refresh would wait for a tick the
  // copy no longer admits to (#298).
  if (vault.failure === "stale-lock") return <VaultLockStaleHeartbeat onRetry={retryRefusedFolder} />;
  if (vault.failure === "unreachable") return <VaultUnavailable onRetry={vault.refresh} />;
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
 */
function VaultLockedByOtherInstance({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return <VaultStatusScreen message={t("VAULT_LOCKED_BY_OTHER_INSTANCE")} testId="vault-status-in-use" onRetry={onRetry} />;
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
