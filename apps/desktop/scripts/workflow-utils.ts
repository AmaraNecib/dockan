/**
 * Shared parser for the repo's GitHub Actions workflows (issues 128 and 154).
 *
 * The repo has no generic workflow linter, so the workflow tests parse a
 * workflow into jobs and steps and assert against the owning step. Matching the
 * raw file would let a stray comment or an unrelated step satisfy a positive
 * assertion (PR #152 finding 2), so comments are stripped before any matching,
 * block scalars are dedented and newline-trimmed so a formatting edit cannot
 * fail the tests (PR #152 finding 3), and line endings are normalised for a
 * CRLF checkout.
 */

export type WorkflowStep = {
  readonly name: string;
  readonly run: string;
  readonly uses: string;
  readonly condition: string;
  readonly with: ReadonlyMap<string, string>;
  readonly env: ReadonlyMap<string, string>;
};

type MutableStep = {
  name: string;
  run: string;
  uses: string;
  condition: string;
  with: Map<string, string>;
  env: Map<string, string>;
};

type NestedField = "with" | "env";

type BlockScalar = {
  readonly target: "run" | NestedField;
  readonly key: string;
  readonly indent: number;
};

/**
 * Drop YAML comments before any assertion. A `#` only starts a comment at the
 * start of a line or after whitespace, so a `#` inside a scalar survives.
 * Line endings are normalised first: a CRLF checkout (core.autocrlf on
 * Windows) must not change how the file is parsed.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/u, "$1"))
    .join("\n");
}

/**
 * Normalise a parsed scalar so YAML formatting choices compare equal: an
 * inline `run: cmd`, a `run: |` block with one line, and a `run: |` block with
 * several indented lines all reduce to the same de-indented, newline-trimmed
 * text. Without this a harmless formatting edit (a human, or Prettier) would
 * fail the tests even though the command did not change.
 */
export function normaliseScalar(value: string): string {
  const lines = value.replace(/\r\n?/gu, "\n").split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => line.length - line.trimStart().length);
  const commonIndent = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(commonIndent)).join("\n").trimEnd();
}

/** Normalise every value of a parsed `with:`/`env:` map. */
export function normaliseMap(source: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of source) result.set(key, normaliseScalar(value));
  return result;
}

/**
 * Parse the `jobs.<jobName>.steps` list into named steps with their `run`,
 * `uses`, `if` and `with` values. Only the fields a step actually declares are
 * captured, so a comment can never look like a declared step field, and every
 * captured value is normalised so block-scalar formatting does not matter.
 */
export function parseSteps(source: string, jobName: string): readonly WorkflowStep[] {
  const lines = stripComments(source).split("\n");
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
  if (jobsIndex === -1) return [];
  const jobPattern = new RegExp(`^  ${jobName}:\\s*$`, "u");
  const jobIndex = lines.findIndex((line, index) => index > jobsIndex && jobPattern.test(line));
  if (jobIndex === -1) return [];
  const stepsIndex = lines.findIndex(
    (line, index) => index > jobIndex && /^    steps:\s*$/u.test(line),
  );
  if (stepsIndex === -1) return [];
  // the steps list must belong to this job, not a later one
  for (let index = jobIndex + 1; index < stepsIndex; index += 1) {
    if (/^  \S+:\s*$/u.test(lines[index])) return [];
  }

  const steps: WorkflowStep[] = [];
  let current: MutableStep | null = null;
  let block: BlockScalar | null = null;
  let nested: NestedField | null = null;

  const flush = () => {
    if (current === null) return;
    const step = current;
    steps.push({
      name: step.name,
      run: normaliseScalar(step.run),
      uses: step.uses,
      condition: step.condition,
      with: normaliseMap(step.with),
      env: normaliseMap(step.env),
    });
  };

  for (let index = stepsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;

    // past the end of the job body
    if (indent <= 4) break;

    const stepStart = /^      - (.*)$/u.exec(line);
    if (stepStart !== null) {
      flush();
      current = { name: "", run: "", uses: "", condition: "", with: new Map(), env: new Map() };
      block = null;
      nested = null;
      const field = /^([\w-]+):\s*(.*)$/u.exec(stepStart[1]);
      if (field !== null && field[1] === "name") current.name = field[2].trim();
      if (field !== null && field[1] === "uses") current.uses = field[2].trim();
      continue;
    }

    if (current === null) continue;

    // continuation of a block scalar (`run: |`, a `with:` or an `env:` value)
    if (block !== null && indent > block.indent) {
      const text = `${line.slice(block.indent)}\n`;
      if (block.target === "run") current.run += text;
      else {
        const map = block.target === "with" ? current.with : current.env;
        map.set(block.key, (map.get(block.key) ?? "") + text);
      }
      continue;
    }
    block = null;

    if (indent === 8) {
      const field = /^        ([\w-]+):\s*(.*)$/u.exec(line);
      if (field === null) continue;
      const key = field[1];
      const value = field[2].trim();
      if (key === "name") current.name = value;
      else if (key === "uses") current.uses = value;
      else if (key === "if") current.condition = value;
      else if (key === "run") {
        if (value.startsWith("|") || value.startsWith(">")) {
          block = { target: "run", key: "run", indent };
          current.run = "";
        } else current.run = value;
      } else if (key === "with") nested = "with";
      else if (key === "env") nested = "env";
      else nested = null;
      continue;
    }

    if (nested !== null && indent === 10) {
      const field = /^          ([\w-]+):\s*(.*)$/u.exec(line);
      if (field === null) continue;
      const key = field[1];
      const value = field[2].trim();
      const map = nested === "with" ? current.with : current.env;
      if (value.startsWith("|") || value.startsWith(">")) {
        block = { target: nested, key, indent };
        map.set(key, "");
      } else {
        map.set(key, value);
      }
    }
  }

  flush();
  return steps;
}

/** The body lines of one `jobs.<jobName>` block, comment-stripped. */
export function jobLines(source: string, jobName: string): readonly string[] {
  const lines = stripComments(source).split("\n");
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
  if (jobsIndex === -1) return [];
  const jobPattern = new RegExp(`^  ${jobName}:\\s*$`, "u");
  const jobIndex = lines.findIndex((line, index) => index > jobsIndex && jobPattern.test(line));
  if (jobIndex === -1) return [];
  const collected: string[] = [];
  for (let index = jobIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") {
      collected.push(line);
      continue;
    }
    if (line.length - line.trimStart().length <= 2) break;
    collected.push(line);
  }
  return collected;
}

/** The `on:` block lines, comment-stripped. */
export function onLines(source: string): readonly string[] {
  const lines = stripComments(source).split("\n");
  const onIndex = lines.findIndex((line) => /^on:\s*$/u.test(line));
  if (onIndex === -1) return [];
  const collected: string[] = [];
  for (let index = onIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") {
      collected.push(line);
      continue;
    }
    if (line.length - line.trimStart().length === 0) break;
    collected.push(line);
  }
  return collected;
}

/** The `options:` list of the workflow_dispatch input. */
export function dispatchOptions(source: string): readonly string[] {
  const lines = onLines(source);
  const optionsIndex = lines.findIndex((line) => /^        options:\s*$/u.test(line));
  if (optionsIndex === -1) return [];
  const options: string[] = [];
  for (let index = optionsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    if (line.length - line.trimStart().length <= 8) break;
    const item = /^\s*- (.*)$/u.exec(line);
    if (item !== null) options.push(item[1].trim());
  }
  return options;
}

/** A scalar under the workflow_dispatch input (e.g. `default`, `type`). */
export function dispatchScalar(source: string, key: string): string {
  const pattern = new RegExp(`^        ${key}:\\s*(\\S+)\\s*$`, "u");
  for (const line of onLines(source)) {
    const match = pattern.exec(line);
    if (match !== null) return match[1];
  }
  return "";
}

/** A named step, or a loud failure when the job no longer declares it. */
export function stepNamed(steps: readonly WorkflowStep[], name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new Error(`workflow has no step named "${name}"`);
  }
  return step;
}

/** Every `uses:` action reference, split into name and pinned revision. */
export function actionRefs(source: string): { name: string; revision: string }[] {
  const refs: { name: string; revision: string }[] = [];
  for (const line of stripComments(source).split("\n")) {
    const match = /^\s*uses:\s*(\S+)\s*$/u.exec(line);
    if (match === null) continue;
    const at = match[1].lastIndexOf("@");
    refs.push({ name: match[1].slice(0, at), revision: match[1].slice(at + 1) });
  }
  return refs;
}

/** The values of every `key:` line (cache keys), for scope checks. */
export function cacheKeys(source: string): string[] {
  const keys: string[] = [];
  for (const line of stripComments(source).split("\n")) {
    const match = /^\s*key:\s*(\S.*)$/u.exec(line);
    if (match !== null) keys.push(match[1].trim());
  }
  return keys;
}
