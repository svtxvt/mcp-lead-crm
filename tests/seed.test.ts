import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const run = promisify(execFile);
let root = "";

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("seed command", () => {
  test("seeds an empty CRM and refuses to replace it silently", async () => {
    root = await mkdtemp(join(tmpdir(), "mcp-lead-crm-seed-"));
    const env = { ...process.env, LEAD_CRM_DB: join(root, "crm.json"), LEAD_CRM_SEED_FORCE: "" };
    await expect(run("npm", ["run", "seed"], { cwd: process.cwd(), env })).resolves.toMatchObject({
      stdout: expect.stringContaining("Seeded 12 fictional leads"),
    });
    await expect(run("npm", ["run", "seed"], { cwd: process.cwd(), env })).rejects.toMatchObject({
      stderr: expect.stringContaining("Refusing to replace a non-empty CRM"),
    });
  });
});
