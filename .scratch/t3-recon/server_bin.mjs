#!/usr/bin/env node

import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
//#region src/entrypoint.ts
/**
* Whether the module identified by `moduleUrl` is the process entrypoint.
*
* `import.meta.main` answers this directly, but it only exists on Node 22.18+
* and 24.2+. This package's `engines.node` range also accepts 22.16, 22.17 and
* 23.11, where it is `undefined`: an `if (import.meta.main)` guard never runs,
* so the process loads every module and exits 0 without output. Fall back to
* comparing the entrypoint path on those versions.
*/
const isEntrypoint = (input) => {
	if (input.runtimeMain !== void 0) return input.runtimeMain;
	if (input.entryPath === void 0 || input.entryPath === "") return false;
	if (input.moduleUrl === NodeURL.pathToFileURL(input.entryPath).href) return true;
	try {
		return input.moduleUrl === NodeURL.pathToFileURL(NodeFS.realpathSync(input.entryPath)).href;
	} catch {
		return false;
	}
};
//#endregion
//#region src/bin.ts
/**
* Thin CLI entry.
*
* Every ACP agent spawns `t3 acp-mcp-bridge` while opening its session, and
* terminal-fallback agents run `t3 acp-mcp-call` per tool call, so their
* startup sits on first-message latency. Both dispatch here before the full
* CLI module graph (seconds of evaluation) loads; everything else defers to
* the real CLI in ./binCli.ts.
*/
if (isEntrypoint({
	moduleUrl: import.meta.url,
	entryPath: process.argv[1],
	runtimeMain: import.meta.main
})) {
	const command = process.argv[2];
	if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
		const { runAcpMcpCliFastPath } = await import("./AcpMcpStdioBridge-BDT-UGsc.mjs");
		await runAcpMcpCliFastPath(command, process.argv.slice(3));
	} else {
		const { runCli } = await import("./binCli-CUds19Wg.mjs");
		runCli();
	}
}
//#endregion
export {};

//# sourceMappingURL=bin.mjs.map