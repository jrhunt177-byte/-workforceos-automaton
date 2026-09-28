import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export type Role = "research" | "draft" | "review";
export interface JobSpec {
  id: string;
  role: Role;
  prompt: string;
  dependsOn?: string;
  allowanceMilliUsd: number;
}
export interface Pilot { id: string; budgetMilliUsd: number; jobs: JobSpec[] }
export interface Job extends JobSpec {
  status: "queued" | "running" | "done" | "failed";
  output: string | null;
  error: string | null;
  reportedMilliUsd: number | null;
}

const identifier = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function validatePilot(value: unknown): Pilot {
  const p = value as Pilot;
  if (!p || typeof p.id !== "string" || !identifier.test(p.id) || !Number.isSafeInteger(p.budgetMilliUsd) ||
      p.budgetMilliUsd < 1 || p.budgetMilliUsd > 5000 ||
      !Array.isArray(p.jobs) || p.jobs.length < 1 || p.jobs.length > 20) {
    throw new Error("Invalid pilot: use 1–20 jobs and a total allowance no greater than $5.");
  }
  const seen = new Set<string>();
  for (const j of p.jobs) {
    if (!j || typeof j.id !== "string" || !identifier.test(j.id) || seen.has(j.id) ||
        !["research", "draft", "review"].includes(j.role) ||
        typeof j.prompt !== "string" || !j.prompt.trim() || j.prompt.length > 20000 ||
        !Number.isSafeInteger(j.allowanceMilliUsd) || j.allowanceMilliUsd < 1 ||
        j.allowanceMilliUsd > p.budgetMilliUsd ||
        (j.dependsOn !== undefined && !seen.has(j.dependsOn))) {
      throw new Error("Invalid job: unique ID, valid role/allowance, and earlier dependency required.");
    }
    seen.add(j.id);
  }
  return p;
}

/** Separate state store: never reads the upstream wallet or ~/.automaton. */
export class PilotStore {
  readonly db: Database.Database;
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(directory, "pilot.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pilot (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, budget INTEGER NOT NULL, reserved INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, role TEXT NOT NULL, prompt TEXT NOT NULL, dependsOn TEXT,
        allowanceMilliUsd INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        output TEXT, error TEXT, reportedMilliUsd INTEGER, startedAt TEXT, finishedAt TEXT
      );
    `);
  }
  initialize(value: unknown): void {
    const p = validatePilot(value);
    const fingerprint = createHash("sha256").update(JSON.stringify(p)).digest("hex");
    this.db.transaction(() => {
      const existing = this.db.prepare("SELECT fingerprint FROM pilot").get() as {fingerprint: string} | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error("This state belongs to a different pilot. It cannot be reset by reinitializing.");
        return;
      }
      this.db.prepare("INSERT INTO pilot(singleton,id,fingerprint,budget) VALUES(1,?,?,?)")
        .run(p.id, fingerprint, p.budgetMilliUsd);
      const insert = this.db.prepare("INSERT INTO jobs(id,role,prompt,dependsOn,allowanceMilliUsd) VALUES(?,?,?,?,?)");
      for (const j of p.jobs) insert.run(j.id, j.role, j.prompt, j.dependsOn ?? null, j.allowanceMilliUsd);
    }).immediate();
  }
  jobs(): Job[] { return this.db.prepare("SELECT * FROM jobs ORDER BY rowid").all() as Job[]; }
  status() {
    const p = this.db.prepare("SELECT id,budget,reserved,paused FROM pilot").get();
    if (!p) throw new Error("Pilot is not initialized. Run init first.");
    return { pilot: p, jobs: this.jobs().map(({prompt, output, ...j}) => ({...j, hasOutput: output !== null})) };
  }
  paused(): boolean {
    const p = this.db.prepare("SELECT paused FROM pilot").get() as {paused: number} | undefined;
    return !p || p.paused === 1;
  }
  pause(value = true): void { this.db.prepare("UPDATE pilot SET paused=?").run(value ? 1 : 0); }
  claim(): Job | undefined {
    return this.db.transaction(() => {
      const p = this.db.prepare("SELECT budget,reserved,paused FROM pilot").get() as
        {budget: number; reserved: number; paused: number} | undefined;
      if (!p) throw new Error("Pilot is not initialized.");
      if (p.paused) return;
      // Serial execution also prevents separate processes bypassing dependencies or allowances.
      if (this.db.prepare("SELECT 1 FROM jobs WHERE status='running'").get()) return;
      const next = this.db.prepare(`SELECT j.* FROM jobs j WHERE j.status='queued'
        AND (j.dependsOn IS NULL OR EXISTS(SELECT 1 FROM jobs d WHERE d.id=j.dependsOn AND d.status='done'))
        ORDER BY j.rowid LIMIT 1`).get() as Job | undefined;
      if (!next) return;
      if (p.reserved + next.allowanceMilliUsd > p.budget) {
        this.pause();
        return;
      }
      // Reservations are retained even after errors/crashes; uncertain calls are never retried automatically.
      this.db.prepare("UPDATE pilot SET reserved=reserved+?").run(next.allowanceMilliUsd);
      this.db.prepare("UPDATE jobs SET status='running',startedAt=? WHERE id=?")
        .run(new Date().toISOString(), next.id);
      return {...next, status: "running" as const};
    }).immediate();
  }
  complete(id: string, output: string, reportedMilliUsd: number): void {
    this.db.transaction(() => {
      const j = this.db.prepare("SELECT * FROM jobs WHERE id=? AND status='running'").get(id) as Job | undefined;
      if (!j) throw new Error("Job is not running.");
      if (!output.trim() || !Number.isSafeInteger(reportedMilliUsd) || reportedMilliUsd < 0) {
        throw new Error("Missing output or valid provider cost estimate.");
      }
      if (reportedMilliUsd > j.allowanceMilliUsd) {
        // Treat a provider cap overrun as a failed job; dependent jobs must not start.
        this.db.prepare("UPDATE jobs SET status='failed',output=?,reportedMilliUsd=?,error=?,finishedAt=? WHERE id=?")
          .run(output, reportedMilliUsd, "Provider exceeded allocation; pilot paused.", new Date().toISOString(), id);
        this.pause();
        return;
      }
      this.db.prepare("UPDATE jobs SET status='done',output=?,reportedMilliUsd=?,finishedAt=? WHERE id=?")
        .run(output, reportedMilliUsd, new Date().toISOString(), id);
    }).immediate();
  }
  fail(id: string, reason: string): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE jobs SET status='failed',error=?,finishedAt=? WHERE id=? AND status='running'")
        .run(reason, new Date().toISOString(), id);
      this.pause();
    }).immediate();
  }
  /** Only after the operator has stopped the old worker; never requeues uncertain work. */
  abandonInterrupted(): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE jobs SET status='failed',error='Interrupted; allocation retained; not retried' WHERE status='running'").run();
      this.pause();
    }).immediate();
  }
  export(): string {
    const document = ["# WorkforceOS pilot — DRAFT / NOT SENT", "",
      "Generated work requires review. No customer contact, publication, sale, or payment is implied.", "",
      "Status and estimated usage:", "```json", JSON.stringify(this.status(), null, 2), "```", "",
      ...this.jobs().flatMap(j => [`## ${j.id} (${j.status})`, "", j.output ?? j.error ?? "No output yet.", ""])
    ].join("\n");
    const target = path.join(this.directory, "report.md");
    const temporary = path.join(this.directory, `report-${process.pid}.tmp`);
    fs.writeFileSync(temporary, document, { mode: 0o600 });
    fs.renameSync(temporary, target);
    return target;
  }
  close(): void { this.db.close(); }
}
