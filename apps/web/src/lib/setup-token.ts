/** sessionStorage key for the shell-injected one-time setup token. */
export const SETUP_TOKEN_STORAGE_KEY = "dokan.setupToken";

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
export function readSetupToken(): string | undefined {
  const fromHash = parseSetupToken(window.location.hash);
  if (fromHash !== undefined) {
    sessionStorage.setItem(SETUP_TOKEN_STORAGE_KEY, fromHash);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    return fromHash;
  }
  const stored = sessionStorage.getItem(SETUP_TOKEN_STORAGE_KEY);
  return stored === null || stored === "" ? undefined : stored;
}
