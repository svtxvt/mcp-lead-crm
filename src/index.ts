#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer, storeFromEnvironment } from "./server.js";

// One store for the process; serveStdio calls the factory once per connection and
// pins the resulting server instance to it (2026-07-28 or legacy era, whichever the
// client opens with).
const store = storeFromEnvironment();

const handle = serveStdio(() => createServer(store));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
}
