import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { PasswordInput } from "@/components/ui/password-input";
import {
  VaultRequestError,
  acknowledgeVaultSetup,
  fetchVaultStatus,
  fetchVaultSetupWarning,
  isVaultPassphraseLongEnough,
  readSessionTokenFromHash,
  readSetupTokenFromHash,
  storeVaultSessionToken,
  stripVaultFragment,
  vaultErrorCopy,
  vaultSetup,
  vaultUnlock,
  vaultUnlockWithRecovery,
  type VaultCleanupOutcome,
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
function VaultAlert({ message, focus }: { message: string | null; focus: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    // a field-blamed failure moves focus to that field; the alert only takes
    // focus when the failure names no single field
    if (message !== null && focus) ref.current?.focus();
  }, [message, focus]);
  if (message === null) return null;
  return (
    <p id="vault-error" ref={ref} tabIndex={-1} role="alert" className="mt-3 text-sm text-destructive" data-testid="vault-error">
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
  const [cleanup, setCleanup] = useState<VaultCleanupOutcome | undefined>(undefined);
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [screen, setScreen] = useState<"primary" | "recovery-unlock" | "recovery-show">("primary");
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState(status.lockedForMs > 0 ? Date.now() + status.lockedForMs : 0);
  const busyRef = useRef(false);
  const passphraseRef = useRef<HTMLInputElement>(null);
  /** which field a failed validation blames; null = the form-level alert */
  const [errorField, setErrorField] = useState<"passphrase" | "confirm" | "recovery" | null>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const recoveryRef = useRef<HTMLInputElement>(null);

  const lockedRemainingMs = Math.max(0, lockedUntil - Date.now());

  useEffect(() => {
    if (lockedUntil <= Date.now()) return;
    const timer = setInterval(() => {
      if (Date.now() >= lockedUntil) {
        setLockedUntil(0);
        setError(null);
        setErrorField(null);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [lockedUntil]);

  useEffect(() => {
    passphraseRef.current?.focus();
  }, [screen]);

  const fail = (
    message: string,
    field: "passphrase" | "confirm" | "recovery" | null = null,
    retryAfterMs?: number,
  ): void => {
    setError(message);
    setErrorField(field);
    if (field === "passphrase") passphraseRef.current?.focus();
    if (field === "confirm") confirmRef.current?.focus();
    if (field === "recovery") recoveryRef.current?.focus();
    if (retryAfterMs !== undefined && retryAfterMs > 0) setLockedUntil(Date.now() + retryAfterMs);
  };

  /** Drop a field-blamed failure as soon as that field is edited (#100 pattern). */
  const clearFieldError = (field: "passphrase" | "confirm" | "recovery"): void => {
    if (errorField !== field) return;
    setError(null);
    setErrorField(null);
  };

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setErrorField(null);
    try {
      await action();
    } catch (err) {
      // the API ships codes, not copy: translate here (round-6)
      fail(vaultErrorCopy(err instanceof Error ? err : undefined), null, err instanceof VaultRequestError ? err.retryAfterMs : undefined);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (status.state === "invalid") {
    return (
      <VaultFrame>
        <VaultAlert message={t("vaultInvalid")} focus />
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
        {cleanup?.status === "remaining" && (
          <p
            className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            data-testid="vault-plaintext-warning"
          >
            {t("vaultPlaintextRemaining")}
            <span className="mt-1 block font-mono text-xs break-all" dir="ltr">
              {cleanup.paths.join("\n")}
            </span>
          </p>
        )}
        {cleanup?.status === "unknown" && (
          <p
            className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            data-testid="vault-plaintext-unknown"
          >
            {t("vaultPlaintextUnknown")}
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
        {cleanup === undefined && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="vault-plaintext-checking">
            {t("vaultCheckingPlaintext")}
          </p>
        )}
        <button
          type="button"
          className="mt-4 w-full rounded-lg bg-primary py-2 text-primary-foreground hover:bg-primary/80 disabled:opacity-50"
          // the key is already on screen; keep the owner here until the sweep
          // reports (or cannot be checked), so a warning can never be missed
          // and a failed check is never mistaken for clean (round-4 finding)
          disabled={!savedConfirmed || cleanup === undefined}
          onClick={() => {
            // release the shell's key screen; the app already serves either way
            void acknowledgeVaultSetup(status.broker);
            onUnlocked();
          }}
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
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (recoveryInput === "") {
              fail(t("vaultRecoveryRequired"), "recovery");
              return;
            }
            void run(async () => {
              const token = await vaultUnlockWithRecovery(recoveryInput, status.broker);
              storeVaultSessionToken(token);
              onUnlocked();
            });
          }}
        >
          <label className="grid gap-1 text-sm">
            {t("vaultRecoveryField")}
            <input
              ref={recoveryRef}
              className="rounded border border-input bg-background px-3 py-2 font-mono"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              value={recoveryInput}
              onChange={(event) => {
                setRecoveryInput(event.target.value);
                clearFieldError("recovery");
              }}
              data-testid="vault-recovery-input"
              required
              aria-invalid={errorField === "recovery"}
              aria-describedby={errorField === "recovery" ? "vault-error" : undefined}
            />
          </label>
          <VaultAlert message={error} focus={errorField === null} />
          <button type="submit" className="rounded-lg bg-primary py-2 text-primary-foreground hover:bg-primary/80 disabled:opacity-50" disabled={busy} data-testid="vault-recovery-submit">
            {busy ? t("vaultWorking") : t("vaultUnlock")}
          </button>
          <button type="button" className="text-sm text-muted-foreground underline" onClick={() => { setScreen("primary"); setError(null); setErrorField(null); }}>
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
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!isVaultPassphraseLongEnough(passphrase)) {
              fail(t("vaultPassphraseTooShort"), "passphrase");
              return;
            }
            if (passphrase !== confirm) {
              fail(t("vaultPassphraseMismatch"), "confirm");
              return;
            }
            void run(async () => {
              const result = await vaultSetup(passphrase, readSetupTokenFromHash(), status.broker);
              storeVaultSessionToken(result.sessionToken);
              setRecoveryKey(result.recoveryKey);
              setScreen("recovery-show");
              if (status.broker) {
                // the key is on screen now: the sweep verdict follows on the
                // shell's own longer budget (round-3 finding 1); until it
                // arrives the outcome is UNKNOWN, never clean (round-4)
                setCleanup(undefined);
                void fetchVaultSetupWarning(true).then(setCleanup);
              } else {
                // the HTTP setup response already carries the sweep verdict
                setCleanup(
                  result.plaintextRemaining.length > 0
                    ? { status: "remaining", paths: result.plaintextRemaining }
                    : result.plaintextStatus === "clean"
                      ? { status: "clean" }
                      : { status: "unknown" },
                );
              }
            });
          }}
        >
          <p className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{t("vaultLostBothWarning")}</p>
          <label className="grid gap-1 text-sm">
            {t("vaultPassphrase")}
            <PasswordInput
              ref={passphraseRef}
              autoComplete="new-password"
              value={passphrase}
              onChange={(event) => {
                setPassphrase(event.target.value);
                // a mismatch blames the confirm field, but fixing the passphrase
                // to match is equally a fix; drop either stale refusal
                clearFieldError("passphrase");
                clearFieldError("confirm");
              }}
              aria-invalid={tooShort || errorField === "passphrase"}
              aria-describedby={errorField === "passphrase" ? "vault-error" : undefined}
              data-testid="vault-passphrase"
              required
            />
          </label>
          <label className="grid gap-1 text-sm">
            {t("vaultPassphraseConfirm")}
            <PasswordInput
              ref={confirmRef}
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => {
                setConfirm(event.target.value);
                clearFieldError("confirm");
              }}
              aria-invalid={mismatch || errorField === "confirm"}
              aria-describedby={errorField === "confirm" ? "vault-error" : undefined}
              data-testid="vault-passphrase-confirm"
              required
            />
          </label>
          <p className="text-xs text-muted-foreground">{t("vaultPassphraseRule")}</p>
          <VaultAlert message={error} focus={errorField === null} />
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
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (passphrase === "") {
            fail(t("vaultPassphraseRequired"), "passphrase");
            return;
          }
          void run(async () => {
            const token = await vaultUnlock(passphrase, status.broker);
            storeVaultSessionToken(token);
            onUnlocked();
          });
        }}
      >
        <label className="grid gap-1 text-sm">
          {t("vaultPassphrase")}
          <PasswordInput
            ref={passphraseRef}
            autoComplete="current-password"
            value={passphrase}
            onChange={(event) => {
              setPassphrase(event.target.value);
              clearFieldError("passphrase");
            }}
            aria-invalid={errorField === "passphrase"}
            aria-describedby={errorField === "passphrase" ? "vault-error" : undefined}
            data-testid="vault-passphrase"
            required
          />
        </label>
        <VaultAlert message={locked ? t("vaultLockedWait", { seconds: Math.ceil(lockedRemainingMs / 1000) }) : error} focus={locked || errorField === null} />
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
            setErrorField(null);
          }}
          data-testid="vault-use-recovery"
        >
          {t("vaultForgotPassphrase")}
        </button>
      </form>
    </VaultFrame>
  );
}
