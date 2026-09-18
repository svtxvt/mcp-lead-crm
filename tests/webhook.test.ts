import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

let root: string;
let client: Client;
let transport: StdioClientTransport;
let status = 200;
let received: unknown;
const httpServer = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    received = JSON.parse(body);
    response.writeHead(status, { "content-type": "text/plain" });
    response.end(status === 200 ? "accepted" : "unavailable");
  });
});

function resourceText(resource: Awaited<ReturnType<Client["readResource"]>>): string {
  const value = (resource.contents[0] as { text?: unknown } | undefined)?.text;
  if (typeof value !== "string") throw new Error("Expected text resource content");
  return value;
}

function firstText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content[0];
  if (!content || content.type !== "text") throw new Error("Expected text content");
  return content.text;
}

describe.sequential("live n8n webhook branch", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "mcp-lead-crm-webhook-"));
    await new Promise<void>((done) => httpServer.listen(0, "127.0.0.1", done));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/index.js")],
      cwd: process.cwd(),
      env: {
        ...process.env,
        LEAD_CRM_DB: join(root, "crm.json"),
        N8N_WEBHOOK_URL: `http://127.0.0.1:${address.port}/webhook`,
      } as Record<string, string>,
      stderr: "pipe",
    });
    client = new Client({ name: "webhook-tests", version: "1.0.0" });
    await client.connect(transport);
    await client.callTool({ name: "add_lead", arguments: { name: "Webhook Lead" } });
  });

  afterAll(async () => {
    await client.close();
    await new Promise<void>((done, reject) => httpServer.close((error) => error ? reject(error) : done()));
    await rm(root, { recursive: true, force: true });
  });

  test("posts JSON and records a successful n8n activity", async () => {
    const result = await client.callTool({
      name: "trigger_n8n",
      arguments: { event: "lead_qualified", lead_id: "L-0001", payload: { score: 88 } },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(firstText(result))).toEqual({ dry_run: false, status: 200, response: "accepted" });
    expect(received).toEqual({ event: "lead_qualified", lead_id: "L-0001", payload: { score: 88 } });

    const resource = await client.readResource({ uri: "crm://lead/L-0001" });
    expect(JSON.parse(resourceText(resource)).activities.at(-1).type).toBe("n8n:trigger");
  });

  test("returns a clear tool error for a non-2xx webhook", async () => {
    status = 503;
    const result = await client.callTool({ name: "trigger_n8n", arguments: { event: "custom" } });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("n8n webhook failed: HTTP 503");
  });
});
