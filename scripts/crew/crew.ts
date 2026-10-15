/**
 * crew — the control surface for crew-host.
 *
 * One command per call, because the parent drives this from separate tool
 * invocations. Talks JSONL to the host over 127.0.0.1:$CREW_HOST_PORT.
 *
 *   bun .scratch/scripts/crew.ts start                 # launch the host detached
 *   bun .scratch/scripts/crew.ts stop
 *   bun .scratch/scripts/crew.ts list                  # every lane, one view
 *   bun .scratch/scripts/crew.ts spawn <lane> <cwd> "<prompt>"
 *   bun .scratch/scripts/crew.ts send <lane> "<text>" [--follow]
 *   bun .scratch/scripts/crew.ts abort <lane>
 *   bun .scratch/scripts/crew.ts tail <lane> [chars]
 *   bun .scratch/scripts/crew.ts kill <lane>
 *   bun .scratch/scripts/crew.ts watch [seconds]       # stream events
 */
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/** The repo root. The crew tooling runs from the main checkout, never a lane's
 *  worktree, so every shared path below hangs off this one value. */
const REPO = process.env.CREW_REPO ?? "D:/projects/mani-project";

const PORT = Number(process.env.CREW_HOST_PORT ?? 8899);
const UI_PORT = Number(process.env.CREW_UI_PORT ?? 8900);
const STATE = "${REPO}/.scratch/sessions/crew/host-state.json";
const REPO = "${REPO}";

const [command, ...rest] = process.argv.slice(2);

/** One request/response round trip, then exit. */
function ask(cmd: unknown, { watch = 0 } = {}): Promise<void> {
  return new Promise((resolve) => {
    const socket = connect(PORT, "127.0.0.1");
    let buffer = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve();
    };
    socket.on("connect", () => socket.write(`${JSON.stringify(cmd)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line.trim()) continue;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        render(event);
        // A plain command ends on its ack; `watch` keeps streaming.
        if (event.ev === "ack" || event.ev === "error") {
          if (!watch) return finish();
        }
      }
    });
    socket.on("error", (error) => {
      console.error(
        `cannot reach crew-host on 127.0.0.1:${PORT} (${error.message}).\n` +
          `start it with: bun .scratch/scripts/crew.ts start`,
      );
      process.exit(1);
    });
    socket.on("close", finish);
    if (watch) setTimeout(finish, watch * 1000);
  });
}

function render(event: any) {
  switch (event.ev) {
    case "ready":
      console.log(`host ready (pid ${event.pid}, ${event.lanes ?? 0} lanes)`);
      break;
    case "text":
      process.stdout.write(event.delta);
      break;
    case "tool":
      process.stdout.write(`\n  [${event.lane}] tool: ${event.name}\n`);
      break;
    case "working":
    case "settled":
      process.stdout.write(`\n  [${event.lane}] ${event.ev}${event.status ? ` (${event.status})` : ""}\n`);
      break;
    case "ack":
      if (event.lanes) {
        console.log(`\n${event.lanes.length} lane(s):`);
        for (const lane of event.lanes) {
          console.log(
            `  ${lane.lane.padEnd(34)} ${lane.status.padEnd(8)} turns=${lane.turns} tools=${lane.toolCalls}`,
          );
          if (lane.error) console.log(`      error: ${lane.error}`);
          if (lane.lastText) console.log(`      last: ${lane.lastText.slice(-120).replace(/\n/g, " ")}`);
        }
      } else if (event.text !== undefined) {
        console.log(event.text);
      } else if (event.ok && !event.lane) {
        console.log("ok");
      } else if (event.ok) {
        console.log(`ok: ${event.lane} ${event.status ?? ""}`);
      }
      break;
    case "error":
      console.error(`error: ${event.message}`);
      break;
    case "shutdown":
      console.log("host shutting down");
      break;
    default:
      break;
  }
}

async function start() {
  // Probe with a raw socket: `ask()` exits the process on a refused connection,
  // which is right for a command and wrong for a "is it already up?" check.
  const up = await new Promise((resolve) => {
    const socket = connect(PORT, "127.0.0.1");
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
    setTimeout(() => done(false), 1500);
  });

  if (up) {
    let pid = "?";
    try {
      pid = JSON.parse(readFileSync(STATE, "utf8")).pid;
    } catch {
      /* the snapshot is optional */
    }
    console.log(`host already running (pid ${pid}, port ${PORT})`);
    return;
  }

  const child = spawn("bun", [".scratch/scripts/crew-host.ts"], {
    cwd: REPO,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.log(`started crew-host (pid ${child.pid}) — control :${PORT}, UI http://127.0.0.1:${UI_PORT}`);
}

switch (command) {
  case "start":
    await start();
    break;
  case "stop":
    await ask({ cmd: "quit" });
    break;
  case "list":
    await ask({ cmd: "list" });
    break;
  case "spawn":
    await ask({ cmd: "spawn", lane: rest[0], cwd: rest[1], prompt: rest[2] ?? "" });
    break;
  case "send":
    await ask({
      cmd: "send",
      lane: rest[0],
      text: rest.filter((a) => a !== "--follow").slice(1).join(" "),
      mode: rest.includes("--follow") ? "followUp" : "steer",
    });
    break;
  case "abort":
    await ask({ cmd: "abort", lane: rest[0] });
    break;
  case "tail":
    await ask({ cmd: "tail", lane: rest[0], chars: Number(rest[1] ?? 2000) });
    break;
  case "kill":
    await ask({ cmd: "kill", lane: rest[0] });
    break;
  case "watch":
    await ask({ cmd: "list" }, { watch: Number(rest[0] ?? 20) });
    break;
  default:
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace("/**", "").trim());
    break;
}
