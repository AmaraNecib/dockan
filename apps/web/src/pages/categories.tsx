import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMutation } from "../lib/scoped-mutation";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

import { cn } from "@/lib/utils";
import { inputClass } from "@/components/ui/input";
import { useRpc } from "../lib/rpc-context";
import { arabicIncludes, type Category } from "@dokan/contracts";
import { tError } from "../lib/i18n";

export function CategoriesPage() {
  const { orpc } = useRpc();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const categories = useQuery(orpc.categoriesList.queryOptions());
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryingCategories, setRetryingCategories] = useState(false);
  const visibleCategories = useMemo(
    () => categories.data?.items.filter((category) => search.trim() === "" || arabicIncludes(category.name, search.trim())) ?? [],
    [categories.data?.items, search],
  );
  /** the empty state's action focuses the add field instead of faking a step */
  const nameRef = useRef<HTMLInputElement>(null);

  const retryCategories = () => {
    setRetryingCategories(true);
    void categories.refetch().finally(() => setRetryingCategories(false));
  };

  const refreshCategoryLabels = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.categoriesList.queryKey() });
    void queryClient.invalidateQueries({ queryKey: [["itemsList"]] });
    void queryClient.invalidateQueries({ queryKey: orpc.itemsAll.queryKey() });
  };

  const create = useMutation(
    orpc.categoriesCreate.mutationOptions({
      onSuccess: (createdCategory) => {
        setName("");
        queryClient.setQueryData(orpc.categoriesList.queryKey(), (current: { items: Category[] } | undefined) => ({
          items: [...(current?.items ?? []), createdCategory].sort((a, b) => a.name.localeCompare(b.name)),
        }));
        refreshCategoryLabels();
      },
      onError: (err) => setError(tError(err.message)),
    }),
  );

  const rename = useMutation(
    orpc.categoriesRename.mutationOptions({
      onSuccess: (updatedCategory) => {
        setEditingId(null);
        setEditName("");
        setError(null);
        setNotice(t("categoriesRenamed"));
        queryClient.setQueryData(orpc.categoriesList.queryKey(), (current: { items: Category[] } | undefined) => ({
          items: (current?.items ?? []).map((category) => category.id === updatedCategory.id ? updatedCategory : category).sort((a, b) => a.name.localeCompare(b.name)),
        }));
        refreshCategoryLabels();
      },
      onError: (err) => setError(tError(err.message)),
    }),
  );

  const remove = useMutation(
    orpc.categoriesDelete.mutationOptions({
      onSuccess: (result, input) => {
        setDeleteId(null);
        if (result.deleted) {
          setError(null);
          setNotice(t("categoriesDeleted"));
          queryClient.setQueryData(orpc.categoriesList.queryKey(), (current: { items: Category[] } | undefined) => ({
            items: (current?.items ?? []).filter((category) => category.id !== input.id),
          }));
          refreshCategoryLabels();
        } else {
          setError(t("categoriesUsed", { count: result.itemCount }));
        }
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
          setNotice(null);
          void create.mutate({ name });
        }}
      >
        <input
          ref={nameRef}
          className={cn(inputClass, "flex-1")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("categoriesNewName")}
          aria-label={t("categoriesNewName")}
          required
          disabled={create.isPending}
        />
        <button className="rounded-lg bg-primary px-4 py-2 text-primary-foreground" type="submit" disabled={create.isPending}>
          {t("categoriesAdd")}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
      {notice && <p className="mt-2 text-sm text-success" role="status">{notice}</p>}

      {!categories.data && (categories.isError || retryingCategories) ? (
        <div className="mt-4 grid gap-2 rounded border border-destructive/20 bg-destructive/10 p-3" data-testid="categories-error">
          <p className="text-sm text-destructive" role="alert">{t("categoriesLoadError")}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={categories.isFetching}
            onClick={retryCategories}
            data-testid="categories-retry"
          >
            {t("itemsSearchRetry")}
          </Button>
        </div>
      ) : categories.isPending || !categories.data ? (
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
        <>
          <label className="mt-4 block">
            <span className="sr-only">{t("categoriesSearch")}</span>
            <input
              type="search"
              className={cn(inputClass, "w-full")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("categoriesSearch")}
              aria-label={t("categoriesSearch")}
              data-testid="categories-search"
            />
          </label>
          {visibleCategories.length === 0 ? (
            <p className="mt-4 rounded border bg-card p-3 text-sm text-muted-foreground" role="status">
              {search.trim() ? t("categoriesNoMatches") : t("categoriesEmpty")}
            </p>
          ) : (
            <ul className="mt-4 divide-y rounded border bg-card">
              {visibleCategories.map((category) => (
                <li key={category.id} className="flex flex-wrap items-center gap-2 p-3">
                  {editingId === category.id ? (
                    <form
                      className="flex min-w-0 flex-1 gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        setError(null);
                        void rename.mutate({ id: category.id, name: editName });
                      }}
                    >
                      <input
                        autoFocus
                        className={cn(inputClass, "min-w-0 flex-1")}
                        value={editName}
                        onChange={(event) => setEditName(event.target.value)}
                        disabled={rename.isPending}
                        aria-label={t("categoriesRenameLabel", { name: category.name })}
                        required
                      />
                      <Button type="submit" size="sm" disabled={rename.isPending}>
                        {rename.isPending ? t("categoriesSaving") : t("categoriesSave")}
                      </Button>
                      <Button type="button" size="sm" variant="outline" disabled={rename.isPending} onClick={() => { setEditingId(null); setEditName(""); setError(null); }}>
                        {t("categoriesCancel")}
                      </Button>
                    </form>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1">{category.name}</span>
                      {deleteId === category.id ? (
                        <div className="flex items-center gap-2">
                          <span className="text-sm">{t("categoriesConfirmDelete", { name: category.name })}</span>
                          <Button type="button" size="sm" variant="destructive" disabled={remove.isPending} onClick={() => { setError(null); void remove.mutate({ id: category.id }); }}>
                            {remove.isPending ? t("categoriesDeleting") : t("categoriesConfirm")}
                          </Button>
                          <Button type="button" size="sm" variant="outline" disabled={remove.isPending} onClick={() => setDeleteId(null)}>
                            {t("categoriesCancel")}
                          </Button>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <Button type="button" size="sm" variant="outline" disabled={rename.isPending || remove.isPending} onClick={() => { setError(null); setNotice(null); setEditName(category.name); setEditingId(category.id); }}>
                            {t("categoriesRename")}
                          </Button>
                          <Button type="button" size="sm" variant="destructive" disabled={rename.isPending || remove.isPending} onClick={() => { setError(null); setNotice(null); setDeleteId(category.id); }}>
                            {t("categoriesDelete")}
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}