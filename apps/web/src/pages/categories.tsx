import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

import { cn } from "@/lib/utils";
import { inputClass } from "@/components/ui/input";
import { orpc } from "../lib/rpc";
import { tError } from "../lib/i18n";

export function CategoriesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const categories = useQuery(orpc.categoriesList.queryOptions());
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** the empty state's action focuses the add field instead of faking a step */
  const nameRef = useRef<HTMLInputElement>(null);

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
          ref={nameRef}
          className={cn(inputClass, "flex-1")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("categoriesNewName")}
          required
        />
        <button className="rounded-lg bg-primary px-4 py-2 text-primary-foreground" type="submit">
          {t("categoriesAdd")}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

      {categories.isPending || !categories.data ? (
        <div className="mt-4 grid gap-3 rounded border bg-card p-3">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-6 w-full" />
          ))}
        </div>
      ) : categories.data.items.length === 0 ? (
        <EmptyState
          testId="categories-empty"
          card
          className="mt-4"
          title={t("categoriesEmpty")}
          hint={t("categoriesEmptyHint")}
          action={
            <Button size="lg" variant="outline" onClick={() => nameRef.current?.focus()} data-testid="categories-empty-action">
              {t("categoriesEmptyAction")}
            </Button>
          }
        />
      ) : (
        <ul className="mt-4 divide-y rounded border bg-card">
          {categories.data.items.map((category) => (
            <li key={category.id} className="p-3">
              {category.name}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}