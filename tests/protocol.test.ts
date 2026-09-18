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
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await rm(root, { recursive: true, force: true });
  });

  test("a client pinned to 2026-07-28 connects without a legacy fallback", async () => {
    const client = await connect({ versionNegotiation: { mode: { pin: "2026-07-28" } } });
    expect(client.getProtocolEra()).toBe("modern");
    expect(await toolNames(client)).toEqual(TOOL_NAMES);
    const result = await client.callTool({ name: "add_lead", arguments: { name: "Era Test" } });
    expect(result.isError).not.toBe(true);
  });

  test("a client negotiating automatically lands on the modern era", async () => {
    const client = await connect({ versionNegotiation: { mode: "auto" } });
    expect(client.getProtocolEra()).toBe("modern");
    expect(await toolNames(client)).toEqual(TOOL_NAMES);
  });

  test("a 2025-era client using the initialize handshake is still served", async () => {
    const client = await connect();
    expect(client.getProtocolEra()).toBe("legacy");
    expect(await toolNames(client)).toEqual(TOOL_NAMES);
  });
});
