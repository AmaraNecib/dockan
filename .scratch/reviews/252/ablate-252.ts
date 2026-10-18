/**
 * Ablation driver for the #252 rebase. Applies ONE wrong conflict resolution to
 * the rebased tree, so the guard can be watched failing. `restore` puts the file
 * back. Never commit with an ablation applied.
 *
 *   bun /tmp/ablate-252.ts a|b|c|restore
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const DISPLAY = "apps/web/src/lib/supplier-entry-display.ts";
const I18N = "apps/web/src/lib/i18n.ts";
const WE = "يسالنا";
const THEY = "نسالوه";

const backup = (p: string): void => copyFileSync(p, `${p}.ablate-backup`);
const restoreFile = (p: string): void => copyFileSync(`${p}.ablate-backup`, p);

const mode = process.argv[2];

if (mode === "restore") {
  for (const p of [DISPLAY, I18N]) {
    try {
      restoreFile(p);
      console.log(`restored ${p}`);
    } catch {
      console.log(`${p} had no backup (already clean)`);
    }
  }
  process.exit(0);
}

if (mode === "a") {
  // Wrong resolution A — take develop's file verbatim: the pairing lives in TWO
  // places again (the drift class #252 exists to kill).
  backup(DISPLAY);
  const text = readFileSync(DISPLAY, "utf8");
  const from = 'return supplierDirectionKey(token === "THEY_OWE" ? "THEY_OWE" : "WE_OWE");';
  const to = 'return token === "THEY_OWE" ? "supplierAdjustDirectionTheyOwe" : "supplierAdjustDirectionWeOwe";';
  if (!text.includes(from)) throw new Error("ablation A anchor not found");
  writeFileSync(DISPLAY, text.replace(from, to));
  console.log("ablation A applied: adjustDirectionKey holds its own ternary again");
} else if (mode === "b") {
  // Wrong resolution B — the explicit "reversed" tree the brief forbids: each
  // label back on the other value.
  backup(I18N);
  const text = readFileSync(I18N, "utf8");
  const weLine = `supplierAdjustDirectionWeOwe: "${WE}",`;
  const theyLine = `supplierAdjustDirectionTheyOwe: "${THEY}",`;
  if (!text.includes(weLine) || !text.includes(theyLine)) throw new Error("ablation B anchor not found");
  writeFileSync(I18N, text.replace(weLine, `supplierAdjustDirectionWeOwe: "${THEY}",`).replace(theyLine, `supplierAdjustDirectionTheyOwe: "${WE}",`));
  console.log("ablation B applied: the two labels are back on the other value");
} else if (mode === "c") {
  // Wrong resolution C — "take our side": drop develop's addition entirely.
  backup(DISPLAY);
  const text = readFileSync(DISPLAY, "utf8");
  const start = text.indexOf("/** The direction word for a raw stored");
  const end = text.indexOf("/** The direction word for an ADJUSTMENT");
  if (start === -1 || end === -1 || end < start) throw new Error("ablation C anchors not found");
  writeFileSync(DISPLAY, text.slice(0, start) + text.slice(end));
  console.log("ablation C applied: develop's adjustmentDirectionKey (#253) is gone");
} else {
  throw new Error(`unknown mode ${mode ?? "(none)"} — use a|b|c|restore`);
}
