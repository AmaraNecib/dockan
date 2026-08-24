import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Skeleton } from "@/components/ui/skeleton";

import { orpc } from "../lib/rpc";
import { tError } from "../lib/i18n";

/**
 * Ticket 10 — settings (/settings): the owner edits the store identity
 * (name + phone) that the invoice header prints. Values are DB-backed, so
 * they survive restarts by construction. The phone is normalized to the
 * canonical Algerian +213 form at the api boundary; the form shows the
 * stored value as-is.
 */
export function SettingsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useQuery(orpc.settingsGet.queryOptions());

  const [storeName, setStoreName] = useState("");
  const [storePhone, setStorePhone] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // hydrate the form once the stored identity arrives; guards keep the
  // owner's in-progress edits from being clobbered by a refetch
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (!settings.data || hydrated) return;
    setStoreName(settings.data.storeName);
    setStorePhone(settings.data.storePhone ?? "");
    setHydrated(true);
  }, [settings.data, hydrated]);

  const save = useMutation(
    orpc.settingsUpdate.mutationOptions({
      onSuccess: () => {
        setMessage(t("settingsSaved"));
        setError(null);
        // keep the invoice header's cached copy in sync with what we saved
        void queryClient.invalidateQueries({ queryKey: orpc.settingsGet.queryKey() });
      },
      onError: (err) => setError(tError(err.message)),
    }),
  );

  const pending = settings.isPending || !settings.data;

  return (
    <section>
      <h1 className="text-xl font-bold">{t("settingsTitle")}</h1>
      <p className="mt-1 text-sm text-stone-600">{t("settingsHint")}</p>

      {pending ? (
        <div className="mt-4 grid gap-3 rounded border bg-white p-4">
          {[0, 1].map((row) => (
            <Skeleton key={row} className="h-8 w-full" />
          ))}
        </div>
      ) : (
        <form
          className="mt-4 grid gap-4 rounded border bg-white p-4"
          onSubmit={(event) => {
            event.preventDefault();
            setMessage(null);
            const phone = storePhone.trim();
            void save.mutate({ storeName: storeName.trim(), storePhone: phone === "" ? null : phone });
          }}
        >
          <label className="grid gap-1">
            {t("settingsStoreName")}
            <input
              className="rounded border px-3 py-2"
              value={storeName}
              onChange={(e) => setStoreName(e.target.value)}
              required
              data-testid="settings-name"
            />
          </label>
          <label className="grid gap-1">
            {t("settingsStorePhone")}
            <input
              className="rounded border px-3 py-2"
              value={storePhone}
              onChange={(e) => setStorePhone(e.target.value)}
              placeholder={t("settingsPhoneHint")}
              inputMode="tel"
              dir="ltr"
              data-testid="settings-phone"
            />
          </label>

          {message && (
            <p className="text-sm font-semibold text-green-700" role="status" data-testid="settings-saved">
              {message}
            </p>
          )}
          {error && (
            <p className="text-sm text-red-600" role="alert" data-testid="settings-error">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="rounded-lg bg-stone-900 py-2 text-white disabled:opacity-50"
            disabled={save.isPending}
            data-testid="settings-save"
          >
            {save.isPending ? t("settingsSaving") : t("settingsSave")}
          </button>
        </form>
      )}
    </section>
  );
}