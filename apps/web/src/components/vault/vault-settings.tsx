import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { MIN_VAULT_PASSPHRASE_LENGTH } from "@dokan/contracts";

import {
  addRecoveryKey,
  changeVaultPassphrase,
  fetchVaultStatus,
  listRecoveryKeys,
  removeRecoveryKey,
  VaultRequestError,
} from "@/lib/vault-client";

/**
 * The settings-side vault controls (ADR-0008 §4.3): change the passphrase and
 * rotate the recovery keys while the vault is open. A new key is shown exactly
 * once; deleting one never touches the others.
 */
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
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const changePassphrase = useMutation({
    mutationFn: () => changeVaultPassphrase(currentPassphrase, newPassphrase),
    onSuccess: () => {
      setMessage(t("vaultChanged"));
      setError(null);
      setCurrentPassphrase("");
      setNewPassphrase("");
      setConfirmPassphrase("");
    },
    onError: (err) => setError(err instanceof Error ? err.message : t("vaultUnexpected")),
  });

  const createKey = useMutation({
    mutationFn: addRecoveryKey,
    onSuccess: (created) => {
      setNewKey(created.code);
      void queryClient.invalidateQueries({ queryKey: ["vault", "recovery-keys"] });
    },
    onError: (err) => setError(err instanceof VaultRequestError ? err.message : t("vaultUnexpected")),
  });

  const deleteKey = useMutation({
    mutationFn: (id: string) => removeRecoveryKey(id),
    onSuccess: () => {
      setPendingDelete(null);
      void queryClient.invalidateQueries({ queryKey: ["vault", "recovery-keys"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : t("vaultUnexpected")),
  });

  // the legacy plaintext build has no vault section at all
  if (status.data?.mode !== "vault") return null;

  const mismatch = confirmPassphrase.length > 0 && confirmPassphrase !== newPassphrase;

  return (
    <section className="mt-8" data-testid="vault-settings">
      <h2 className="text-lg font-semibold">{t("vaultSettingsTitle")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("vaultSettingsHint")}</p>

      <form
        className="mt-4 grid gap-3 rounded border bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (newPassphrase.length < MIN_VAULT_PASSPHRASE_LENGTH) {
            setError(t("vaultPassphraseTooShort"));
            return;
          }
          if (mismatch) {
            setError(t("vaultPassphraseMismatch"));
            return;
          }
          setMessage(null);
          changePassphrase.mutate();
        }}
      >
        <h3 className="font-medium">{t("vaultChangePassphrase")}</h3>
        <label className="grid gap-1 text-sm">
          {t("vaultCurrentPassphrase")}
          <input
            type="password"
            className="rounded border px-3 py-2"
            autoComplete="current-password"
            value={currentPassphrase}
            onChange={(event) => setCurrentPassphrase(event.target.value)}
            required
            data-testid="vault-current-passphrase"
          />
        </label>
        <label className="grid gap-1 text-sm">
          {t("vaultNewPassphrase")}
          <input
            type="password"
            className="rounded border px-3 py-2"
            autoComplete="new-password"
            value={newPassphrase}
            onChange={(event) => setNewPassphrase(event.target.value)}
            aria-invalid={newPassphrase.length > 0 && newPassphrase.length < MIN_VAULT_PASSPHRASE_LENGTH}
            required
            data-testid="vault-new-passphrase"
          />
        </label>
        <label className="grid gap-1 text-sm">
          {t("vaultPassphraseConfirm")}
          <input
            type="password"
            className="rounded border px-3 py-2"
            autoComplete="new-password"
            value={confirmPassphrase}
            onChange={(event) => setConfirmPassphrase(event.target.value)}
            aria-invalid={mismatch}
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
      </form>

      <div className="mt-4 rounded border bg-card p-4">
        <h3 className="font-medium">{t("vaultRecoveryKeysTitle")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t("vaultRecoveryKeysHint")}</p>
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
        <p className="mt-3 text-sm text-destructive" role="alert" data-testid="vault-settings-error">
          {error}
        </p>
      )}
    </section>
  );
}
