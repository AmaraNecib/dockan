import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// React 19 act() requires the environment flag to be set explicitly.
// SAFETY: only this flag is written; globalThis keeps every other property.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Shared page-test harness (issue #96 review). The new empty-state specs use
 * it; the older page specs keep their private mount helpers until they are
 * touched, so this is the one definition new specs start from.
 */

export function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

export interface MountedPage {
  container: HTMLDivElement;
  root: Root;
  queryClient: QueryClient;
  /** `[data-testid="..."]` lookup scoped to the mounted container. */
  query: <T extends Element = HTMLElement>(testId: string) => T | null;
  text: () => string;
  /** act-wrapped poll that throws with the condition label on timeout. */
  poll: (check: () => boolean, label: string, attempts?: number) => Promise<void>;
  unmount: () => Promise<void>;
}

const mountedPages: MountedPage[] = [];

export async function mountWithProviders(node: ReactNode): Promise<MountedPage> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = testQueryClient();
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });

  const query = <T extends Element = HTMLElement>(testId: string) =>
    container.querySelector<T>(`[data-testid="${testId}"]`);

  const mounted: MountedPage = {
    container,
    root,
    queryClient,
    query,
    text: () => container.textContent ?? "",
    poll: async (check, label, attempts = 100) => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (check()) return;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      }
      throw new Error(`timed out waiting for ${label}`);
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
  mountedPages.push(mounted);
  return mounted;
}

/** Tears down every harness mount; call from each page spec's afterEach. */
export async function unmountAllMountedPages(): Promise<void> {
  const pages = [...mountedPages];
  mountedPages.length = 0;
  for (const page of pages) await page.unmount();
}
