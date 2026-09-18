import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

let root: string;
let baseUrl: string;
let status = 200;
let received: unknown;
let requests = 0;
let redirected = 0;
let stalled: ((response: ServerResponse) => void) | undefined;
const clients: Client[] = [];
const httpServer = createServer((request, response) => {
  requests++;
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    received = JSON.parse(body);
    if (request.url === "/redirect") {
      response.writeHead(307, { location: `${baseUrl}/redirected?token=secret-token` });
      response.end();
    } else if (request.url === "/stall") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial body");
      stalled?.(response);
    } else {
      if (request.url?.startsWith("/redirected")) redirected++;
      response.writeHead(status, { "content-type": "text/plain" });
      response.end(status === 200 ? "accepted secret-token /private/secret.json" : "unavailable");
    }
  });
});

async function connect(webhookUrl = `${baseUrl}/webhook`, modern = false) {
  const db = join(root, `crm-${clients.length}.json`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js")],
    cwd: process.cwd(),
    env: { ...process.env, LEAD_CRM_DB: db, N8N_WEBHOOK_URL: webhookUrl } as Record<string, string>,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
  const client = new Client({ name: "webhook-tests", version: "1.0.0" }, modern
    ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    : undefined);
  await client.connect(transport);
  clients.push(client);
  return { client, db, diagnostics: () => diagnostics };
}

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
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => { status = 200; });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
  });

  afterAll(async () => {
    httpServer.closeAllConnections();
    await new Promise<void>((done, reject) => httpServer.close((error) => error ? reject(error) : done()));
    await rm(root, { recursive: true, force: true });
  });

  test("posts JSON and records success without echoing the webhook response body", async () => {
    const { client } = await connect();
    await client.callTool({ name: "add_lead", arguments: { name: "Webhook Lead" } });
    const result = await client.callTool({
      name: "trigger_n8n",
      arguments: { event: "lead_qualified", lead_id: "L-0001", payload: { score: 88 } },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(firstText(result))).toEqual({ dry_run: false, status: 200 });
    expect(received).toEqual({ event: "lead_qualified", lead_id: "L-0001", payload: { score: 88 } });
    const resource = await client.readResource({ uri: "crm://lead/L-0001" });
    expect(JSON.parse(resourceText(resource)).activities.at(-1).type).toBe("n8n:trigger");
  });

  test("returns a generic error for a non-2xx webhook and logs the detail to stderr", async () => {
    const { client, diagnostics } = await connect();
    status = 503;
    const result = await client.callTool({ name: "trigger_n8n", arguments: { event: "custom" } });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe("n8n webhook failed");
    await expect.poll(diagnostics).toContain("HTTP 503");
  });

  test("refuses redirects without forwarding the POST or exposing the destination", async () => {
    const { client } = await connect(`${baseUrl}/redirect`);
    const before = requests;
    const result = await client.callTool({ name: "trigger_n8n", arguments: { event: "custom", payload: "secret-payload" } });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe("n8n webhook failed");
    expect(requests).toBe(before + 1);
    expect(redirected).toBe(0);
  });

  test.each(["userinfo", "scheme", "malformed"])("refuses a %s URL without returning paths or secrets", async (kind) => {
    const url = kind === "userinfo" ? baseUrl.replace("http://", "http://user:secret-token@")
      : kind === "scheme" ? "file:///private/secret-token.json"
      : "secret-token /private/secret.json {\"secret\":true}";
    const { client } = await connect(url);
    const before = requests;
    const result = await client.callTool({ name: "trigger_n8n", arguments: { event: "custom" } });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe("n8n webhook failed");
    expect(requests).toBe(before);
  });

  test.each([false, true])("cancels an unfinished webhook response with the request signal (modern=%s)", async (modern) => {
    const { client } = await connect(`${baseUrl}/stall`, modern);
    await client.callTool({ name: "add_lead", arguments: { name: "Cancelled webhook" } });
    let responseClosed!: () => void;
    const closed = new Promise<void>((done) => { responseClosed = done; });
    const received = new Promise<void>((done) => {
      stalled = (response) => { response.on("close", responseClosed); done(); };
    });
    const controller = new AbortController();
    const result = client.callTool({ name: "trigger_n8n", arguments: { event: "custom", lead_id: "L-0001" } }, {
      signal: controller.signal,
    }).catch((error) => error);
    await received;
    controller.abort();
    expect(await result).toBeInstanceOf(Error);
    await closed;
    const resource = await client.readResource({ uri: "crm://lead/L-0001" });
    expect(JSON.parse(resourceText(resource)).activities).toEqual([]);
  });

  test("sanitizes store failures in tools, resources and prompts while retaining stderr detail", async () => {
    const { client, db, diagnostics } = await connect();
    await writeFile(db, '{"secret-token": broken JSON fragment');
    for (const [name, args] of [["list_pipeline", {}], ["add_lead", { name: "Test" }], ["export_csv", { path: "leads.csv" }]] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe("CRM operation failed");
    }
    const imported = await client.callTool({ name: "import_csv", arguments: { path: "../private-secret.csv" } });
    expect(imported.isError).toBe(true);
    expect(firstText(imported)).toBe("CRM operation failed");
    for (const operation of [
      () => client.readResource({ uri: "crm://pipeline/summary" }),
      () => client.readResource({ uri: "crm://lead/L-0001" }),
      () => client.getPrompt({ name: "daily_followup_briefing" }),
    ]) {
      const error = await operation().catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("CRM operation failed");
      expect((error as Error).message).not.toMatch(/secret-token|private|fragment|crm-\d+\.json/);
    }
    await expect.poll(diagnostics).toContain(db);
  });
});
