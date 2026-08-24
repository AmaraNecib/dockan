import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Skeleton } from "@/components/ui/skeleton";

import { orpc } from "../lib/rpc";
import { tError } from "../lib/i18n";

export function CategoriesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const categories = useQuery(orpc.categoriesList.queryOptions());
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation(
    orpc.categoriesCreate.mutationOptions({
      onSuccess: () => {
        setName("");
        void queryClient.invalidateQueries({ queryKey: orpc.categoriesList.queryKey() });
      },
      onError: (err) => setError(tError(err.message)),
    }),
  );

  return (
    <section>
      <h1 className="text-xl font-bold">{t("categoriesTitle")}</h1>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          void create.mutate({ name });
        }}
      >
        <input
          className="flex-1 rounded border px-3 py-2"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("categoriesNewName")}
          required
        />
        <button className="rounded-lg bg-stone-900 px-4 py-2 text-white" type="submit">
          {t("categoriesAdd")}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {categories.isPending || !categories.data ? (
        <div className="mt-4 grid gap-3 rounded border bg-white p-3">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-6 w-full" />
          ))}
        </div>
      ) : (
        <ul className="mt-4 divide-y rounded border bg-white">
          {categories.data.items.map((category) => (
            <li key={category.id} className="p-3">
              {category.name}
            </li>
          ))}
          {categories.data.items.length === 0 && <li className="p-3 text-stone-500">{t("categoriesEmpty")}</li>}
        </ul>
      )}
    </section>
  );
}