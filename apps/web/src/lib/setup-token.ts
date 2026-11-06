/** sessionStorage key for the shell-injected one-time setup token. */
export const SETUP_TOKEN_STORAGE_KEY = "dokan.setupToken";

// The native restore reset can consume the URL fragment before setup runs.
// Keep the setup credential in this document if sessionStorage is unavailable.
let setupTokenFallback: string | undefined;

/**
 * Parse the shell's one-time setup token out of a URL fragment. The packaged
 * shell navigates the webview to `/#setup_token=<token>`; a fragment is never
 * sent to the server, so the token stays out of request logs and the port
 * record.
 */
export function parseSetupToken(hash: string): string | undefined {
  const match = /(?:^#|&)setup_token=([^&]*)/.exec(hash);
  if (match === null) return undefined;
  try {
    const token = decodeURIComponent(match[1] ?? "");
    return token === "" ? undefined : token;
  } catch {
    // a malformed percent-encoding is not a token
    return undefined;
  }
}

/**
 * The setup token for this webview session: read once from the fragment, kept
 * in sessionStorage so a reload before provisioning still has it, and stripped
 * from the visible URL. Returns undefined outside the packaged shell (dev/e2e
 * have no boot token).
 */
export function preserveSetupTokenFromHash(): void {
  const token = parseSetupToken(window.location.hash);
  if (token === undefined) return;
  try {
    sessionStorage.setItem(SETUP_TOKEN_STORAGE_KEY, token);
  } catch {
    // The in-memory copy lets the existing setup caller use this document's token.
    setupTokenFallback = token;
  }
}

export function readSetupToken(): string | undefined {
  const fromHash = parseSetupToken(window.location.hash);
  if (fromHash !== undefined) {
    try {
      sessionStorage.setItem(SETUP_TOKEN_STORAGE_KEY, fromHash);
    } catch {
      // Keep the token available to the current document when storage is denied.
      setupTokenFallback = fromHash;
    }
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    return fromHash;
  }
  try {
    const stored = sessionStorage.getItem(SETUP_TOKEN_STORAGE_KEY);
    if (stored !== null && stored !== "") return stored;
  } catch {
    // Fall back to the value captured before the restore reset stripped the URL.
  }
  return setupTokenFallback;
}
