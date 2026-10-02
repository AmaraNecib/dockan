import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  VaultRequestError,
  fetchVaultStatus,
  isVaultPassphraseLongEnough,
  readSessionTokenFromHash,
  readSetupTokenFromHash,
  storeVaultSessionToken,
  stripVaultFragment,
  vaultErrorCopy,
  vaultSetup,
  vaultUnlock,
  vaultUnlockWithRecovery,
  type VaultStatus,
} from "@/lib/vault-client";

/**
 * The pre-boot vault gate (ADR-0008 §4.6). Every app screen stays unmounted
 * until the passphrase (or a recovery key) opens the encrypted store; the
 * first run shows the recovery key exactly once before continuing.
 */

type VaultHook = {
  status: VaultStatus | undefined;
  /** "unsupported" = legacy build; "unreachable" = show retry, never login */
  failure: "unsupported" | "unreachable" | undefined;
  setStatus: (status: VaultStatus) => void;
  refresh: () => void;
};

/**
 * Fetch the vault status once; the navigation fragment may carry the session
 * token the desktop shell minted at unlock, which always lands in
 * sessionStorage before the first RPC call.
 */
export function useVaultStatus(): VaultHook {
  const [status, setStatus] = useState<VaultStatus | undefined>(undefined);
  const [failure, setFailure] = useState<"unsupported" | "unreachable" | undefined>(undefined);
  const aliveRef = useRef(true);

  const load = useCallback(() => {
    setFailure(undefined);
    fetchVaultStatus()
      .then((result) => {
        if (aliveRef.current) setStatus(result);
      })
      .catch((reason) => {
        if (!aliveRef.current) return;
        const code = reason instanceof VaultRequestError ? reason.code : "VAULT_UNREACHABLE";
        setFailure(code === "VAULT_UNSUPPORTED" ? "unsupported" : "unreachable");
      });
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    const fromHash = readSessionTokenFromHash();
    if (fromHash !== undefined) {
      storeVaultSessionToken(fromHash);
      stripVaultFragment();
    }
    load();
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  return { status, failure, setStatus, refresh: load };
}

/** A form-level error announced through role="alert". */
function VaultAlert({ message }: { message: string | null }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message !== null) ref.current?.focus();
  }, [message]);
  if (message === null) return null;
  return (
    <p ref={ref} tabIndex={-1} role="alert" className="mt-3 text-sm text-destructive" data-testid="vault-error">
      {message}
    </p>
  );
}

function VaultFrame({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-sm" dir="rtl">
        <h1 className="text-center text-2xl font-bold">{t("appTitle")}</h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">{t("vaultSubtitle")}</p>
        {children}
      </div>
    </main>
  );
}

export function VaultGate({ status, onUnlocked }: { status: VaultStatus; onUnlocked: () => void }) {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recoveryInput, setRecoveryInput] = useState("");
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [plaintextRemaining, setPlaintextRemaining] = useState<string[]>([]);
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [screen, setScreen] = useState<"primary" | "recovery-unlock" | "recovery-show">("primary");
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState(status.lockedForMs > 0 ? Date.now() + status.lockedForMs : 0);
  const busyRef = useRef(false);
  const passphraseRef = useRef<HTMLInputElement>(null);

  const lockedRemainingMs = Math.max(0, lockedUntil - Date.now());

  useEffect(() => {
    if (lockedUntil <= Date.now()) return;
    const timer = setInterval(() => {
      if (Date.now() >= lockedUntil) {
        setLockedUntil(0);
        setError(null);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [lockedUntil]);

  useEffect(() => {
    passphraseRef.current?.focus();
  }, [screen]);

  const fail = (message: string, retryAfterMs?: number): void => {
    setError(message);
    if (retryAfterMs !== undefined && retryAfterMs > 0) setLockedUntil(Date.now() + retryAfterMs);
  };

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      // the API ships codes, not copy: translate here (round-6)
      fail(vaultErrorCopy(err instanceof Error ? err : undefined), err instanceof VaultRequestError ? err.retryAfterMs : undefined);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (status.state === "invalid") {
    return (
      <VaultFrame>
        <VaultAlert message={t("vaultInvalid")} />
      </VaultFrame>
    );
  }

  if (screen === "recovery-show" && recoveryKey !== null) {
    return (
      <VaultFrame>
        <h2 className="mt-6 font-semibold">{t("vaultRecoveryTitle")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t("vaultRecoveryHint")}</p>
        <p
          className="mt-4 rounded border border-border bg-muted p-3 text-center font-mono text-sm break-all select-all"
          dir="ltr"
          data-testid="vault-recovery-key"
        >
          {recoveryKey}
        </p>
        <p className="mt-3 text-sm text-destructive">{t("vaultLostBothWarning")}</p>
        {plaintextRemaining.length > 0 && (
          <p
            className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            data-testid="vault-plaintext-warning"
          >
            {t("vaultPlaintextRemaining")}
            <span className="mt-1 block font-mono text-xs break-all" dir="ltr">
              {plaintextRemaining.join("\n")}
            </span>
          </p>
        )}
        <label className="mt-4 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={savedConfirmed}
            onChange={(event) => setSavedConfirmed(event.target.checked)}
            data-testid="vault-recovery-confirm"
          />
          <span>{t("vaultRecoveryConfirm")}</span>
        </label>
        <button
          type="button"
          className="mt-4 w-full rounded-lg bg-primary py-2 text-primary-foreground hover:bg-primary/80 disabled:opacity-50"
          disabled={!savedConfirmed}
          onClick={onUnlocked}
          data-testid="vault-recovery-continue"
        >
          {t("vaultContinue")}
        </button>
      </VaultFrame>
    );
  }

  if (screen === "recovery-unlock") {
    return (
      <VaultFrame>
        <h2 className="mt-6 font-semibold">{t("vaultRecoveryUnlockTitle")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t("vaultRecoveryUnlockHint")}</p>
        <form
          className="mt-4 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const token = await vaultUnlockWithRecovery(recoveryInput);
              storeVaultSessionToken(token);
              onUnlocked();
            });
          }}
        >
          <label className="grid gap-1 text-sm">
            {t("vaultRecoveryField")}
            <input
              className="rounded border border-input bg-background px-3 py-2 font-mono"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              value={recoveryInput}
              onChange={(event) => setRecoveryInput(event.target.value)}
              data-testid="vault-recovery-input"
              required
            />
          </label>
          <VaultAlert message={error} />
          <button type="submit" className="rounded-lg bg-primary py-2 text-primary-foreground hover:bg-primary/80 disabled:opacity-50" disabled={busy} data-testid="vault-recovery-submit">
            {busy ? t("vaultWorking") : t("vaultUnlock")}
          </button>
          <button type="button" className="text-sm text-muted-foreground underline" onClick={() => { setScreen("primary"); setError(null); }}>
            {t("vaultBackToPassphrase")}
          </button>
        </form>
      </VaultFrame>
    );
  }

  if (status.state === "unconfigured") {
    const tooShort = passphrase.length > 0 && !isVaultPassphraseLongEnough(passphrase);
    const mismatch = confirm.length > 0 && confirm !== passphrase;
    return (
      <VaultFrame>
        <h2 className="mt-6 font-semibold">{t("vaultSetupTitle")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t("vaultSetupHint")}</p>
        <form
          className="mt-4 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!isVaultPassphraseLongEnough(passphrase)) {
              setError(t("vaultPassphraseTooShort"));
              return;
            }
            if (passphrase !== confirm) {
              setError(t("vaultPassphraseMismatch"));
              return;
            }
            void run(async () => {
              const result = await vaultSetup(passphrase, readSetupTokenFromHash());
              storeVaultSessionToken(result.sessionToken);
              setRecoveryKey(result.recoveryKey);
              setPlaintextRemaining(result.plaintextRemaining);
              setScreen("recovery-show");
            });
          }}
        >
          <p className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{t("vaultLostBothWarning")}</p>
          <label className="grid gap-1 text-sm">
            {t("vaultPassphrase")}
            <input
              ref={passphraseRef}
              type="password"
              className="rounded border border-input bg-background px-3 py-2"
              autoComplete="new-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              aria-invalid={tooShort}
              data-testid="vault-passphrase"
              required
            />
          </label>
          <label className="grid gap-1 text-sm">
            {t("vaultPassphraseConfirm")}
            <input
              type="password"
              className="rounded border border-input bg-background px-3 py-2"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              aria-invalid={mismatch}
              data-testid="vault-passphrase-confirm"
              required
            />
          </label>
          <p className="text-xs text-muted-foreground">{t("vaultPassphraseRule")}</p>
          <VaultAlert message={error} />
          <button type="submit" className="rounded-lg bg-primary py-2 text-primary-foreground hover:bg-primary/80 disabled:opacity-50" disabled={busy} data-testid="vault-setup-submit">
            {busy ? t("vaultWorking") : t("vaultSetupCreate")}
          </button>
        </form>
      </VaultFrame>
    );
  }

  const locked = lockedRemainingMs > 0;
  return (
    <VaultFrame>
      <h2 className="mt-6 font-semibold">{t("vaultUnlockTitle")}</h2>
      <form
        className="mt-4 grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const token = await vaultUnlock(passphrase);
            storeVaultSessionToken(token);
            onUnlocked();
          });
        }}
      >
        <label className="grid gap-1 text-sm">
          {t("vaultPassphrase")}
          <input
            ref={passphraseRef}
            type="password"
            className="rounded border border-input bg-background px-3 py-2"
            autoComplete="current-password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            data-testid="vault-passphrase"
            required
          />
        </label>
        <VaultAlert message={locked ? t("vaultLockedWait", { seconds: Math.ceil(lockedRemainingMs / 1000) }) : error} />
        <button
          type="submit"
          className="rounded-lg bg-primary py-2 text-primary-foreground hover:bg-primary/80 disabled:opacity-50"
          disabled={busy || locked}
          data-testid="vault-unlock-submit"
        >
          {busy ? t("vaultWorking") : t("vaultUnlock")}
        </button>
        <button
          type="button"
          className="text-sm text-muted-foreground underline"
          onClick={() => {
            setScreen("recovery-unlock");
            setError(null);
          }}
          data-testid="vault-use-recovery"
        >
          {t("vaultForgotPassphrase")}
        </button>
      </form>
    </VaultFrame>
  );
}
