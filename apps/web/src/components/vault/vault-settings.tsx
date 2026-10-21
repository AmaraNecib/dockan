import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { PasswordInput } from "@/components/ui/password-input";
import {
  addRecoveryKey,
  changeVaultPassphrase,
  fetchVaultStatus,
  isVaultPassphraseLongEnough,
  listRecoveryKeys,
  removeRecoveryKey,
  resetVaultPassphrase,
  vaultErrorCopy,
} from "@/lib/vault-client";

/**
 * The settings-side vault controls (ADR-0008 §4.3): change the passphrase and
 * rotate the recovery keys while the vault is open. A new key is shown exactly
 * once; deleting one never touches the others.
 */

/** The input a settings-side refusal points at; null means the summary. */
type VaultSettingsField = "current" | "newPassphrase" | "confirm" | "recoveryKey" | "resetPassphrase" | null;

export function VaultSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["vault", "status"], queryFn: fetchVaultStatus, retry: false });
  const keys = useQuery({
    queryKey: ["vault", "recovery-keys"],
    queryFn: listRecoveryKeys,
    enabled: status.data?.mode === "vault" && status.data.state === "unlocked",
    retry: false,
  });

  const [currentPassphrase, setCurrentPassphrase] = useState("");
  const [newPassphrase, setNewPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  // A failure and the field it blames are ONE value: setting one always sets
  // the other, so a server error that names no field can never strand a stale
  // field blame (and edit-clear can never swallow an unrelated message).
  const [failure, setFailure] = useState<{ message: string; field: VaultSettingsField } | null>(null);
  const error = failure?.message ?? null;
  const errorField = failure?.field ?? null;
  const [newKey, setNewKey] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [showRecoveryReset, setShowRecoveryReset] = useState(false);
  const [resetRecoveryKey, setResetRecoveryKey] = useState("");
  const [resetNewPassphrase, setResetNewPassphrase] = useState("");
  const currentRef = useRef<HTMLInputElement>(null);
  const newRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const recoveryKeyRef = useRef<HTMLInputElement>(null);
  const resetPassphraseRef = useRef<HTMLInputElement>(null);

  const changePassphrase = useMutation({
    mutationFn: () => changeVaultPassphrase(currentPassphrase, newPassphrase),
    onSuccess: () => {
      // a credential change rotates the session: the browser path's cookie is
      // replaced by the response, the broker path's token is kept in memory
      setMessage(t("vaultChanged"));
      setFailure(null);
      setCurrentPassphrase("");
      setNewPassphrase("");
      setConfirmPassphrase("");
    },
    onError: (err) => setFailure({ message: vaultErrorCopy(err), field: null }),
  });

  const createKey = useMutation({
    mutationFn: addRecoveryKey,
    onSuccess: (created) => {
      setNewKey(created.code);
      void queryClient.invalidateQueries({ queryKey: ["vault", "recovery-keys"] });
    },
    onError: (err) => setFailure({ message: vaultErrorCopy(err), field: null }),
  });

  const deleteKey = useMutation({
    mutationFn: (id: string) => removeRecoveryKey(id),
    onSuccess: () => {
      // deleting a key revokes the session; the fresh one rides the cookie
      setPendingDelete(null);
      void queryClient.invalidateQueries({ queryKey: ["vault", "recovery-keys"] });
    },
    onError: (err) => setFailure({ message: vaultErrorCopy(err), field: null }),
  });

  const recoveryReset = useMutation({
    // broker mode refuses the HTTP reset route: route it over the pipe
    mutationFn: () => resetVaultPassphrase(resetRecoveryKey, resetNewPassphrase, status.data?.broker === true),
    onSuccess: () => {
      setMessage(t("vaultChanged"));
      setFailure(null);
      setShowRecoveryReset(false);
      setResetRecoveryKey("");
      setResetNewPassphrase("");
    },
    onError: (err) => setFailure({ message: vaultErrorCopy(err), field: null }),
  });

  // the legacy plaintext build has no vault section at all
  if (status.data?.mode !== "vault") return null;

  /** Refuse a field in Arabic, focus it, and tie the alert to it (#109). */
  const showError = (message: string, field: VaultSettingsField): void => {
    setFailure({ message, field });
    const target =
      field === "current"
        ? currentRef.current
        : field === "newPassphrase"
          ? newRef.current
          : field === "confirm"
            ? confirmRef.current
            : field === "recoveryKey"
              ? recoveryKeyRef.current
              : field === "resetPassphrase"
                ? resetPassphraseRef.current
                : null;
    target?.focus();
  };

  /** Drop a field-blamed failure as soon as that field is edited (#100 pattern). */
  const clearFieldError = (field: Exclude<VaultSettingsField, null>): void => {
    setFailure((current) => (current !== null && current.field === field ? null : current));
  };

  const mismatch = newPassphrase.length > 0 && confirmPassphrase.length > 0 && confirmPassphrase !== newPassphrase;

  return (
    <section className="mt-8" data-testid="vault-settings">
      <h2 className="text-lg font-semibold">{t("vaultSettingsTitle")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("vaultSettingsHint")}</p>

      <form
        className="mt-4 grid gap-3 rounded border bg-card p-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (currentPassphrase === "") {
            showError(t("vaultPassphraseRequired"), "current");
            return;
          }
          if (!isVaultPassphraseLongEnough(newPassphrase)) {
            showError(t("vaultPassphraseTooShort"), "newPassphrase");
            return;
          }
          // compare directly, not via `mismatch`: with `noValidate` the native
          // `required` is gone, so an empty confirm must be refused here too
          if (confirmPassphrase !== newPassphrase) {
            showError(t("vaultPassphraseMismatch"), "confirm");
            return;
          }
          setMessage(null);
          // re-submitting drops the old field blame; the message travels in the
          // same value, so keep it visible until this attempt resolves
          setFailure((current) => (current === null ? null : { message: current.message, field: null }));
          changePassphrase.mutate();
        }}
      >
        <h3 className="font-medium">{t("vaultChangePassphrase")}</h3>
        <label className="grid gap-1 text-sm">
          {t("vaultCurrentPassphrase")}
          <PasswordInput
            ref={currentRef}
            autoComplete="current-password"
            value={currentPassphrase}
            onChange={(event) => {
              setCurrentPassphrase(event.target.value);
              clearFieldError("current");
            }}
            aria-invalid={errorField === "current"}
            aria-describedby={errorField === "current" ? "vault-settings-error" : undefined}
            required
            data-testid="vault-current-passphrase"
          />
        </label>
        <label className="grid gap-1 text-sm">
          {t("vaultNewPassphrase")}
          <PasswordInput
            ref={newRef}
            autoComplete="new-password"
            value={newPassphrase}
            onChange={(event) => {
              setNewPassphrase(event.target.value);
              // a mismatch blames confirm; making new match it is a fix too
              clearFieldError("newPassphrase");
              clearFieldError("confirm");
            }}
            aria-invalid={errorField === "newPassphrase" || (newPassphrase.length > 0 && !isVaultPassphraseLongEnough(newPassphrase))}
            aria-describedby={errorField === "newPassphrase" ? "vault-settings-error" : undefined}
            required
            data-testid="vault-new-passphrase"
          />
        </label>
        <label className="grid gap-1 text-sm">
          {t("vaultPassphraseConfirm")}
          <PasswordInput
            ref={confirmRef}
            autoComplete="new-password"
            value={confirmPassphrase}
            onChange={(event) => {
              setConfirmPassphrase(event.target.value);
              clearFieldError("confirm");
            }}
            aria-invalid={mismatch || errorField === "confirm"}
            aria-describedby={errorField === "confirm" ? "vault-settings-error" : undefined}
            required
            data-testid="vault-confirm-passphrase"
          />
        </label>
        <p className="text-xs text-muted-foreground">{t("vaultPassphraseRule")}</p>
        <button
          type="submit"
          className="rounded-lg bg-primary py-2 text-primary-foreground disabled:opacity-50"
          disabled={changePassphrase.isPending}
          data-testid="vault-change-submit"
        >
          {changePassphrase.isPending ? t("settingsSaving") : t("vaultChangePassphrase")}
        </button>
        <button
          type="button"
          className="text-start text-sm text-muted-foreground underline"
          onClick={() => setShowRecoveryReset((open) => !open)}
          data-testid="vault-show-recovery-reset"
        >
          {t("vaultForgotPassphrase")}
        </button>
      </form>

      {showRecoveryReset && (
        <form
          className="mt-4 grid gap-3 rounded border bg-card p-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (resetRecoveryKey === "") {
              showError(t("vaultRecoveryRequired"), "recoveryKey");
              return;
            }
            if (!isVaultPassphraseLongEnough(resetNewPassphrase)) {
              showError(t("vaultPassphraseTooShort"), "resetPassphrase");
              return;
            }
            setMessage(null);
            setFailure((current) => (current === null ? null : { message: current.message, field: null }));
            recoveryReset.mutate();
          }}
          data-testid="vault-recovery-reset"
        >
          <h3 className="font-medium">{t("vaultResetTitle")}</h3>
          <p className="text-sm text-muted-foreground">{t("vaultResetHint")}</p>
          <label className="grid gap-1 text-sm">
            {t("vaultRecoveryField")}
            <input
              ref={recoveryKeyRef}
              className="rounded border px-3 py-2 font-mono"
              dir="ltr"
              autoComplete="off"
              value={resetRecoveryKey}
              onChange={(event) => {
                setResetRecoveryKey(event.target.value);
                clearFieldError("recoveryKey");
              }}
              aria-invalid={errorField === "recoveryKey"}
              aria-describedby={errorField === "recoveryKey" ? "vault-settings-error" : undefined}
              required
              data-testid="vault-reset-recovery-key"
            />
          </label>
          <label className="grid gap-1 text-sm">
            {t("vaultNewPassphrase")}
            <PasswordInput
              ref={resetPassphraseRef}
              autoComplete="new-password"
              value={resetNewPassphrase}
              onChange={(event) => {
                setResetNewPassphrase(event.target.value);
                clearFieldError("resetPassphrase");
              }}
              aria-invalid={errorField === "resetPassphrase"}
              aria-describedby={errorField === "resetPassphrase" ? "vault-settings-error" : undefined}
              required
              data-testid="vault-reset-new-passphrase"
            />
          </label>
          <button
            type="submit"
            className="rounded-lg bg-primary py-2 text-primary-foreground disabled:opacity-50"
            disabled={recoveryReset.isPending}
            data-testid="vault-reset-submit"
          >
            {recoveryReset.isPending ? t("settingsSaving") : t("vaultResetSave")}
          </button>
        </form>
      )}

      <div className="mt-4 rounded border bg-card p-4">
        <h3 className="font-medium">{t("vaultRecoveryKeysTitle")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t("vaultRecoveryKeysHint")}</p>
        {(keys.data?.length ?? 0) <= 1 && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="vault-last-key-hint">
            {t("vaultLastKeyHint")}
          </p>
        )}
        {keys.data !== undefined && (
          <ul className="mt-3 grid gap-2">
            {keys.data.map((key) => (
              <li key={key.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">{key.label ?? key.id.slice(0, 8)}</span>
                {pendingDelete === key.id ? (
                  <span className="flex items-center gap-2">
                    <button
                      type="button"
                      className="text-destructive underline"
                      onClick={() => deleteKey.mutate(key.id)}
                      disabled={deleteKey.isPending}
                      data-testid={`vault-delete-confirm-${key.id}`}
                    >
                      {t("vaultRemoveKeyConfirm")}
                    </button>
                    <button type="button" className="underline" onClick={() => setPendingDelete(null)}>
                      {t("partyCancel")}
                    </button>
                  </span>
                ) : keys.data.length <= 1 ? (
                  <span className="text-xs text-muted-foreground">{t("vaultLastKeyHint")}</span>
                ) : (
                  <button
                    type="button"
                    className="text-destructive underline"
                    onClick={() => setPendingDelete(key.id)}
                    data-testid={`vault-delete-${key.id}`}
                  >
                    {t("vaultRemoveKey")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="mt-3 rounded-lg border px-4 py-2 disabled:opacity-50"
          disabled={createKey.isPending || (keys.data?.length ?? 0) >= 5}
          onClick={() => createKey.mutate()}
          data-testid="vault-add-recovery"
        >
          {createKey.isPending ? t("settingsSaving") : t("vaultAddRecoveryKey")}
        </button>
        {newKey !== null && (
          <div className="mt-3 rounded border border-border bg-muted p-3">
            <p className="text-sm font-semibold">{t("vaultKeyShownOnce")}</p>
            <p className="mt-2 text-center font-mono text-sm break-all select-all" dir="ltr" data-testid="vault-new-key">
              {newKey}
            </p>
            <button type="button" className="mt-2 text-sm underline" onClick={() => setNewKey(null)}>
              {t("vaultContinue")}
            </button>
          </div>
        )}
      </div>

      {message !== null && (
        <p className="mt-3 text-sm font-semibold text-success" role="status" data-testid="vault-settings-saved">
          {message}
        </p>
      )}
      {error !== null && (
        <p id="vault-settings-error" className="mt-3 text-sm text-destructive" role="alert" data-testid="vault-settings-error">
          {error}
        </p>
      )}
    </section>
  );
}
