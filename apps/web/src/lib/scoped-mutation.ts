import { useMutation as useTanstackMutation, type DefaultError, type QueryClient, type UseMutationOptions } from "@tanstack/react-query";
import { useRpc } from "./rpc-context";

/** Completion callbacks belong to their originating credential, like the RPC client. */
export function useMutation<TData = unknown, TError = DefaultError, TVariables = void, TOnMutateResult = unknown>(
  options: UseMutationOptions<TData, TError, TVariables, TOnMutateResult>,
  client?: QueryClient,
) {
  const { lease } = useRpc();
  const { onMutate, onSuccess, onError, onSettled } = options;
  return useTanstackMutation({
    ...options,
    onMutate: onMutate === undefined ? undefined : (...args) => { lease?.assertLive(); return onMutate(...args); },
    onSuccess: onSuccess === undefined ? undefined : (...args) => { if (!lease || lease.isLive()) return onSuccess(...args); },
    onError: onError === undefined ? undefined : (...args) => { if (!lease || lease.isLive()) return onError(...args); },
    onSettled: onSettled === undefined ? undefined : (...args) => { if (!lease || lease.isLive()) return onSettled(...args); },
  }, client);
}
