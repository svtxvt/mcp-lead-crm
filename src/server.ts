import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { ACTIVITY_TYPES, JsonStore, SOURCES, STAGES, type Lead, type Store } from "./store.js";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

function pipelineTable(leads: Lead[]): string {
  const rows = leads.map((lead) => {
    const last = lead.activities.at(-1)?.created_at ?? lead.updated_at;
    return `| ${lead.id} | ${lead.name} | ${lead.company ?? "—"} | ${lead.stage} | ${lead.score ?? "—"} | ${last} |`;
  });
  return ["| ID | Name | Company | Stage | Score | Last activity |", "|---|---|---|---|---:|---|", ...rows].join("\n");
}

export function createServer(store: Store, webhookUrl = process.env.N8N_WEBHOOK_URL): McpServer {
  const server = new McpServer({ name: "mcp-lead-crm", version: "0.1.0" });

  server.registerTool("add_lead", {
    description: "Add a new lead to the CRM pipeline.",
    inputSchema: {
      name: z.string().trim().min(1),
      email: z.email().optional(),
      phone: z.string().trim().min(1).optional(),
      company: z.string().trim().min(1).optional(),
      source: z.enum(SOURCES).optional(),
      notes: z.string().optional(),
    },
  }, async (input) => text(await store.addLead(input)));

  server.registerTool("qualify_lead", {
    description: "Score a lead and mark it qualified at 60 or above, otherwise unqualified.",
    inputSchema: {
      id: z.string().regex(/^L-\d{4,}$/),
      score: z.number().int().min(0).max(100),
      reason: z.string().trim().min(1),
    },
  }, async ({ id, score, reason }) => text(await store.qualifyLead(id, score, reason)));

  server.registerTool("move_stage", {
    description: "Move a lead to another pipeline stage.",
    inputSchema: {
      id: z.string().regex(/^L-\d{4,}$/),
      stage: z.enum(STAGES),
      note: z.string().optional(),
    },
  }, async ({ id, stage, note }) => text(await store.moveStage(id, stage, note)));

  server.registerTool("log_activity", {
    description: "Record a call, email, meeting, note, or follow-up task for a lead.",
    inputSchema: {
      id: z.string().regex(/^L-\d{4,}$/),
      type: z.enum(ACTIVITY_TYPES),
      note: z.string().trim().min(1),
      due_at: z.iso.datetime({ offset: true }).optional(),
    },
  }, async ({ id, type, note, due_at }) => text(await store.logActivity(id, type, note, due_at)));

  server.registerTool("list_pipeline", {
    description: "List a compact view of leads in the pipeline.",
    inputSchema: {
      stage: z.enum(STAGES).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
  }, async ({ stage, limit }) => text(pipelineTable(await store.listLeads(stage, limit))));

  server.registerTool("due_followups", {
    description: "List follow-up tasks due by the end of the requested window, including overdue tasks.",
    inputSchema: { days: z.number().int().min(0).max(3650).default(3) },
  }, async ({ days }) => text(await store.dueFollowups(days)));

  server.registerTool("search_leads", {
    description: "Search lead names, emails, companies, and notes.",
    inputSchema: { query: z.string().trim().min(1) },
  }, async ({ query }) => text(await store.searchLeads(query)));

  server.registerTool("import_csv", {
    description: "Import or update leads from a CSV file inside the CRM database directory. The file must use all 11 export columns; blank optional cells clear values.",
    inputSchema: { path: z.string().trim().min(1) },
  }, async ({ path }) => text(await store.importCsv(path)));

  server.registerTool("export_csv", {
    description: "Export all leads to a CSV file inside the CRM database directory.",
    inputSchema: { path: z.string().trim().min(1) },
  }, async ({ path }) => text({ path, exported: await store.exportCsv(path) }));

  server.registerTool("trigger_n8n", {
    description: "Trigger an n8n webhook, or return a safe dry run when no webhook URL is configured.",
    inputSchema: {
      event: z.enum(["followup_email", "lead_qualified", "stage_changed", "custom"]),
      lead_id: z.string().regex(/^L-\d{4,}$/).optional(),
      payload: z.unknown().optional(),
    },
  }, async ({ event, lead_id, payload }) => {
    if (lead_id && !(await store.getLead(lead_id))) throw new Error(`Lead ${lead_id} not found`);
    const body = { event, ...(lead_id ? { lead_id } : {}), ...(payload !== undefined ? { payload } : {}) };

    if (!webhookUrl) {
      if (lead_id) await store.logActivity(lead_id, "n8n:dry-run", JSON.stringify(body));
      return text({ dry_run: true, request: { method: "POST", body } });
    }

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      if (lead_id) await store.logActivity(lead_id, "n8n:trigger", JSON.stringify(body));
      return text({ dry_run: false, status: response.status, response: await response.text() });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") throw new Error("n8n webhook timed out after 10 seconds");
      throw new Error(`n8n webhook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  server.registerResource("pipeline-summary", "crm://pipeline/summary", {
    description: "Pipeline counts and the five nearest follow-ups.",
    mimeType: "application/json",
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await store.summary(), null, 2) }],
  }));

  server.registerResource("lead", new ResourceTemplate("crm://lead/{id}", { list: undefined }), {
    description: "One CRM lead including activity history.",
    mimeType: "application/json",
  }, async (uri, { id }) => {
    const lead = await store.getLead(String(id));
    if (!lead) throw new Error(`Lead ${String(id)} not found`);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(lead, null, 2) }] };
  });

  server.registerPrompt("daily_followup_briefing", {
    description: "Create a short briefing from today's follow-ups and the pipeline summary.",
  }, async () => {
    const [followups, summary] = await Promise.all([store.dueFollowups(1), store.summary()]);
    return {
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Write a concise daily sales briefing. Pipeline counts: ${JSON.stringify(summary.counts)}. Follow-ups due within one day (including overdue): ${JSON.stringify(followups)}.`,
        },
      }],
    };
  });

  return server;
}

export function storeFromEnvironment(): JsonStore {
  return new JsonStore(process.env.LEAD_CRM_DB ?? "./data/crm.json");
}
