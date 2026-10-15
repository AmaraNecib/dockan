/**
 * crew-host — run the whole crew in ONE Bun process, headless.
 *
 * Measured 2026-10-15, same trivial prompt:
 *   1 lane as a TUI pi process ....... 79.1s CPU, ~180 MB, 1 process
 *   1 lane in this host ..............  6.7s CPU,  171 MB, 1 process
 *   3 lanes in this host .............  7.9s CPU,  192 MB, 1 process
 *
 * ~12x less CPU per lane, and three lanes cost barely more than one: startup and
 * the runtime are paid once. The work is identical; the TUI re-rendering the
 * whole screen on every streamed token was the cost.
 *
 * This keeps everything a lane had — prompt, steer, interrupt, per-lane output —
 * and adds what separate processes could not give: the parent reads every lane's
 * state from one place, and a lane's session is file-backed so it survives a host
 * restart.
 *
 * Control: JSONL over TCP on 127.0.0.1:$CREW_HOST_PORT (default 8899), plus a
 * state snapshot at .scratch/sessions/crew/host-state.json for cheap reads.
 * Use `bun .scratch/scripts/crew.ts <command>` rather than speaking it by hand.
 *
 * Run: bun .scratch/scripts/crew-host.ts
 */
import { createServer } from "node:net";
import { createServer as createHttp } from "node:http";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

// The SDK lives in the global pi install, not in this repo's dependencies, so it
// is imported by path. Override with PI_AGENT_SDK when pi is installed elsewhere.
/** The repo root. The crew tooling runs from the main checkout, never a lane's
 *  worktree, so every shared path below hangs off this one value. */
const REPO = process.env.CREW_REPO ?? "D:/projects/mani-project";

const SDK =
  process.env.PI_AGENT_SDK ??
  "D:/Bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const { createAgentSession, SessionManager } = (await import(SDK)) as any;

const PORT = Number(process.env.CREW_HOST_PORT ?? 8899);
const UI_PORT = Number(process.env.CREW_UI_PORT ?? 8900);
const STATE = "${REPO}/.scratch/sessions/crew/host-state.json";
const UI_FILE = "${REPO}/scripts/crew/crew-ui.html";
const SLOT_ROOT = "${REPO}/.scratch/sessions/crew/e2e-slots";
const SLOT_HELD = `${SLOT_ROOT}/held`;
const SLOT_QUEUE = `${SLOT_ROOT}/queue`;
/** crew-watch writes this; it is the only list of the REAL herdr lanes. */
const HERDR_FLEET = "${REPO}/.scratch/sessions/crew/fleet.json";
/** The parent pi session — the human's own pane, the one to wake with a message. */
const PARENT_PANE = process.env.CREW_PARENT_PANE ?? "w48:p1";
/** Where pi keeps one directory per working directory, each holding JSONL sessions. */
const SESSIONS_ROOT = "C:/Users/sensei57/.pi/agent/sessions";
/** The parent's own workspace, so its transcript can be shown next to the lanes'. */
const PARENT_CWD = "${REPO}";

type Status = "starting" | "working" | "idle" | "aborted" | "dead";

interface Lane {
  label: string;
  cwd: string;
  session: any;
  unsubscribe?: () => void;
  status: Status;
  lastText: string;
  startedAt: number;
  turns: number;
  toolCalls: number;
  error?: string;
  sessionFile?: string;
}

const lanes = new Map<string, Lane>();
const clients = new Set<any>();
/** Server-sent-events clients: the human's browser. */
const sse = new Set<any>();

const log = (...parts: unknown[]) =>
  process.stderr.write(`[crew-host] ${parts.join(" ")}\n`);

const brief = (lane: Lane) => ({
  lane: lane.label,
  status: lane.status,
  cwd: lane.cwd,
  turns: lane.turns,
  toolCalls: lane.toolCalls,
  sessionFile: lane.sessionFile,
  lastText: lane.lastText.slice(-600),
  error: lane.error,
});

/** Broadcast to every attached client and refresh the cheap-read snapshot. */
function publish(event: Record<string, unknown>) {
  const line = `${JSON.stringify(event)}\n`;
  for (const client of clients) {
    try {
      client.write(line);
    } catch {
      clients.delete(client);
    }
  }
  for (const listener of sse) {
    try {
      listener.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      sse.delete(listener);
    }
  }
  try {
    mkdirSync(dirname(STATE), { recursive: true });
    writeFileSync(
      STATE,
      JSON.stringify(
        { pid: process.pid, port: PORT, at: new Date().toISOString(), lanes: [...lanes.values()].map(brief) },
        null,
        2,
      ),
    );
  } catch {
    /* the snapshot is a convenience, never a failure path */
  }
}

/** Track one lane's run state from its event stream. */
function attach(lane: Lane) {
  lane.unsubscribe = lane.session.subscribe((event: any) => {
    switch (event.type) {
      case "agent_start":
        lane.status = "working";
        publish({ ev: "working", lane: lane.label });
        break;
      case "message_update":
        if (event.assistantMessageEvent?.type === "text_delta") {
          const delta: string = event.assistantMessageEvent.delta;
          lane.lastText += delta;
          publish({ ev: "text", lane: lane.label, delta });
        }
        break;
      case "tool_execution_start":
        lane.toolCalls += 1;
        publish({ ev: "tool", lane: lane.label, name: event.toolName });
        break;
      case "agent_settled":
        // Pi will not continue on its own: this lane is genuinely done.
        lane.status = lane.status === "aborted" ? "aborted" : "idle";
        publish({ ev: "settled", lane: lane.label, status: lane.status });
        break;
      default:
        break;
    }
  });
}

/** Run a prompt without blocking the host, so other lanes keep working. */
function run(lane: Lane, prompt: string) {
  lane.turns += 1;
  lane.status = "working";
  // Separate turns in the accumulated text. Without this a lane's replies run
  // together ("ready.Hi. What would you like…") and the log becomes unreadable.
  const separator = `${lane.lastText ? "\n\n" : ""}─── turn ${lane.turns} ───\n`;
  lane.lastText += separator;
  publish({ ev: "text", lane: lane.label, delta: separator });
  void (async () => {
    try {
      await lane.session.prompt(prompt);
    } catch (error) {
      lane.error = error instanceof Error ? error.message : String(error);
      lane.status = "idle";
      publish({ ev: "error", lane: lane.label, message: lane.error });
    }
  })();
}

async function spawn(label: string, cwd: string, prompt: string) {
  if (lanes.has(label)) throw new Error(`lane "${label}" already exists`);
  // File-backed on purpose: a lane's transcript is the thing that lets us resume
  // it after the host restarts, and a lane's session file is what the coding
  // agent would have written anyway.
  const { session } = await createAgentSession({
    cwd,
    sessionManager: SessionManager.create(cwd),
  });
  const lane: Lane = {
    label,
    cwd,
    session,
    status: "starting",
    lastText: "",
    startedAt: Date.now(),
    turns: 0,
    toolCalls: 0,
    sessionFile: session.sessionFile,
  };
  lanes.set(label, lane);
  attach(lane);
  publish({ ev: "spawned", ...brief(lane) });
  if (prompt) run(lane, prompt);
  return lane;
}

/**
 * The real crew lanes: herdr pi processes, read from the fleet file crew-watch
 * maintains. Read, never shell out — the page polls this endpoint.
 */
function herdrLanes() {
  try {
    const fleet = JSON.parse(readFileSync(HERDR_FLEET, "utf8"));
    return (fleet.lanes ?? []).map((entry: any) => ({
      lane: entry.label,
      kind: "herdr",
      status: entry.status,
      cwd: entry.cwd,
      paneId: entry.paneId,
      turns: 0,
      toolCalls: 0,
      lastText: "",
    }));
  } catch {
    return [];
  }
}

/** Type into another pi session's pane. Not a poll, so spawning is fine. */
function herdrPrompt(paneId: string, text: string) {
  execFileSync("herdr", ["agent", "prompt", paneId, text], {
    encoding: "utf8",
    timeout: 60_000,
    // Without this, Windows flashes a console window on every message.
    windowsHide: true,
  });
}

/**
 * pi names a session directory after the working directory it belongs to, and it
 * replaces EVERY separator with a dash rather than collapsing runs:
 *   D:\projects\mani-worktrees\fix-1  ->  --D--projects-mani-worktrees-fix-1--
 * (colon and backslash each become one dash, hence the doubled dash after "D").
 */
const sessionDirFor = (cwd: string) =>
  `${SESSIONS_ROOT}/--${cwd.replace(/[:\\/]/g, "-").replace(/-+$/, "")}--`;

/**
 * The most recent session transcript for a working directory, as flat messages.
 *
 * Read straight from pi's own JSONL, so the page can show what an agent actually
 * said without any agent cooperating. Tool calls are summarised to one line; a
 * transcript that dumps tool output is unreadable.
 */
function transcriptFor(cwd: string, limit = 80) {
  try {
    const dir = sessionDirFor(cwd);
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
    const newest = files[files.length - 1];
    if (!newest) return [];
    const messages: Array<{ role: string; text: string; at?: string }> = [];
    for (const line of readFileSync(`${dir}/${newest}`, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.type !== "message") continue;
      const message = row.message ?? {};
      if (message.role === "system") continue;
      let text = "";
      let thinking = "";
      if (typeof message.content === "string") text = message.content;
      else if (Array.isArray(message.content)) {
        text = message.content
          .map((part: any) => {
            if (part.type === "text") return part.text;
            if (part.type === "toolCall") return `→ ${part.name ?? "tool"}`;
            if (part.type === "thinking") {
              thinking += (part.thinking ?? part.text ?? "") as string;
              return "";
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
      }
      const role = message.role === "toolResult" ? "tool" : message.role;
      // Thinking is carried separately so the page can toggle it: it is useful
      // context and also a lot of noise.
      if (thinking.trim()) {
        messages.push({ role: "thinking", text: thinking.length > 4000 ? `${thinking.slice(0, 4000)}…` : thinking, at: message.timestamp });
      }
      if (!text.trim()) continue;
      messages.push({
        role,
        text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text,
        at: message.timestamp,
      });
    }
    return messages.slice(-limit);
  } catch {
    return [];
  }
}

/** Everything the sidebar lists: parents first, then every lane of both kinds. */
function targets() {
  const parents = [
    {
      lane: "parent",
      kind: "parent",
      status: "working",
      cwd: PARENT_CWD,
      paneId: PARENT_PANE,
      turns: 0,
      toolCalls: 0,
      lastText: "",
    },
  ];
  return {
    parents,
    lanes: [
      ...herdrLanes().map((lane: any) => ({ ...lane, kind: "herdr" })),
      ...lanes.values().map(laneRow),
    ],
  };
}

/** Resolve any target label to the row the sidebar knows. */
function findTarget(label: string) {
  const { parents, lanes: rows } = targets();
  return [...parents, ...rows].find((row: any) => row.lane === label);
}

/** The shared shape for a lane row, so the page can render both kinds. */
const laneRow = (lane: Lane) => ({ ...brief(lane), kind: "sdk", paneId: undefined });

async function handle(cmd: any): Promise<unknown> {
  switch (cmd.cmd) {
    case "spawn":
      if (!String(cmd.lane ?? "").trim() || !String(cmd.cwd ?? "").trim()) {
        throw new Error("spawn needs a lane label and a worktree path");
      }
      return { ok: true, ...brief(await spawn(String(cmd.lane).trim(), String(cmd.cwd).trim(), String(cmd.prompt ?? ""))) };
    case "send": {
      const lane = lanes.get(String(cmd.lane));
      if (!lane) throw new Error(`unknown lane "${cmd.lane}"`);
      const text = String(cmd.text);
      if (lane.status === "working") {
        // `prompt()` rejects while streaming unless the caller says which it
        // means, so honour an explicit mode and default to steering.
        const result =
          cmd.mode === "followUp" ? await lane.session.followUp(text) : await lane.session.steer(text);
        return { ok: true, lane: lane.label, result };
      }
      // An IDLE lane needs a real prompt: `steer()` only enters after a turn
      // that is already running, so on an idle session the message queues and
      // nothing ever triggers a run.
      run(lane, text);
      return { ok: true, lane: lane.label, result: "prompted" };
    }
    case "abort": {
      const lane = lanes.get(String(cmd.lane));
      if (!lane) throw new Error(`unknown lane "${cmd.lane}"`);
      lane.status = "aborted";
      await lane.session.abort();
      publish({ ev: "aborted", lane: lane.label });
      return { ok: true, ...brief(lane) };
    }
    case "list":
      // Both kinds: SDK lanes this process owns, and the herdr pi lanes that run
      // in their own panes. The human needs one view, not two.
      return { ok: true, ...targets() };

    // The conversation so far, read from pi's own session file.
    case "transcript": {
      const found = findTarget(String(cmd.target ?? ""));
      if (!found) throw new Error(`unknown target "${cmd.target}"`);
      return { ok: true, target: found.lane, messages: transcriptFor(found.cwd) };
    }

    // Message the parent pi session (the human's own pane) from the page.
    case "parent": {
      const text = String(cmd.text ?? "").trim();
      if (!text) throw new Error("empty message");
      herdrPrompt(PARENT_PANE, text);
      return { ok: true, to: PARENT_PANE };
    }

    // Type into a herdr lane's pane, addressed by label.
    case "herdr-send": {
      const found = findTarget(String(cmd.lane ?? ""));
      if (!found) throw new Error(`no open lane "${cmd.lane}"`);
      const text = String(cmd.text ?? "").trim();
      if (!text) throw new Error("empty message");
      herdrPrompt(found.paneId, text);
      return { ok: true, lane: found.lane, paneId: found.paneId };
    }
    case "tail": {
      const lane = lanes.get(String(cmd.lane));
      if (!lane) throw new Error(`unknown lane "${cmd.lane}"`);
      return { ok: true, lane: lane.label, text: lane.lastText.slice(-Number(cmd.chars ?? 2000)) };
    }
    case "kill": {
      const lane = lanes.get(String(cmd.lane));
      if (!lane) throw new Error(`unknown lane "${cmd.lane}"`);
      lane.unsubscribe?.();
      lane.session.dispose();
      lanes.delete(lane.label);
      publish({ ev: "dead", lane: lane.label });
      return { ok: true, lane: lane.label };
    }
    case "quit": {
      for (const lane of lanes.values()) {
        lane.unsubscribe?.();
        try {
          lane.session.dispose();
        } catch {
          /* best-effort on shutdown */
        }
      }
      lanes.clear();
      publish({ ev: "shutdown" });
      setTimeout(() => process.exit(0), 100);
      return { ok: true };
    }
    case "ping":
      return { ok: true, pid: process.pid, port: PORT, lanes: lanes.size };
    default:
      throw new Error(`unknown command "${cmd.cmd}"`);
  }
}

const server = createServer((socket) => {
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
  socket.write(`${JSON.stringify({ ev: "ready", pid: process.pid, port: PORT, lanes: lanes.size })}\n`);
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line) continue;
      void (async () => {
        try {
          const result = await handle(JSON.parse(line));
          socket.write(`${JSON.stringify({ ev: "ack", ...(result as Record<string, unknown>) })}\n`);
        } catch (error) {
          socket.write(
            `${JSON.stringify({ ev: "error", message: error instanceof Error ? error.message : String(error) })}\n`,
          );
        }
      })();
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`control on 127.0.0.1:${PORT} (pid ${process.pid})`);
  publish({ ev: "ready", pid: process.pid, port: PORT });
});

// ---------------------------------------------------------------------------
// The human's surface. The TUI used to be this, one expensive renderer per
// lane; one page for every lane replaces all of them.
// ---------------------------------------------------------------------------
const json = (res: any, body: unknown, code = 200) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readBody = (req: any) =>
  new Promise<any>((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });

/** A small ring of control requests, newest last. */
const recent: Array<Record<string, unknown>> = [];
const record = (entry: Record<string, unknown>) => {
  recent.push({ at: new Date().toISOString().slice(11, 19), ...entry });
  if (recent.length > 50) recent.shift();
};

createHttp(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${UI_PORT}`);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    try {
      const page = readFileSync(UI_FILE);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`cannot read ${UI_FILE}: ${error}`);
    }
    return;
  }

  if (url.pathname === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    sse.add(res);
    // Bring a late-joining page up to date in one shot.
    res.write(`data: ${JSON.stringify({ ev: "snapshot", lanes: [...lanes.values()].map(brief) })}\n\n`);
    req.on("close", () => sse.delete(res));
    return;
  }

  if (url.pathname === "/api/list") return json(res, targets());

  if (url.pathname === "/api/transcript") {
    const found = findTarget(url.searchParams.get("target") ?? "");
    return found
      ? json(res, { target: found.lane, messages: transcriptFor(found.cwd) })
      : json(res, { error: "unknown target" }, 404);
  }

  // The last few control requests, so a rejected one can be diagnosed without
  // guessing which button the human pressed.
  if (url.pathname === "/api/log") return json(res, { entries: recent });

  // The e2e slot queue, so the page can show what is contending for the suite.
  //
  // Read the slot files DIRECTLY. This used to shell out to e2e-slot.sh, which
  // spawned a `bash` per request — and the page polls this endpoint, so Windows
  // flashed a console window every 10 seconds. Never spawn a process to answer
  // a poll.
  if (url.pathname === "/api/slots") {
    const held: string[] = [];
    const queued: string[] = [];
    try {
      for (const entry of readdirSync(SLOT_HELD, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          held.push(readFileSync(`${SLOT_HELD}/${entry.name}/lane`, "utf8").trim());
        } catch {
          /* a slot claimed between the listing and the read */
        }
      }
      for (const entry of readdirSync(SLOT_QUEUE, { withFileTypes: true })) {
        if (!entry.name.endsWith(".req")) continue;
        try {
          queued.push(readFileSync(`${SLOT_QUEUE}/${entry.name}`, "utf8").trim().split(/\s+/)[1] ?? entry.name);
        } catch {
          /* ticket removed while listing */
        }
      }
    } catch {
      /* the slot directory may not exist yet */
    }
    return json(res, {
      held,
      queued,
      text: `${held.length}/2 held${held.length ? ` (${held.join(", ")})` : ""}${queued.length ? `, queued: ${queued.join(", ")}` : ""}`,
    });
  }

  if (req.method === "POST") {
    const body = await readBody(req);
    const cmd = { cmd: url.pathname.replace("/api/", ""), ...body };
    try {
      const result = await handle(cmd);
      record({ path: url.pathname, body, ok: true });
      return json(res, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record({ path: url.pathname, body, ok: false, message });
      return json(res, { error: message }, 400);
    }
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}).listen(UI_PORT, "127.0.0.1", () => {
  log(`UI on http://127.0.0.1:${UI_PORT} (pid ${process.pid})`);
});

// A lane that throws inside a tool must not take the whole crew down with it.
process.on("unhandledRejection", (reason) =>
  log("unhandledRejection", reason instanceof Error ? reason.message : String(reason)),
);
