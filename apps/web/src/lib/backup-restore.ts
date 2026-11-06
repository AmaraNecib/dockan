import { z } from "zod";
import { readVaultSessionToken } from "./vault-client";

export type RestoreInvokeArgs = { sessionToken: string; selectionId?: string; credential?: RestoreCredential; confirmation?: { selectionId: string; expectedSha256: string; credential: RestoreCredential; currentCredential: RestoreCredential; confirmed: true } };
export type NativeRestoreReply = Partial<RestoreSelection & RestorePreview & RestoreOutcome> | null | void;
type Invoke = (command: string, args?: RestoreInvokeArgs) => Promise<NativeRestoreReply>;
function nativeInvoke(): Invoke | undefined {
  // SAFETY: Tauri owns this injected bridge. Native commands independently
  // enforce the exact window, launch, origin and authenticated session.
  const internals = (window as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  return internals?.invoke instanceof Function ? internals.invoke.bind(internals) : undefined;
}
export function backupRestoreAvailable(): boolean { return nativeInvoke() !== undefined; }
export type RestoreCredential = { passphrase: string } | { recoveryKey: string };
const selectionSchema = z.object({ id: z.string().min(1), name: z.string().min(1) });
const previewSchema = z.object({
  vaultId: z.string(), vaultCreatedAt: z.string(), fileModifiedAt: z.string().datetime({ offset: true }),
  schemaVersion: z.number().int().nonnegative(), supportedSchemaVersion: z.number().int().nonnegative(),
  compatible: z.literal(true), sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const outcomeSchema = z.object({ status: z.enum(["restored", "rolled-back", "refused"]), safetyDirectory: z.string(), safetyPath: z.string().nullish(), selectedUnchanged: z.literal(true) });
export type RestoreSelection = z.infer<typeof selectionSchema>;
export type RestorePreview = z.infer<typeof previewSchema>;
export type RestoreOutcome = z.infer<typeof outcomeSchema>;
export type RestoreErrorKey = "restoreNewer" | "restoreChanged" | "restoreCurrentInvalid" | "restoreDrainUnconfirmed" | "restoreDesktopOnly" | "restoreRefused" | "restoreSecretRequired";
export class BackupRestoreError extends Error {
  constructor(readonly key: RestoreErrorKey) { super(key); }
}
const refusalCopy = new Map<string, RestoreErrorKey>([
  ["VAULT_BACKUP_NEWER_SCHEMA", "restoreNewer"],
  ["VAULT_BACKUP_CHANGED", "restoreChanged"],
  ["VAULT_RESTORE_CURRENT_CREDENTIAL", "restoreCurrentInvalid"],
  ["VAULT_RESTORE_DRAIN_UNCONFIRMED", "restoreDrainUnconfirmed"],
  ["VAULT_RESTORE_UNSUPPORTED", "restoreDesktopOnly"],
]);
async function call<T>(schema: z.ZodType<T>, command: string, args?: RestoreInvokeArgs): Promise<T> {
  const invoke = nativeInvoke();
  if (!invoke) throw new BackupRestoreError("restoreDesktopOnly");
  try { return schema.parse(await invoke(command, args)); }
  catch (error) {
    const refusal = z.string().safeParse(error);
    throw new BackupRestoreError(refusal.success ? refusalCopy.get(refusal.data) ?? "restoreRefused" : "restoreRefused");
  }
}
function session() { return readVaultSessionToken() ?? ""; }
export async function chooseRestoreBackup(): Promise<RestoreSelection | null> {
  return call(selectionSchema.nullable(), "backup_restore_choose", { sessionToken: session() });
}
export async function previewRestoreBackup(selectionId: string, credential: RestoreCredential): Promise<RestorePreview> {
  return call(previewSchema, "backup_restore_preview", { sessionToken: session(), selectionId, credential });
}
export async function cancelRestoreBackup(selectionId: string): Promise<void> {
  await call(z.void().nullable(), "backup_restore_cancel", { sessionToken: session(), selectionId });
}
export async function confirmRestoreBackup(selectionId: string, expectedSha256: string, credential: RestoreCredential, currentCredential: RestoreCredential): Promise<void> {
  await call(z.void().nullable(), "backup_restore_confirmed", { sessionToken: session(), confirmation: { selectionId, expectedSha256, credential, currentCredential, confirmed: true } });
}
export async function readRestoreOutcome(): Promise<RestoreOutcome | null> {
  if (!backupRestoreAvailable()) return null;
  return call(outcomeSchema.nullable(), "backup_restore_outcome");
}
