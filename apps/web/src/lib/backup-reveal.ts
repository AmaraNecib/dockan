type RevealInvoke = (command: string, args: { path: string }) => Promise<void>;

function revealInvoke(): RevealInvoke | undefined {
  // SAFETY: Tauri injects this bridge only into its desktop webview.
  const internals = (window as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  const invoke = internals?.invoke;
  return invoke instanceof Function ? invoke.bind(internals) : undefined;
}

export function backupRevealAvailable(): boolean {
  return revealInvoke() !== undefined;
}

export class BackupRevealError extends Error {
  constructor(readonly key: "backupsRevealMissing" | "backupsRevealFailed" | "backupsRevealDesktopOnly") {
    super(key);
  }
}

/** Reveal the successful RPC outcome, never a reconstructed filename. */
export async function revealBackup(path: string): Promise<void> {
  const invoke = revealInvoke();
  if (!invoke) throw new BackupRevealError("backupsRevealDesktopOnly");
  try {
    await invoke("backup_reveal", { path });
  } catch (error) {
    if (error === "BACKUP_REVEAL_MISSING") throw new BackupRevealError("backupsRevealMissing");
    if (error === "BACKUP_REVEAL_UNSUPPORTED") throw new BackupRevealError("backupsRevealDesktopOnly");
    throw new BackupRevealError("backupsRevealFailed");
  }
}
