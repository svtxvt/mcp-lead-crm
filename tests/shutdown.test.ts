import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

let root: string;
let client: Client;
let transport: StdioClientTransport;
let httpServer: Server;
let accepted: Promise<ServerResponse>;
let stopping: Promise<void>;
let closed: Promise<void>;
let diagnostics: string;

describe.sequential("process shutdown", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mcp-lead-crm-shutdown-"));
    accepted = new Promise<ServerResponse>((done) => {
      httpServer = createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          response.writeHead(200);
          response.write("pending");
          done(response);
        });
      });
    });
    await new Promise<void>((done) => httpServer.listen(0, "127.0.0.1", done));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/index.js")],
      env: {
        ...process.env,
        LEAD_CRM_DB: join(root, "crm.json"),
        N8N_WEBHOOK_URL: `http://127.0.0.1:${address.port}/webhook`,
      } as Record<string, string>,
      stderr: "pipe",
    });
    diagnostics = "";
    stopping = new Promise<void>((done) => {
      transport.stderr?.on("data", (chunk) => {
        diagnostics += String(chunk);
        if (diagnostics.includes("Shutting down;")) done();
      });
    });
    client = new Client({ name: "shutdown-tests", version: "1.0.0" });
    await client.connect(transport);
    closed = new Promise<void>((done) => { client.onclose = done; });
    await client.callTool({ name: "add_lead", arguments: { name: "Pending webhook" } });
  });

  afterEach(async () => {
    httpServer.closeAllConnections();
    await client.close();
    await new Promise<void>((done, reject) => httpServer.close((error) => error ? reject(error) : done()));
    await rm(root, { recursive: true, force: true });
  });

  test.each(["SIGINT", "SIGTERM"] as const)("%s drains the started webhook and activity write, and stops accepting tools", async (signal) => {
    const request = client.callTool({ name: "trigger_n8n", arguments: { event: "custom", lead_id: "L-0001" } }).catch(() => undefined);
    const response = await accepted;
    process.kill(transport.pid!, signal);
    await stopping;
    const late = client.callTool({ name: "add_lead", arguments: { name: "After shutdown" } }).catch(() => undefined);
    response.end("completed");
    await closed;
    await Promise.all([request, late]);
    const db = JSON.parse(await readFile(join(root, "crm.json"), "utf8"));
    expect(db.leads).toHaveLength(1);
    expect(db.leads[0].activities.at(-1).type).toBe("n8n:trigger");
  });

  test("forces exit at the five-second shutdown deadline when a webhook body stalls", async () => {
    const request = client.callTool({ name: "trigger_n8n", arguments: { event: "custom", lead_id: "L-0001" } }).catch(() => undefined);
    await accepted;
    process.kill(transport.pid!, "SIGTERM");
    await stopping;
    await closed;
    await request;
    const db = JSON.parse(await readFile(join(root, "crm.json"), "utf8"));
    expect(db.leads[0].activities).toEqual([]);
    expect(diagnostics).toContain("Shutdown deadline reached");
  }, 9_000);
});
