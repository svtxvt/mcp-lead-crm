import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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

export class JsonStore implements Store {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  private async read(): Promise<Database> {
    try {
      return DatabaseSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDatabase();
      throw new Error(`Cannot read CRM database ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async write(db: Database): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const validated = DatabaseSchema.parse(db);
      await writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await rename(tempPath, this.path);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  // ponytail: one stdio server owns the file; add an OS lock if multiple processes must share it.
  private async mutate<T>(change: (db: Database) => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.writeQueue;
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const db = await this.read();
      const result = await change(db);
      await this.write(db);
      return result;
    } finally {
      release();
    }
  }

  private async snapshot(): Promise<Database> {
    await this.writeQueue;
    return this.read();
  }

  private csvPath(path: string): string {
    const base = dirname(resolve(this.path));
    const candidate = resolve(base, path);
    const escape = relative(base, candidate);
    if (escape.startsWith("..") || isAbsolute(escape) || candidate === resolve(this.path)) {
      throw new Error(`CSV path must stay inside ${base} and must not be the CRM database`);
    }
    return candidate;
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
    const rows = parseCsv(await readFile(this.csvPath(path), "utf8"));
    const header = rows.shift();
    if (!header || csvColumns.some((column) => !header.includes(column))) {
      throw new Error(`CSV must include columns: ${csvColumns.join(",")}`);
    }
    const positions = Object.fromEntries(header.map((column, index) => [column, index])) as Record<string, number>;

    return this.mutate((db) => {
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
    const leads = (await this.snapshot()).leads;
    const outputPath = this.csvPath(path);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, toCsv(leads), "utf8");
    return leads.length;
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
