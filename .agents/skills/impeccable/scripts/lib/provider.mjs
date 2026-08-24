// Source scripts default to slash commands. The provider build replaces only
// this exact declaration, avoiding heuristic rewrites across executable code.
// Default prefix is '/' for direct CLI usage. Harness-specific code
// (e.g. pin.mjs for codex/agents) overrides this to '$' for $impeccable syntax.
export const IMPECCABLE_COMMAND_PREFIX = "/";
export const IMPECCABLE_COMMAND = `${IMPECCABLE_COMMAND_PREFIX}impeccable`;
