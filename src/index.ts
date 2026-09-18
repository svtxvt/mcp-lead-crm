#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer, storeFromEnvironment } from "./server.js";

// All connections and protocol eras share the same store.
const store = storeFromEnvironment();
const servers = new Set<ReturnType<typeof createServer>>();
const handle = serveStdio(() => {
  const server = createServer(store);
  servers.add(server);
  return server;
});
let stopping = false;

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  process.stdin.pause();
  for (const server of servers) server.stop();
  console.error("Shutting down; waiting up to 5 seconds for active operations.");
  const timer = setTimeout(() => {
    console.error("Shutdown deadline reached; closing active operations.");
    void handle.close();
    process.exit(0);
  }, 5_000);
  try {
    await Promise.all([...servers].map((server) => server.drain()));
    await store.drain();
    await handle.close();
  } catch (error) {
    console.error("Shutdown failed", error);
  } finally {
    clearTimeout(timer);
    process.exit(0);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void shutdown(); });
}
