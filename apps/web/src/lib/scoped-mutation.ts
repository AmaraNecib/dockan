import { useMutation as useTanstackMutation, type DefaultError, type QueryClient, type UseMutationOptions } from "@tanstack/react-query";
import { useRpc } from "./rpc-context";

/** Mutation execution and completion belong to their originating credential. */
export function useMutation<TData = unknown, TError = DefaultError, TVariables = void, TOnMutateResult = unknown>(
  options: UseMutationOptions<TData, TError, TVariables, TOnMutateResult>,
  client?: QueryClient,
) {
  const { lease } = useRpc();
  const { mutationFn, onMutate, onSuccess, onError, onSettled } = options;
  const scopedOptions: typeof options = {
    ...options,
    onMutate: onMutate === undefined ? undefined : (...args) => { lease?.assertLive(); return onMutate(...args); },
    onSuccess: onSuccess === undefined ? undefined : (...args) => { if (!lease || lease.isLive()) return onSuccess(...args); },
    onError: onError === undefined ? undefined : (...args) => { if (!lease || lease.isLive()) return onError(...args); },
    onSettled: onSettled === undefined ? undefined : (...args) => { if (!lease || lease.isLive()) return onSettled(...args); },
  };
  if (mutationFn !== undefined) {
    scopedOptions.mutationFn = function (this: typeof options, ...args) {
      lease?.assertLive();
      return mutationFn.apply(this, args);
    };
  }
  return useTanstackMutation(scopedOptions, client);
}
