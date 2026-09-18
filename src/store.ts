import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import * as z from "zod/v4";

export const STAGES = ["new", "qualified", "contacted", "proposal", "won", "lost", "unqualified"] as const;
export const SOURCES = ["website", "referral", "linkedin", "instagram", "ads", "other"] as const;
export const ACTIVITY_TYPES = ["call", "email", "meeting", "note", "task"] as const;

export type Stage = (typeof STAGES)[number];
export type Source = (typeof SOURCES)[number];
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export type SystemActivityType = ActivityType | "qualification" | "stage_change" | "n8n:dry-run" | "n8n:trigger";

export interface Activity {
  id: string;
  type: SystemActivityType;
  note: string;
  created_at: string;
  due_at?: string;
}

export interface Lead {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  source?: Source;
  stage: Stage;
  score?: number;
  created_at: string;
  updated_at: string;
  notes?: string;
  activities: Activity[];
}

export interface AddLeadInput {
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  source?: Source;
  notes?: string;
}

export interface Followup {
  lead_id: string;
  lead_name: string;
  company?: string;
  activity_id: string;
  note: string;
  due_at: string;
}

export interface PipelineSummary {
  counts: Record<Stage, number>;
  next_followups: Followup[];
}

export interface ImportResult {
  imported: number;
  created: number;
  updated: number;
}

export interface Store {
  addLead(input: AddLeadInput): Promise<Lead>;
  qualifyLead(id: string, score: number, reason: string): Promise<Lead>;
  moveStage(id: string, stage: Stage, note?: string): Promise<Lead>;
  logActivity(id: string, type: SystemActivityType, note: string, dueAt?: string): Promise<Activity>;
  getLead(id: string): Promise<Lead | undefined>;
  listLeads(stage?: Stage, limit?: number): Promise<Lead[]>;
  dueFollowups(days?: number): Promise<Followup[]>;
  searchLeads(query: string): Promise<Lead[]>;
  importCsv(path: string): Promise<ImportResult>;
  exportCsv(path: string): Promise<number>;
  summary(): Promise<PipelineSummary>;
  replace(leads: Lead[]): Promise<void>;
  drain(): Promise<void>;
}

const ActivitySchema = z.object({
  id: z.string(),
  type: z.enum([...ACTIVITY_TYPES, "qualification", "stage_change", "n8n:dry-run", "n8n:trigger"]),
  note: z.string(),
  created_at: z.iso.datetime(),
  due_at: z.iso.datetime().optional(),
});

const LeadSchema = z.object({
  id: z.string().regex(/^L-\d{4,}$/),
  name: z.string().min(1),
  email: z.string().optional(),
  phone: z.string().optional(),
  company: z.string().optional(),
  source: z.enum(SOURCES).optional(),
  stage: z.enum(STAGES),
  score: z.number().int().min(0).max(100).optional(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  notes: z.string().optional(),
  activities: z.array(ActivitySchema),
});

const DatabaseSchema = z.object({
  version: z.literal(1),
  next_lead_id: z.number().int().positive(),
  next_activity_id: z.number().int().positive(),
  leads: z.array(LeadSchema),
});

type Database = z.infer<typeof DatabaseSchema>;

const emptyDatabase = (): Database => ({
  version: 1,
  next_lead_id: 1,
  next_activity_id: 1,
  leads: [],
});

const csvColumns = [
  "id",
  "name",
  "email",
  "phone",
  "company",
  "source",
  "stage",
  "score",
  "created_at",
  "updated_at",
  "notes",
] as const;

function leadNumber(id: string): number {
  return Number(id.slice(2));
}

function activityNumber(id: string): number {
  return Number(id.slice(2));
}

function formatId(prefix: "L" | "A", value: number): string {
  return `${prefix}-${String(value).padStart(4, "0")}`;
}

function findLead(db: Database, id: string): Lead {
  const lead = db.leads.find((candidate) => candidate.id === id);
  if (!lead) throw new Error(`Lead ${id} not found`);
  return lead;
}

function addActivity(db: Database, lead: Lead, type: SystemActivityType, note: string, dueAt?: string): Activity {
  const activity: Activity = {
    id: formatId("A", db.next_activity_id++),
    type,
    note,
    created_at: new Date().toISOString(),
    ...(dueAt ? { due_at: new Date(dueAt).toISOString() } : {}),
  };
  lead.activities.push(activity);
  lead.updated_at = activity.created_at;
  return activity;
}

export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (quoted) throw new Error("Invalid CSV: unterminated quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvCell(value: string | number | undefined): string {
  const valueText = value === undefined ? "" : String(value);
  return /[",\r\n]/.test(valueText) ? `"${valueText.replaceAll('"', '""')}"` : valueText;
}

function toCsv(leads: Lead[]): string {
  const lines = [csvColumns.join(",")];
  for (const lead of leads) {
    lines.push(
      [lead.id, lead.name, lead.email, lead.phone, lead.company, lead.source, lead.stage, lead.score, lead.created_at, lead.updated_at, lead.notes]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

async function fileStat(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isInside(base: string, path: string): boolean {
  const escape = relative(base, path);
  return escape !== ".." && !escape.startsWith(`..${sep}`) && !isAbsolute(escape);
}

async function atomicWrite(path: string, content: string, beforeRename?: () => Promise<void>): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
    await beforeRename?.();
    await rename(tempPath, path);
  } finally {
    await unlink(tempPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export class JsonStore implements Store {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  private async databasePath(): Promise<string> {
    const path = resolve(this.path);
    await mkdir(dirname(path), { recursive: true });
    try {
      return await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return resolve(await realpath(dirname(path)), basename(path));
    }
  }

  private async read(path = this.path): Promise<Database> {
    try {
      return DatabaseSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDatabase();
      throw new Error(`Cannot read CRM database ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async acquireLock(path: string): Promise<() => Promise<void>> {
    const lockPath = `${path}.lock`;
    const reapPath = `${lockPath}.reap`;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (!(await fileStat(reapPath))) {
        try {
          const handle = await open(lockPath, "wx", 0o600);
          try {
            await handle.writeFile(JSON.stringify({ pid: process.pid }));
            const identity = await handle.stat();
            const release = async () => {
              await handle.close();
              const current = await fileStat(lockPath);
              if (current && sameFile(identity, current)) await unlink(lockPath);
            };
            if (!(await fileStat(reapPath))) return release;
            await release();
          } catch (error) {
            await handle.close();
            await unlink(lockPath).catch(() => undefined);
            throw error;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          await this.reapLock(lockPath, reapPath);
        }
      }
      await delay(10 + Math.random() * 30);
    }
    throw new Error("Timed out waiting for CRM database lock");
  }

  private async reapLock(lockPath: string, reapPath: string): Promise<void> {
    // ponytail: orphaned reclamation guards fail closed; remove them only with all servers stopped.
    let guard;
    try {
      guard = await open(reapPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      throw error;
    }
    try {
      await guard.writeFile(JSON.stringify({ pid: process.pid }));
      let pid: unknown;
      try {
        pid = JSON.parse(await readFile(lockPath, "utf8"))?.pid;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return;
        throw error;
      }
      if (!Number.isInteger(pid) || Number(pid) <= 0) return;
      try {
        process.kill(Number(pid), 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
        await unlink(lockPath);
      }
    } finally {
      await guard.close();
      await unlink(reapPath);
    }
  }

  private async exclusive<T>(operation: (path: string) => Promise<T>): Promise<T> {
    let releaseQueue!: () => void;
    const previous = this.writeQueue;
    this.writeQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previous;
    let releaseLock: (() => Promise<void>) | undefined;
    try {
      const path = await this.databasePath();
      releaseLock = await this.acquireLock(path);
      return await operation(path);
    } finally {
      try {
        await releaseLock?.();
      } finally {
        releaseQueue();
      }
    }
  }

  private async mutate<T>(change: (db: Database, path: string) => T | Promise<T>): Promise<T> {
    return this.exclusive(async (path) => {
      const db = await this.read(path);
      const result = await change(db, path);
      const validated = DatabaseSchema.parse(db);
      await atomicWrite(path, `${JSON.stringify(validated, null, 2)}\n`);
      return result;
    });
  }

  async drain(): Promise<void> {
    await this.writeQueue;
  }

  private async snapshot(): Promise<Database> {
    await this.writeQueue;
    return this.read();
  }

  private async csvPath(path: string, databasePath: string, exporting = false): Promise<string> {
    const base = dirname(databasePath);
    const candidate = resolve(base, path);
    const invalid = () => new Error("CSV path must stay inside the database directory and must not be the CRM database or its lock files");
    let parent = dirname(candidate);
    if (exporting) {
      // Validate the nearest existing parent before creating nested export directories.
      while (!(await fileStat(parent))) {
        const next = dirname(parent);
        if (next === parent) throw invalid();
        parent = next;
      }
      if (!isInside(base, await realpath(parent))) throw invalid();
      await mkdir(dirname(candidate), { recursive: true });
    }
    parent = await realpath(dirname(candidate));
    if (!isInside(base, parent)) throw invalid();
    const canonical = resolve(parent, basename(candidate));
    const reserved = [databasePath, `${databasePath}.lock`, `${databasePath}.lock.reap`];
    // Reserve these names even before the database or reclamation guard exists.
    if (reserved.some((path) => path.normalize("NFC").toLowerCase() === canonical.normalize("NFC").toLowerCase())) throw invalid();
    // The active lock identifies native filename aliases even before the database exists.
    const lockIdentity = await stat(`${databasePath}.lock`);
    const lockAliases = [`${canonical}.lock`];
    if (canonical.toLowerCase().endsWith(".reap")) lockAliases.push(canonical.slice(0, -5));
    for (const alias of lockAliases) {
      const aliasIdentity = await fileStat(alias);
      if (aliasIdentity && sameFile(aliasIdentity, lockIdentity)) throw invalid();
    }
    let identity: Stats | undefined;
    try {
      const entry = await lstat(canonical);
      if (exporting && entry.isSymbolicLink()) throw invalid();
      if (!isInside(base, await realpath(canonical))) throw invalid();
      identity = await stat(canonical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (identity) {
      for (const reservedPath of reserved) {
        const reservedIdentity = await fileStat(reservedPath);
        if (reservedIdentity && sameFile(identity, reservedIdentity)) throw invalid();
      }
    }
    return canonical;
  }

  async addLead(input: AddLeadInput): Promise<Lead> {
    return this.mutate((db) => {
      const now = new Date().toISOString();
      const lead: Lead = {
        id: formatId("L", db.next_lead_id++),
        name: input.name,
        stage: "new",
        created_at: now,
        updated_at: now,
        activities: [],
        ...(input.email ? { email: input.email } : {}),
        ...(input.phone ? { phone: input.phone } : {}),
        ...(input.company ? { company: input.company } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
      };
      db.leads.push(lead);
      return lead;
    });
  }

  async qualifyLead(id: string, score: number, reason: string): Promise<Lead> {
    return this.mutate((db) => {
      const lead = findLead(db, id);
      lead.score = score;
      lead.stage = score >= 60 ? "qualified" : "unqualified";
      addActivity(db, lead, "qualification", `Score ${score}: ${reason}`);
      return lead;
    });
  }

  async moveStage(id: string, stage: Stage, note?: string): Promise<Lead> {
    return this.mutate((db) => {
      const lead = findLead(db, id);
      const previous = lead.stage;
      lead.stage = stage;
      addActivity(db, lead, "stage_change", note ? `${previous} → ${stage}: ${note}` : `${previous} → ${stage}`);
      return lead;
    });
  }

  async logActivity(id: string, type: SystemActivityType, note: string, dueAt?: string): Promise<Activity> {
    return this.mutate((db) => addActivity(db, findLead(db, id), type, note, dueAt));
  }

  async getLead(id: string): Promise<Lead | undefined> {
    return (await this.snapshot()).leads.find((lead) => lead.id === id);
  }

  async listLeads(stage?: Stage, limit = 20): Promise<Lead[]> {
    return (await this.snapshot()).leads
      .filter((lead) => !stage || lead.stage === stage)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit);
  }

  async dueFollowups(days = 3): Promise<Followup[]> {
    const cutoff = Date.now() + days * 86_400_000;
    const result: Followup[] = [];
    for (const lead of (await this.snapshot()).leads) {
      for (const activity of lead.activities) {
        if (activity.type === "task" && activity.due_at && Date.parse(activity.due_at) <= cutoff) {
          result.push({
            lead_id: lead.id,
            lead_name: lead.name,
            activity_id: activity.id,
            note: activity.note,
            due_at: activity.due_at,
            ...(lead.company ? { company: lead.company } : {}),
          });
        }
      }
    }
    return result.sort((a, b) => a.due_at.localeCompare(b.due_at));
  }

  async searchLeads(query: string): Promise<Lead[]> {
    const needle = query.toLocaleLowerCase();
    return (await this.snapshot()).leads.filter((lead) =>
      [lead.name, lead.email, lead.company, lead.notes]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }

  async importCsv(path: string): Promise<ImportResult> {
    return this.mutate(async (db, databasePath) => {
      const rows = parseCsv(await readFile(await this.csvPath(path, databasePath), "utf8"));
      const header = rows.shift();
      if (!header || csvColumns.some((column) => !header.includes(column))) {
        throw new Error(`CSV must include columns: ${csvColumns.join(",")}`);
      }
      const positions = Object.fromEntries(header.map((column, index) => [column, index])) as Record<string, number>;
      let created = 0;
      let updated = 0;
      for (const row of rows) {
        if (row.every((cell) => cell === "")) continue;
        const value = (column: (typeof csvColumns)[number]) => row[positions[column]!] ?? "";
        const now = new Date().toISOString();
        const rawId = value("id");
        const id = rawId || formatId("L", db.next_lead_id++);
        const existing = db.leads.find((lead) => lead.id === id);
        const rawScore = value("score");
        const imported = LeadSchema.parse({
          id,
          name: value("name"),
          ...(value("email") ? { email: value("email") } : {}),
          ...(value("phone") ? { phone: value("phone") } : {}),
          ...(value("company") ? { company: value("company") } : {}),
          ...(value("source") ? { source: value("source") } : {}),
          stage: value("stage") || "new",
          ...(rawScore ? { score: Number(rawScore) } : {}),
          created_at: value("created_at") || existing?.created_at || now,
          updated_at: value("updated_at") || now,
          ...(value("notes") ? { notes: value("notes") } : {}),
          activities: existing?.activities ?? [],
        });
        if (existing) {
          db.leads[db.leads.indexOf(existing)] = imported;
          updated += 1;
        } else {
          db.leads.push(imported);
          created += 1;
        }
        db.next_lead_id = Math.max(db.next_lead_id, leadNumber(id) + 1);
      }
      return { imported: created + updated, created, updated };
    });
  }

  async exportCsv(path: string): Promise<number> {
    return this.exclusive(async (databasePath) => {
      const leads = (await this.read(databasePath)).leads;
      const outputPath = await this.csvPath(path, databasePath, true);
      await atomicWrite(outputPath, toCsv(leads), async () => {
        if (await this.csvPath(path, databasePath, true) !== outputPath) {
          throw new Error("CSV destination changed during export");
        }
      });
      return leads.length;
    });
  }

  async summary(): Promise<PipelineSummary> {
    const db = await this.snapshot();
    const counts = Object.fromEntries(STAGES.map((stage) => [stage, 0])) as Record<Stage, number>;
    for (const lead of db.leads) counts[lead.stage] += 1;
    const followups: Followup[] = [];
    for (const lead of db.leads) {
      for (const activity of lead.activities) {
        if (activity.type === "task" && activity.due_at) {
          followups.push({
            lead_id: lead.id,
            lead_name: lead.name,
            activity_id: activity.id,
            note: activity.note,
            due_at: activity.due_at,
            ...(lead.company ? { company: lead.company } : {}),
          });
        }
      }
    }
    return { counts, next_followups: followups.sort((a, b) => a.due_at.localeCompare(b.due_at)).slice(0, 5) };
  }

  async replace(leads: Lead[]): Promise<void> {
    await this.mutate((db) => {
      db.leads = z.array(LeadSchema).parse(leads);
      db.next_lead_id = Math.max(1, ...leads.map((lead) => leadNumber(lead.id) + 1));
      db.next_activity_id = Math.max(1, ...leads.flatMap((lead) => lead.activities.map((activity) => activityNumber(activity.id) + 1)));
    });
  }
}
