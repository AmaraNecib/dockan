import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { UnsupportedSchemaVersionError } from "../schema-version";
import { replaceVaultOffline } from "./restore";
import { createVaultBackupBundle } from "./backup";
import { preflightVaultBackup } from "./restore-preflight";

const credential = z.union([z.object({ passphrase: z.string() }).strict(), z.object({ recoveryKey: z.string() }).strict()]);
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("current"), credential }).strict(),
  z.object({ action: z.literal("preview"), path: z.string().min(1), credential }).strict(),
  z.object({ action: z.literal("install"), path: z.string().min(1), credential, currentCredential: credential,
    confirmed: z.literal(true), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);

/** One-shot native helper. Secrets travel only over stdin, never argv/env. */
export async function runRestoreWorker(dataDir: string): Promise<number> {
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of Bun.stdin.stream()) {
      size += chunk.length;
      if (size > 65536) throw new Error("restore request too large");
      chunks.push(chunk);
    }
    const request = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (request.action === "current") {
      // Read-only preflight before native quiescence. The offline installer
      // repeats this against the final drained image before creating safety.
      await preflightVaultBackup(createVaultBackupBundle(
        fs.readFileSync(path.join(dataDir, "vault", "vault.json"), "utf8"),
        fs.readFileSync(path.join(dataDir, "dokan.db.enc")),
      ), request.credential);
      process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
      return 0;
    }
    const fd = fs.openSync(request.path, "r");
    let bundle: Buffer;
    let modifiedAt: string;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error("backup must be a regular file");
      modifiedAt = stat.mtime.toISOString();
      bundle = fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
    const sha256 = createHash("sha256").update(bundle).digest("hex");
    if (request.action === "preview") {
      const preview = await preflightVaultBackup(bundle, request.credential);
      process.stdout.write(`${JSON.stringify({ ok: true, preview: { ...preview, fileModifiedAt: modifiedAt, sha256 } })}\n`);
    } else {
      // Confirm exactly the bytes that were previewed, not a path that may now
      // contain another backup. Refuse before acquiring or mutating live state.
      if (sha256 !== request.expectedSha256) throw new Error("backup changed since preview");
      const result = await replaceVaultOffline({ dataDir, bundle, credential: request.credential, currentCredential: request.currentCredential });
      process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    }
    return 0;
  } catch (error) {
    const code = error instanceof UnsupportedSchemaVersionError ? "VAULT_BACKUP_NEWER_SCHEMA" : "VAULT_RESTORE_FAILED";
    // Never serialize a thrown KDF/parser error: it may contain input material.
    process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`);
    return 1;
  }
}
