import zlib from "node:zlib";

/**
 * Printed-PDF verification helpers (issue #121). Chrome draws text as glyph
 * IDs under an embedded subset font, so a raw byte scan cannot see a browser
 * URL/date header; these helpers decode each font's ToUnicode CMap and turn
 * the content streams' `<hex> Tj` runs back into text.
 */

export function pdfPageCount(pdf: Buffer): number {
  // `/Type /Page` only: the trailing \b keeps `/Type /Pages` out
  return (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length;
}

export function pdfMediaBoxes(pdf: Buffer): Array<{ width: number; height: number }> {
  const boxes: Array<{ width: number; height: number }> = [];
  for (const match of pdf.toString("latin1").matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)) {
    const parts = (match[1] ?? "").trim().split(/\s+/).map(Number);
    const [x1, y1, x2, y2] = parts;
    if (x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
      boxes.push({ width: x2 - x1, height: y2 - y1 });
    }
  }
  return boxes;
}

/** Inflate every stream through its object dictionary's direct `/Length`.
 * Scanning `endstream` is not enough: compressed bytes can contain that word,
 * which misaligns every following stream. Skipping objects whose header has no
 * direct length (or that end with `endobj` before the stream) avoids non-stream
 * objects whose bodies merely mention `stream`. */
function inflatedStreams(pdf: Buffer): string[] {
  const streams: string[] = [];
  const latin = pdf.toString("latin1");
  const objectMarker = /(\d+)\s+0\s+obj\b/g;
  let object = objectMarker.exec(latin);
  while (object !== null) {
    const headerStart = object.index + object[0].length;
    const window = latin.slice(headerStart, headerStart + 2000);
    const streamMarker = /\bstream\r?\n/.exec(window);
    if (streamMarker !== null) {
      const header = window.slice(0, streamMarker.index);
      const lengthMatch = /\/Length\s+(\d+)\b/.exec(header);
      const indirectLength = /\/Length\s+\d+\s+0\s+R/.test(header);
      if (lengthMatch !== null && !indirectLength && !header.includes("endobj")) {
        const start = headerStart + streamMarker.index + streamMarker[0].length;
        const length = Number(lengthMatch[1]);
        const chunk = pdf.subarray(start, start + length);
        try {
          streams.push(zlib.inflateSync(chunk).toString("latin1"));
        } catch {
          streams.push(chunk.toString("latin1"));
        }
      }
    }
    object = objectMarker.exec(latin);
  }
  return streams;
}

/** A CMap value is UTF-16BE (one or more code units). */
function utf16FromHex(hex: string): string {
  let text = "";
  for (let index = 0; index + 4 <= hex.length; index += 4) {
    text += String.fromCharCode(parseInt(hex.slice(index, index + 4), 16));
  }
  return text;
}

/** Every `beginbfchar`/`beginbfrange` map in the document, one per font. */
function parseToUnicodeMaps(streams: readonly string[]): Array<Map<number, string>> {
  const maps: Array<Map<number, string>> = [];
  for (const stream of streams) {
    if (!stream.includes("beginbfchar") && !stream.includes("beginbfrange")) continue;
    const map = new Map<number, string>();
    for (const block of stream.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of (block[1] ?? "").matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        map.set(parseInt(pair[1] ?? "0", 16), utf16FromHex(pair[2] ?? ""));
      }
    }
    for (const block of stream.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const range of (block[1] ?? "").matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g)) {
        const low = parseInt(range[1] ?? "0", 16);
        const high = parseInt(range[2] ?? "0", 16);
        if (range[3] !== undefined) {
          const baseHex = range[3];
          const base = parseInt(baseHex, 16);
          for (let code = low; code <= high; code += 1) {
            map.set(code, utf16FromHex((base + code - low).toString(16).padStart(baseHex.length, "0")));
          }
        } else if (range[4] !== undefined) {
          let offset = 0;
          for (const item of range[4].matchAll(/<([0-9A-Fa-f]+)>/g)) {
            map.set(low + offset, utf16FromHex(item[1] ?? ""));
            offset += 1;
          }
        }
      }
    }
    if (map.size > 0) maps.push(map);
  }
  return maps;
}

/** The document's drawn text, decoded through every embedded font's ToUnicode map. */
export function extractPdfText(pdf: Buffer): string {
  const streams = inflatedStreams(pdf);
  const maps = parseToUnicodeMaps(streams);
  const runs: string[] = [];
  for (const stream of streams) {
    if (!stream.includes("Tj") && !stream.includes("TJ")) continue;
    for (const map of maps) {
      let decoded = "";
      for (const token of stream.matchAll(/<([0-9A-Fa-f]+)>/g)) {
        const hex = token[1] ?? "";
        for (let index = 0; index + 4 <= hex.length; index += 4) {
          const char = map.get(parseInt(hex.slice(index, index + 4), 16));
          if (char !== undefined) decoded += char;
        }
      }
      if (decoded.length > 0) runs.push(decoded);
    }
  }
  return runs.join("\n");
}

export function pdfContains(pdf: Buffer, needle: string): boolean {
  return extractPdfText(pdf).includes(needle);
}
