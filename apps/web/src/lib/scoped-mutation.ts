import { useMutation as useTanstackMutation, useQueryClient, type DefaultError, type QueryClient, type UseMutationOptions } from "@tanstack/react-query";
import { useRpc } from "./rpc-context";

/** Mutation execution and completion belong to their originating credential. */
export function useMutation<TData = unknown, TError = DefaultError, TVariables = void, TOnMutateResult = unknown>(
  options: UseMutationOptions<TData, TError, TVariables, TOnMutateResult>,
  client?: QueryClient,
) {
  const { lease } = useRpc();
  const queryClient = useQueryClient(client);
  const { onMutate, onSuccess, onError, onSettled } = queryClient.defaultMutationOptions(options);
  const { mutationFn } = options;
  const scopedOptions: typeof options = { ...options };
  if (onMutate !== undefined) scopedOptions.onMutate = (...args) => { lease?.assertLive(); return onMutate(...args); };
  if (onSuccess !== undefined) scopedOptions.onSuccess = (...args) => { if (!lease || lease.isLive()) return onSuccess(...args); };
  if (onError !== undefined) scopedOptions.onError = (...args) => { if (!lease || lease.isLive()) return onError(...args); };
  if (onSettled !== undefined) scopedOptions.onSettled = (...args) => { if (!lease || lease.isLive()) return onSettled(...args); };
  if (mutationFn !== undefined) {
    scopedOptions.mutationFn = function (this: typeof options, ...args) {
      lease?.assertLive();
      return mutationFn.apply(this, args);
    };
  }
  return useTanstackMutation(scopedOptions, client);
}
