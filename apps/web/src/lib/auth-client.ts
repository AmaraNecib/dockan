import { useEffect, useState } from "react";

import { createAuthClient } from "better-auth/client";
import { usernameClient } from "better-auth/client/plugins";

/**
 * The one auth entry point. The vite dev server proxies /api to the Bun api
 * (127.0.0.1:4317), so the session cookie stays same-origin.
 */
export const authClient = createAuthClient({
  plugins: [usernameClient()],
  fetchOptions: {
    credentials: "include",
  },
});

export type SessionData = Awaited<ReturnType<typeof authClient.getSession>>["data"];

/**
 * React hook over authClient.getSession. This better-auth version exposes
 * useSession as a signal atom; the component reloads after sign-in/out, so a
 * mount-time fetch is enough and keeps the dependency surface honest.
 */
export function useSession() {
  const [data, setData] = useState<SessionData | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    authClient
      .getSession()
      .then((result) => {
        if (alive) setData(result.data);
      })
      .catch(() => {
        if (alive) setData(null);
      });
    return () => {
      alive = false;
    };
  }, []);
  return { data: data ?? null, isPending: data === undefined };
}

/**
 * The login name is the Algerian phone normalized to the api's form: no +,
 * international prefix (213 + 9 digits). Mirrors normalizeAlgerianPhone.
 */
export const toLoginName = (raw: string): string => {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("213")) return digits;
  if (digits.startsWith("0")) return `213${digits.slice(1)}`;
  return digits;
};