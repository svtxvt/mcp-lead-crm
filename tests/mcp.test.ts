import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

let root: string;
let client: Client;
let transport: StdioClientTransport;
let leadId = "";

function resourceText(resource: Awaited<ReturnType<Client["readResource"]>>): string {
  const value = (resource.contents[0] as { text?: unknown } | undefined)?.text;
  if (typeof value !== "string") throw new Error("Expected text resource content");
  return value;
}

function firstText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("Expected text tool content");
  return first.text;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  return firstText(result);
}

describe.sequential("stdio MCP server", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "mcp-lead-crm-mcp-"));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/index.js")],
      cwd: process.cwd(),
      env: { ...process.env, LEAD_CRM_DB: join(root, "crm.json"), N8N_WEBHOOK_URL: "" } as Record<string, string>,
      stderr: "pipe",
    });
    client = new Client({ name: "mcp-lead-crm-tests", version: "1.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  test("advertises all ten tools with descriptions", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "add_lead",
      "due_followups",
      "export_csv",
      "import_csv",
      "list_pipeline",
      "log_activity",
      "move_stage",
      "qualify_lead",
      "search_leads",
      "trigger_n8n",
    ]);
    expect(tools.tools.every((tool) => Boolean(tool.description))).toBe(true);
  });

  test("add_lead creates L-0001 in new stage", async () => {
    const lead = JSON.parse(await call("add_lead", {
      name: "Taylor Reed",
      email: "taylor@example.com",
      company: "Brewline Coffee",
      source: "website",
      notes: "Asked for an automation demo",
    }));
    leadId = lead.id;
    expect(lead).toMatchObject({ id: "L-0001", stage: "new", name: "Taylor Reed" });
  });

  test("qualify_lead scores and records qualification", async () => {
    const lead = JSON.parse(await call("qualify_lead", { id: leadId, score: 82, reason: "Budget and timeline confirmed" }));
    expect(lead).toMatchObject({ id: leadId, score: 82, stage: "qualified" });
    expect(lead.activities.at(-1).type).toBe("qualification");
  });

  test("move_stage moves and records the transition", async () => {
    const lead = JSON.parse(await call("move_stage", { id: leadId, stage: "contacted", note: "Intro sent" }));
    expect(lead.stage).toBe("contacted");
    expect(lead.activities.at(-1)).toMatchObject({ type: "stage_change" });
  });

  test("log_activity creates a follow-up task", async () => {
    const dueAt = new Date(Date.now() + 3_600_000).toISOString();
    const activity = JSON.parse(await call("log_activity", { id: leadId, type: "task", note: "Send workflow map", due_at: dueAt }));
    expect(activity).toMatchObject({ type: "task", note: "Send workflow map", due_at: dueAt });
  });

  test("normalizes offset follow-up timestamps before persisting", async () => {
    const activity = JSON.parse(await call("log_activity", {
      id: leadId,
      type: "task",
      note: "Offset timestamp regression",
      due_at: "2030-01-02T10:00:00+02:00",
    }));
    expect(activity.due_at).toBe("2030-01-02T08:00:00.000Z");
    const resource = await client.readResource({ uri: `crm://lead/${leadId}` });
    expect(JSON.parse(resourceText(resource)).id).toBe(leadId);
  });

  test("due_followups returns tasks in the window", async () => {
    const followups = JSON.parse(await call("due_followups", { days: 1 }));
    expect(followups).toMatchObject([{ lead_id: leadId, note: "Send workflow map" }]);
  });

  test("search_leads matches company and notes", async () => {
    expect(JSON.parse(await call("search_leads", { query: "automation demo" }))).toMatchObject([{ id: leadId }]);
    expect(JSON.parse(await call("search_leads", { query: "brewline" }))).toMatchObject([{ id: leadId }]);
  });

  test("list_pipeline returns a compact filtered table", async () => {
    const table = await call("list_pipeline", { stage: "contacted", limit: 1 });
    expect(table).toContain("| L-0001 | Taylor Reed | Brewline Coffee | contacted | 82 |");
  });

  test("export_csv writes the documented columns", async () => {
    const path = join(root, "exports", "leads.csv");
    expect(JSON.parse(await call("export_csv", { path }))).toEqual({ path, exported: 1 });
    expect(await readFile(path, "utf8")).toMatch(/^id,name,email,phone,company,source,stage,score,created_at,updated_at,notes\n/);
  });

  test("import_csv imports a new lead", async () => {
    const path = join(root, "import.csv");
    const timestamp = new Date().toISOString();
    await writeFile(
      path,
      `id,name,email,phone,company,source,stage,score,created_at,updated_at,notes\nL-0042,Jordan Lee,jordan@example.com,,Northwind Dental,referral,proposal,75,${timestamp},${timestamp},"Ready, soon"\n`,
    );
    expect(JSON.parse(await call("import_csv", { path }))).toEqual({ imported: 1, created: 1, updated: 0 });
    expect(JSON.parse(await call("search_leads", { query: "Northwind" }))).toMatchObject([{ id: "L-0042" }]);
  });

  test("trigger_n8n dry-runs and records activity without credentials", async () => {
    const result = JSON.parse(await call("trigger_n8n", {
      event: "followup_email",
      lead_id: leadId,
      payload: { template: "friendly-reminder" },
    }));
    expect(result).toMatchObject({
      dry_run: true,
      request: { method: "POST", body: { event: "followup_email", lead_id: leadId } },
    });
    const resource = await client.readResource({ uri: `crm://lead/${leadId}` });
    const lead = JSON.parse(resourceText(resource));
    expect(lead.activities.at(-1).type).toBe("n8n:dry-run");
  });

  test("trigger_n8n without lead_id previews a dry run without recording it", async () => {
    const before = await readFile(join(root, "crm.json"), "utf8");
    expect(JSON.parse(await call("trigger_n8n", { event: "custom" }))).toEqual({
      dry_run: true,
      request: { method: "POST", body: { event: "custom" } },
    });
    expect(await readFile(join(root, "crm.json"), "utf8")).toBe(before);
  });

  test("serves pipeline and lead resources", async () => {
    const summary = await client.readResource({ uri: "crm://pipeline/summary" });
    expect(JSON.parse(resourceText(summary))).toMatchObject({ counts: { contacted: 1, proposal: 1 } });

    const lead = await client.readResource({ uri: `crm://lead/${leadId}` });
    expect(JSON.parse(resourceText(lead))).toMatchObject({ id: leadId, name: "Taylor Reed" });
  });

  test("renders daily_followup_briefing from live CRM data", async () => {
    const prompt = await client.getPrompt({ name: "daily_followup_briefing" });
    const content = prompt.messages[0]?.content;
    expect(content?.type).toBe("text");
    if (content?.type === "text") {
      expect(content.text).toContain("Send workflow map");
      expect(content.text).toContain('"contacted":1');
    }
  });
});
