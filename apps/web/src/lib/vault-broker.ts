import { z } from "zod";

/**
 * The desktop shell's stdin broker (issue #141). When the window runs inside
 * the Tauri shell the pre-boot passphrase travels over Tauri IPC to the
 * sidecar's stdin pipe; the API refuses the HTTP credential routes in that
 * mode, so the one secret that decrypts everything never crosses the network
 * stack. A plain browser (dev/e2e) has no Tauri bridge and stays on HTTP.
 */

/**
 * The raw reply as it crosses the IPC bridge: a structurally named shape that
 * `brokerReplySchema` validates before any caller sees it.
 */
type RawBrokerReply = {
  ok?: boolean;
  code?: string;
  retryAfterMs?: number;
  sessionToken?: string;
  sessionGeneration?: number;
  recoveryKey?: string;
  plaintextRemaining?: string[];
  warning?: string;
  status?: unknown;
};

type TauriInvoke = (command: string, args?: BrokerInvokeArgs) => Promise<RawBrokerReply>;

/** The Tauri v2 IPC bridge; present only inside the desktop webview. */
export function tauriInvoke(): TauriInvoke | undefined {
  // SAFETY: Tauri injects __TAURI_INTERNALS__ into its own webview; a browser
  // simply has no property here and keeps the HTTP transport
  const internals = (window as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  const invoke = internals?.invoke;
  return invoke instanceof Function ? invoke.bind(internals) : undefined;
}

/** True when the desktop shell can carry the gate over its IPC bridge. */
export function brokerAvailable(): boolean {
  return tauriInvoke() !== undefined;
}

export const brokerCommands = {
  status: "vault_status",
  unlock: "vault_unlock",
  setup: "vault_setup",
  recovery: "vault_unlock_recovery",
  reset: "vault_reset_passphrase",
  setupSaved: "vault_setup_saved",
  setupWarning: "vault_setup_warning",
  logout: "vault_logout",
} as const;

/** One decoded broker reply; the API's stable `code` carries the failure. */
const brokerReplySchema = z.object({
  ok: z.boolean(),
  code: z.string().nullish(),
  retryAfterMs: z.number().nullish(),
  sessionToken: z.string().nullish(),
  sessionGeneration: z.number().nullish(),
  recoveryKey: z.string().nullish(),
  plaintextRemaining: z.array(z.string()).nullish(),
  warning: z.string().nullish(),
  status: z.unknown().optional(),
});

export type BrokerReply = z.infer<typeof brokerReplySchema>;

/** The payloads the gate sends over the broker; each command names its own. */
export type BrokerInvokeArgs =
  | { passphrase: string }
  | { recoveryKey: string }
  | { recoveryKey: string; newPassphrase: string };

/**
 * Invoke one broker command and decode its reply. A rejection (the shell has
 * no sidecar yet, a pipe failure) is surfaced as a normal thrown error; the
 * caller maps it to the generic refusal.
 */
export async function invokeBroker(command: string, args?: BrokerInvokeArgs): Promise<BrokerReply> {
  const invoke = tauriInvoke();
  if (invoke === undefined) throw new Error("the desktop broker is not available");
  const decoded = brokerReplySchema.safeParse(await invoke(command, args));
  if (!decoded.success) throw new Error("the desktop broker returned an unexpected reply");
  return decoded.data;
}

/** Fire a broker command whose reply is not an envelope (acks, restart). */
export async function invokeBrokerVoid(command: string): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke === undefined) throw new Error("the desktop broker is not available");
  await invoke(command);
}
