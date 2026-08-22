import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/rpc";
import { strings } from "../lib/strings";

export function CategoriesPage() {
  const queryClient = useQueryClient();
  const categories = useQuery(orpc.categoriesList.queryOptions());
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation(orpc.categoriesCreate.mutationOptions());

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await create.mutateAsync({ name });
      setName("");
      await queryClient.invalidateQueries({ queryKey: orpc.categoriesList.queryKey() });
    } catch (err) {
      setError(err instanceof Error && /exists/i.test(err.message) ? strings.categories.duplicate : String(err));
    }
  }

  return (
    <section>
      <h1 className="text-xl font-bold">{strings.categories.title}</h1>

      <form className="mt-4 flex gap-2" onSubmit={submit}>
        <input
          className="flex-1 rounded border px-3 py-2"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={strings.categories.newName}
          required
        />
        <button className="rounded bg-stone-900 px-4 py-2 text-white disabled:opacity-50" disabled={create.isPending}>
          {strings.categories.add}
        </button>
      </form>
      {error && <p className="mt-2 text-red-600">{error}</p>}

      <ul className="mt-4 divide-y rounded border bg-white">
        {categories.data?.items.map((category) => (
          <li key={category.id} className="p-3">
            {category.name}
          </li>
        ))}
        {categories.data?.items.length === 0 && <li className="p-3 text-stone-500">{strings.categories.empty}</li>}
      </ul>
    </section>
  );
}