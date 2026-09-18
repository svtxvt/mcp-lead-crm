import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const TOOL_NAMES = [
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
];

let root: string;
let modern: Client;
const clients: Client[] = [];

async function connect(options?: ConstructorParameters<typeof Client>[1]): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js")],
    cwd: process.cwd(),
    env: { ...process.env, LEAD_CRM_DB: join(root, "crm.json"), N8N_WEBHOOK_URL: "" } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "protocol-tests", version: "1.0.0" }, options);
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name).sort();
}

describe.sequential("protocol eras over stdio", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "mcp-lead-crm-protocol-"));
    modern = await connect({ versionNegotiation: { mode: { pin: "2026-07-28" } } });
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await rm(root, { recursive: true, force: true });
  });

  test("a client pinned to 2026-07-28 connects without a legacy fallback", async () => {
    expect(modern.getProtocolEra()).toBe("modern");
    expect(await toolNames(modern)).toEqual(TOOL_NAMES);
    const result = await modern.callTool({ name: "add_lead", arguments: { name: "Era Test" } });
    expect(result.isError).not.toBe(true);
  });

  test("a client negotiating automatically lands on the modern era", async () => {
    const client = await connect({ versionNegotiation: { mode: "auto" } });
    expect(client.getProtocolEra()).toBe("modern");
    expect(await toolNames(client)).toEqual(TOOL_NAMES);
  });

  test("the v2 client using the legacy initialize handshake is still served", async () => {
    const client = await connect();
    expect(client.getProtocolEra()).toBe("legacy");
    expect(await toolNames(client)).toEqual(TOOL_NAMES);
  });

  test("a pinned modern client reads pipeline and lead resources", async () => {
    const summary = await modern.readResource({ uri: "crm://pipeline/summary" });
    expect(summary.contents).toMatchObject([{
      uri: "crm://pipeline/summary",
      mimeType: "application/json",
      text: expect.stringContaining('"new": 1'),
    }]);
    const lead = await modern.readResource({ uri: "crm://lead/L-0001" });
    expect(lead.contents).toMatchObject([{
      uri: "crm://lead/L-0001",
      mimeType: "application/json",
      text: expect.stringContaining('"name": "Era Test"'),
    }]);
  });

  test("a pinned modern client renders daily_followup_briefing from live data", async () => {
    const result = await modern.callTool({
      name: "log_activity",
      arguments: { id: "L-0001", type: "task", note: "Modern briefing task", due_at: "2020-01-01T00:00:00Z" },
    });
    expect(result.isError).not.toBe(true);
    const prompt = await modern.getPrompt({ name: "daily_followup_briefing" });
    expect(prompt.messages).toMatchObject([{
      role: "user",
      content: { type: "text", text: expect.stringContaining("Modern briefing task") },
    }]);
    expect(prompt.messages[0]?.content).toMatchObject({ text: expect.stringContaining('"new":1') });
  });

  test("a pinned modern client receives isError for invalid tool arguments", async () => {
    const result = await modern.callTool({ name: "qualify_lead", arguments: { id: "L-0001", score: 80 } });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject([{ type: "text", text: expect.stringContaining("reason") }]);
    const lead = await modern.readResource({ uri: "crm://lead/L-0001" });
    expect(lead.contents[0]).toMatchObject({ text: expect.stringContaining('"stage": "new"') });
  });

  test("a pinned modern client receives -32602 for an unknown tool", async () => {
    await expect(modern.callTool({ name: "unknown_tool", arguments: {} })).rejects.toMatchObject({ code: -32602 });
  });

  test.each(["modern", "legacy"])("a %s client receives -32602 for missing leads and unknown resource URIs", async (era) => {
    const client = era === "modern" ? modern : await connect();
    await expect(client.readResource({ uri: "crm://lead/L-9999" })).rejects.toMatchObject({ code: -32602 });
    await expect(client.readResource({ uri: "crm://unknown/resource" })).rejects.toMatchObject({ code: -32602 });
  });
});
