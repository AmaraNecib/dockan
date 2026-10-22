/**
 * One flag parser for the verification-tier scripts.
 *
 * `scripts/e2e-changed.ts` grew `--base=ref` support and `scripts/test-affected.ts`
 * did not, so `bun scripts/test-affected.ts --base=origin/develop --dry-run`
 * exited 2 while the same spelling on tier 2 worked. Two hand-rolled loops is how
 * that happens. This is one loop with one contract:
 *
 *   - a flag is a switch or it takes a value;
 *   - a value may be attached (`--base=ref`) or separated (`--base ref`);
 *   - a switch refuses an attached value instead of ignoring it;
 *   - a value may not be the next flag (`--base --dry-run`), which is the shape
 *     that used to take the flag as the ref and silently drop the dry run;
 *   - a single-use flag given twice is refused, because which one wins is not
 *     something a caller should have to guess;
 *   - anything unrecognised is a usage failure with exit code 2, never a guess.
 *
 * What a value MEANS stays in the script: this module splits `--files=a,b` into
 * the single value `a,b` and leaves the comma to the caller that knows it holds a
 * path list.
 */

export type FlagSpec =
  | { name: string; kind: "switch" }
  /** `repeat: true` collects every value; the default refuses a second one. */
  | { name: string; kind: "value"; repeat?: boolean };

export type ParseResult =
  | { ok: true; switches: ReadonlySet<string>; values: ReadonlyMap<string, string[]> }
  | { ok: false; message: string };

export function parseFlags(argv: string[], specs: FlagSpec[]): ParseResult {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const switches = new Set<string>();
  const values = new Map<string, string[]>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);

    const spec = byName.get(name);
    if (spec === undefined) {
      return {
        ok: false,
        message: name.startsWith("-") ? `unknown flag: ${name}` : `unexpected argument: ${arg}`,
      };
    }

    if (spec.kind === "switch") {
      if (inline !== null) return { ok: false, message: `${name} takes no value` };
      switches.add(name);
      continue;
    }

    let value: string | null = inline;
    if (value === null) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        return { ok: false, message: `${name} needs a value` };
      }
      i += 1;
      value = next;
    }
    const trimmed = value.trim();
    if (trimmed === "") return { ok: false, message: `${name} needs a non-empty value` };

    const seen = values.get(name) ?? [];
    if (seen.length > 0 && spec.repeat !== true) {
      return { ok: false, message: `${name} may only be given once` };
    }
    values.set(name, [...seen, trimmed]);
  }

  return { ok: true, switches, values };
}

/**
 * The usage-failure contract both scripts share: the message and the usage on
 * stderr, and exit code 2.
 *
 * A function rather than a copy of two `console.error` calls in each `main`, so
 * the two front doors cannot disagree about the code a lane reads.
 */
export function usageFailure(message: string, usage: string): 2 {
  console.error(message);
  console.error(usage);
  return 2;
}
