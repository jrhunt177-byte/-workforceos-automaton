import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PilotStore, validatePilot, type Pilot, type Job } from "../standalone/store.js";
import { ClaudeCodeProvider, claudeArguments, parseResult, subscriptionEnvironment, type PilotProvider } from "../standalone/claude.js";
import { runNext } from "../standalone/worker.js";

const directories: string[] = [];
const stores: PilotStore[] = [];
function temp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "workforce-test-"));
  directories.push(d);
  return d;
}
function pilot(): Pilot {
  return {id: "test-pilot", budgetMilliUsd: 5000, jobs: [
    {id: "research", role: "research", prompt: "Find evidence.", allowanceMilliUsd: 2000},
    {id: "draft", role: "draft", prompt: "Prepare a draft.", dependsOn: "research", allowanceMilliUsd: 1000},
    {id: "review", role: "review", prompt: "Review the draft.", dependsOn: "draft", allowanceMilliUsd: 500},
  ]};
}
function store(directory = temp()) {
  const s = new PilotStore(directory);
  stores.push(s);
  s.initialize(pilot());
  return s;
}
function reserved(s: PilotStore) { return (s.status().pilot as {reserved: number}).reserved; }
const signal = () => new AbortController().signal;
afterEach(() => {
  for (const s of stores.splice(0)) { if (s.db.open) s.close(); }
  for (const d of directories.splice(0)) fs.rmSync(d, {recursive: true, force: true});
});

describe("persistent allocation and queue", () => {
  it.each([undefined, null, {}, {...pilot(), id: undefined}, {...pilot(), id: 123},
    {...pilot(), budgetMilliUsd: 5001}, {...pilot(), budgetMilliUsd: -1},
    {...pilot(), budgetMilliUsd: 1.2}, {...pilot(), jobs: []}])("rejects invalid pilot %j", value => {
    expect(() => validatePilot(value)).toThrow();
  });
  it("rejects missing IDs, duplicate IDs, unsupported roles and forward dependencies", () => {
    for (const change of [{id: undefined}, {id: "draft"}, {role: "shell"}, {dependsOn: "draft"}, {allowanceMilliUsd: NaN}]) {
      const p = pilot();
      Object.assign(p.jobs[0], change);
      expect(() => validatePilot(p)).toThrow();
    }
  });
  it("reserves atomically across connections and preserves work on restart", () => {
    const s = store();
    const other = store(s.directory);
    expect(s.claim()?.id).toBe("research");
    expect(other.claim()).toBeUndefined();
    expect(reserved(other)).toBe(2000);
    s.complete("research", "Evidence", 300);
    s.close();
    expect(other.claim()?.id).toBe("draft");
    expect(reserved(other)).toBe(3000);
    other.initialize(pilot());
    expect(reserved(other)).toBe(3000);
    expect(() => other.initialize({...pilot(), budgetMilliUsd: 4000})).toThrow(/cannot be reset/);
  });
  it("does not retry an interrupted job or release its allocation", () => {
    const s = store();
    s.claim();
    s.close();
    const restarted = store(s.directory);
    expect(restarted.claim()).toBeUndefined();
    restarted.abandonInterrupted();
    restarted.pause(false);
    expect(restarted.claim()).toBeUndefined();
    expect(restarted.jobs()[0].status).toBe("failed");
    expect(reserved(restarted)).toBe(2000);
  });
  it("pauses before reservations would exceed the lifetime allowance", () => {
    const s = new PilotStore(temp()); stores.push(s);
    const p = pilot(); p.budgetMilliUsd = 2500;
    s.initialize(p);
    s.claim(); s.complete("research", "Evidence", 1);
    expect(s.claim()).toBeUndefined();
    expect(s.paused()).toBe(true);
    expect(s.jobs()[1].status).toBe("queued");
    expect(reserved(s)).toBe(2000);
  });
  it("holds the full reservation and blocks dependents after a provider overrun", () => {
    const s = store(); s.claim();
    s.complete("research", "Evidence", 2001);
    expect(s.jobs()[0].status).toBe("failed");
    expect(s.paused()).toBe(true);
    s.pause(false);
    expect(s.claim()).toBeUndefined();
    expect(reserved(s)).toBe(2000);
  });
});

describe("worker lifecycle", () => {
  it("runs the complete pipeline once, hands off evidence and exports reviewable text", async () => {
    const s = store(); const calls: string[] = [];
    const provider: PilotProvider = {preflight: async () => {}, run: async (job, prompt) => {
      calls.push(job.id);
      if (job.dependsOn) expect(prompt).toContain(`Output from ${job.dependsOn}`);
      return {text: `Output from ${job.id}`, reportedMilliUsd: 100};
    }};
    while (await runNext(s, provider, signal())) { /* bounded by queue */ }
    expect(calls).toEqual(["research", "draft", "review"]);
    expect(reserved(s)).toBe(3500);
    const report = fs.readFileSync(s.export(), "utf8");
    expect(report).toContain("DRAFT / NOT SENT");
    expect(report).toContain("Output from review");
    s.close();
    const restarted = store(s.directory);
    expect(await runNext(restarted, provider, signal())).toBe(false);
    expect(calls).toHaveLength(3);
  });
  it("does not allocate when provider authentication fails", async () => {
    const s = store();
    const provider: PilotProvider = {preflight: async () => {throw new Error("Login required");},
      run: async () => {throw new Error("Must not execute");}};
    await expect(runNext(s, provider, signal())).rejects.toThrow("Login required");
    expect(reserved(s)).toBe(0);
    expect(s.jobs().every(j => j.status === "queued")).toBe(true);
  });
  it("keeps failed allocations and blocks automatic retries", async () => {
    const s = store(); let calls = 0;
    const provider: PilotProvider = {preflight: async () => {}, run: async () => {
      calls++; throw new Error("Uncertain response");
    }};
    await runNext(s, provider, signal());
    expect(await runNext(s, provider, signal())).toBe(false);
    expect(calls).toBe(1); expect(reserved(s)).toBe(2000); expect(s.paused()).toBe(true);
  });
  it("propagates cancellation to a running provider and records the failed job", async () => {
    const s = store(); const controller = new AbortController();
    const provider: PilotProvider = {preflight: async () => {}, run: async (_job, _prompt, abortSignal) => {
      return new Promise((_resolve, reject) => {
        abortSignal.addEventListener("abort", () => reject(new Error("Stopped")), {once: true});
        controller.abort();
      });
    }};
    await runNext(s, provider, controller.signal);
    expect(s.jobs()[0].status).toBe("failed"); expect(s.paused()).toBe(true);
    expect(reserved(s)).toBe(2000);
  });
});

describe("Claude boundary", () => {
  it("excludes API billing credentials and arbitrary runtime options", () => {
    const env = subscriptionEnvironment({PATH: "/bin", HOME: "/tmp/test", ANTHROPIC_API_KEY: "dummy",
      ANTHROPIC_BASE_URL: "https://invalid.example", NODE_OPTIONS: "unwanted",
      CLAUDE_CODE_USE_BEDROCK: "1", AWS_ACCESS_KEY_ID: "dummy"});
    expect(env).toEqual({PATH: "/bin", HOME: "/tmp/test", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"});
  });
  it.each(["research", "draft", "review"] as const)("limits %s tool access", role => {
    const args = claudeArguments({...pilot().jobs[0], role} as Job);
    expect(args[args.indexOf("--tools") + 1]).toBe(role === "research" ? "WebSearch,WebFetch" : "");
    expect(args).toContain("--safe-mode"); expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("2.000");
  });
  it("fails closed on missing cost, failed result and partial output", () => {
    for (const value of [{type: "result", subtype: "success", result: "Draft"},
      {type: "result", subtype: "error_max_turns", result: "Partial", total_cost_usd: 0.1},
      {type: "result", subtype: "success", is_error: true, result: "Error", total_cost_usd: 0},
      {type: "result", subtype: "success", result: "", total_cost_usd: 0.1}]) {
      expect(() => parseResult(JSON.stringify(value))).toThrow();
    }
    expect(parseResult(JSON.stringify({type: "result", subtype: "success", result: "Draft", total_cost_usd: 0.0001})))
      .toEqual({text: "Draft", reportedMilliUsd: 1});
  });
  it("does not start the CLI without an explicit account-setting acknowledgement", async () => {
    const provider = new ClaudeCodeProvider("/does-not-exist", temp(), {});
    await expect(provider.preflight()).rejects.toThrow(/paid extra usage OFF/);
  });
  it("exercises authentication, stdin and JSON parsing through a local fake executable", async () => {
    const d = temp(); const binary = path.join(d, "fake-claude");
    fs.writeFileSync(binary, `#!${process.execPath}\nconst a=process.argv.slice(2);
if(a[0]==='--version') console.log('2.1.283 (Claude Code)');
else if(a[0]==='auth') console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',subscriptionType:'max'}));
else {let p='';process.stdin.on('data',c=>p+=c);process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',subtype:'success',result:p,total_cost_usd:0.001})));}\n`, {mode: 0o700});
    const provider = new ClaudeCodeProvider(binary, d, {WORKFORCE_SUBSCRIPTION_ONLY: "confirmed-extra-usage-off"});
    await provider.preflight();
    const result = await provider.run(pilot().jobs[0] as Job, "DRAFT with literal $(not-a-command)", signal());
    expect(result).toEqual({text: "DRAFT with literal $(not-a-command)", reportedMilliUsd: 1});
  });
});
