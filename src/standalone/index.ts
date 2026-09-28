#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PilotStore } from "./store.js";
import { ClaudeCodeProvider } from "./claude.js";
import { runNext } from "./worker.js";

async function main() {
  const command = process.argv[2] ?? "help";
  if (command === "help") {
    console.log("WorkforceOS standalone pilot\nCommands: init <pilot.json>, doctor, status, once, run, pause, resume, abandon-interrupted, export\nWORKFORCE_STATE_DIR selects persistent state (default ~/.workforceos-pilot).\nNo Conway, wallet, API key, or automatic payment is used. See standalone/README.md.");
    return;
  }
  if (!["init", "doctor", "status", "once", "run", "pause", "resume", "abandon-interrupted", "export"].includes(command)) {
    throw new Error("Unknown command. Use help.");
  }
  const directory = path.resolve(process.env.WORKFORCE_STATE_DIR ?? path.join(os.homedir(), ".workforceos-pilot"));
  const store = new PilotStore(directory);
  const workspace = path.join(directory, "workspace");
  fs.mkdirSync(workspace, {recursive: true, mode: 0o700});
  const provider = new ClaudeCodeProvider(process.env.WORKFORCE_CLAUDE_BIN ?? "claude", workspace);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (command === "init") {
      if (!process.argv[3]) throw new Error("Supply a pilot JSON file.");
      store.initialize(JSON.parse(fs.readFileSync(process.argv[3], "utf8")));
    } else if (command === "doctor") {
      await provider.preflight();
      console.log("Claude subscription authentication verified. No inference was requested. Hosting and account billing still require operator verification.");
      return;
    } else if (command === "pause" || command === "resume") store.pause(command === "pause");
    else if (command === "abandon-interrupted") store.abandonInterrupted();
    else if (command === "once" || command === "run") {
      do {
        const ran = await runNext(store, provider, controller.signal);
        console.log(JSON.stringify(store.status()));
        if (command === "once" || !ran || store.paused() || controller.signal.aborted) break;
        await delay(1000, undefined, {signal: controller.signal}).catch(() => {});
      } while (!controller.signal.aborted);
    }
    console.log(JSON.stringify(store.status(), null, 2));
    console.log(`Report: ${store.export()}`);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    store.close();
  }
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : "Standalone pilot failed.");
  process.exitCode = 1;
});
