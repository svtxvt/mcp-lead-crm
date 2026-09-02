#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, storeFromEnvironment } from "./server.js";

const server = createServer(storeFromEnvironment());

try {
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error("mcp-lead-crm failed:", error);
  process.exitCode = 1;
}
