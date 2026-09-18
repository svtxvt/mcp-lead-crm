import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { JsonStore } from "../src/store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) };
});

const roots: string[] = [];
const run = promisify(execFile);
const csvHeader = "id,name,email,phone,company,source,stage,score,created_at,updated_at,notes\n";

async function temporaryStore(name = "crm.json") {
  const root = await mkdtemp(join(tmpdir(), "mcp-lead-crm-store-"));
  roots.push(root);
  return { root, store: new JsonStore(join(root, name)) };
}

async function expectDatabaseIntact(store: JsonStore, contents: string) {
  expect(await readFile(store.path, "utf8")).toBe(contents);
  expect(await new JsonStore(store.path).listLeads()).toMatchObject([{ name: "Safe Lead" }]);
}

async function addFromTwoProcesses(path: string): Promise<string[]> {
  const source = `
    import { JsonStore } from ${JSON.stringify(resolve("dist/store.js"))};
    const store = new JsonStore(process.argv[1]);
    const ids = [];
    for (let index = 0; index < 100; index += 1) {
      ids.push((await store.addLead({ name: process.pid + ":" + index })).id);
    }
    console.log(JSON.stringify(ids));
  `;
  const results = await Promise.all(Array.from({ length: 2 }, () => run(process.execPath, ["--input-type=module", "--eval", source, path])));
  return results.flatMap(({ stdout }) => JSON.parse(stdout) as string[]);
}

afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(fs.writeFile).mockReset().mockImplementation(actual.writeFile);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("JsonStore", () => {
  test("serializes concurrent atomic writes and assigns unique IDs", async () => {
    const { root, store } = await temporaryStore();
    const leads = await Promise.all(Array.from({ length: 12 }, (_, index) => store.addLead({ name: `Lead ${index}` })));

    expect(new Set(leads.map((lead) => lead.id)).size).toBe(12);
    expect((await store.listLeads(undefined, 20))).toHaveLength(12);
    expect(await readdir(root)).toEqual(["crm.json"]);
  });

  test("persists all 200 acknowledged writes from two processes", async () => {
    const { store } = await temporaryStore();
    const ids = await addFromTwoProcesses(store.path);
    const leads = await store.listLeads(undefined, 300);
    expect(ids).toHaveLength(200);
    expect(new Set(ids).size).toBe(200);
    expect(leads).toHaveLength(200);
    expect(new Set(leads.map((lead) => lead.id))).toEqual(new Set(ids));
  });

  test("two processes safely reclaim a dead owner's lock", async () => {
    const { root, store } = await temporaryStore();
    const { stdout } = await run(process.execPath, ["--eval", "console.log(process.pid)"]);
    const deadPid = Number(stdout.trim());
    expect(() => process.kill(deadPid, 0)).toThrow();
    await writeFile(`${store.path}.lock`, JSON.stringify({ pid: deadPid }));
    const ids = await addFromTwoProcesses(store.path);
    expect(new Set(ids).size).toBe(200);
    expect(await store.listLeads(undefined, 300)).toHaveLength(200);
    expect(await readdir(root)).toEqual(["crm.json"]);
  });

  test("times out without stealing a live process lock", async () => {
    const { store } = await temporaryStore();
    const lock = JSON.stringify({ pid: process.pid });
    await writeFile(`${store.path}.lock`, lock);
    await expect(store.addLead({ name: "Blocked" })).rejects.toThrow("Timed out waiting");
    expect(await readFile(`${store.path}.lock`, "utf8")).toBe(lock);
    expect(await store.listLeads()).toEqual([]);
  }, 10_000);

  test("round-trips quoted CSV fields", async () => {
    const { root, store } = await temporaryStore("source/crm.json");
    await store.addLead({
      name: "Jamie, Jr.",
      company: 'Quote "Works"',
      notes: "Line one\nLine two",
      source: "referral",
    });
    const csv = join(root, "source/export/leads.csv");
    expect(await store.exportCsv(csv)).toBe(1);

    const imported = new JsonStore(join(root, "source/imported.json"));
    expect(await imported.importCsv(csv)).toEqual({ imported: 1, created: 1, updated: 0 });
    expect(await imported.searchLeads("line two")).toMatchObject([{ name: "Jamie, Jr.", company: 'Quote "Works"' }]);
  });

  test("confines CSV paths to the canonical database directory", async () => {
    const { root, store } = await temporaryStore();
    await store.addLead({ name: "Safe Lead" });
    const contents = await readFile(store.path, "utf8");
    for (const path of [join(root, "..", "escape.csv"), store.path]) {
      await expect(store.exportCsv(path)).rejects.toThrow("CSV path must stay inside");
      await expectDatabaseIntact(store, contents);
    }
    await expect(store.importCsv(store.path)).rejects.toThrow("must not be the CRM database");
  });

  test("reserves database aliases before the first database write", async () => {
    const { root, store } = await temporaryStore();
    await expect(store.exportCsv("CRM.JSON")).rejects.toThrow("must not be the CRM database");
    expect(await readdir(root)).toEqual([]);
    expect((await store.addLead({ name: "Safe Lead" })).id).toBe("L-0001");
  });

  test.for([
    ["caf\u00e9", "cafe\u0301"],
    ["\u03c3", "\u03c2"],
    ["\u017f", "s"],
  ] as const)("rejects filesystem-equivalent %s/%s database and lock aliases before the first write", async ([name, aliasName], context) => {
    const { root, store } = await temporaryStore(`${name}.json`);
    const probe = join(root, `${name}-probe`);
    await writeFile(probe, "probe");
    const identity = await stat(probe);
    const aliasIdentity = await stat(join(root, `${aliasName}-probe`)).catch(() => undefined);
    await rm(probe);
    if (!aliasIdentity || identity.dev !== aliasIdentity.dev || identity.ino !== aliasIdentity.ino) context.skip();
    const aliases = [`${aliasName}.json`, `${aliasName}.json.lock`, `${aliasName}.json.lock.reap`];
    for (const alias of aliases) {
      await expect(store.exportCsv(alias)).rejects.toThrow("must not be the CRM database");
      expect(await readdir(root)).toEqual([]);
      expect(await store.listLeads()).toEqual([]);
    }
    await store.addLead({ name: "Safe Lead" });
    const contents = await readFile(store.path, "utf8");
    for (const alias of aliases) {
      await expect(store.exportCsv(alias)).rejects.toThrow("must not be the CRM database");
      await expectDatabaseIntact(store, contents);
    }
  });

  test("rejects case-insensitive database aliases without damaging the database", async (context) => {
    const { root, store } = await temporaryStore();
    await store.addLead({ name: "Safe Lead" });
    const alias = join(root, "CRM.JSON");
    const identity = await stat(store.path);
    const aliasIdentity = await stat(alias).catch(() => undefined);
    if (!aliasIdentity || identity.dev !== aliasIdentity.dev || identity.ino !== aliasIdentity.ino) context.skip();
    const contents = await readFile(store.path, "utf8");
    await expect(store.exportCsv(alias)).rejects.toThrow("must not be the CRM database");
    await expectDatabaseIntact(store, contents);
    await expect(store.importCsv(alias)).rejects.toThrow("must not be the CRM database");
  });

  test.each(["symlink", "hardlink"] as const)("rejects a %s database alias for import and export", async (kind) => {
    const { root, store } = await temporaryStore();
    await store.addLead({ name: "Safe Lead" });
    const contents = await readFile(store.path, "utf8");
    const alias = join(root, "alias.csv");
    await (kind === "symlink" ? symlink(store.path, alias) : link(store.path, alias));
    await expect(store.exportCsv(alias)).rejects.toThrow("must not be the CRM database");
    await expectDatabaseIntact(store, contents);
    await expect(store.importCsv(alias)).rejects.toThrow("must not be the CRM database");
  });

  test("rejects symlinked destinations even when they target a safe CSV", async () => {
    const { root, store } = await temporaryStore();
    await store.addLead({ name: "Safe Lead" });
    const contents = await readFile(store.path, "utf8");
    const target = join(root, "target.csv");
    await writeFile(target, "keep this");
    await symlink(target, join(root, "alias.csv"));
    await expect(store.exportCsv("alias.csv")).rejects.toThrow("CSV path must stay inside");
    await expectDatabaseIntact(store, contents);
    expect(await readFile(target, "utf8")).toBe("keep this");
  });

  test("rejects file and directory symlinks escaping the database directory", async () => {
    const { root, store } = await temporaryStore("data/crm.json");
    await store.addLead({ name: "Safe Lead" });
    const contents = await readFile(store.path, "utf8");
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside/leads.csv"), "keep this");
    await symlink(join(root, "outside"), join(root, "data/escape"));
    await symlink(join(root, "outside/leads.csv"), join(root, "data/escape.csv"));
    for (const path of ["escape/leads.csv", "escape/new/nested.csv", "escape.csv"]) {
      await expect(store.exportCsv(path)).rejects.toThrow("CSV path must stay inside");
      await expectDatabaseIntact(store, contents);
    }
    for (const path of ["escape/leads.csv", "escape.csv"]) {
      await expect(store.importCsv(path)).rejects.toThrow("CSV path must stay inside");
    }
    expect(await readdir(join(root, "outside"))).toEqual(["leads.csv"]);
    expect(await readFile(join(root, "outside/leads.csv"), "utf8")).toBe("keep this");
  });

  test("protects lock destinations and hardlinked lock aliases from CSV export", async () => {
    const { root, store } = await temporaryStore();
    await store.addLead({ name: "Safe Lead" });
    const contents = await readFile(store.path, "utf8");
    for (const path of ["crm.json.lock", "crm.json.lock.reap", "CRM.JSON.LOCK.REAP"]) {
      await expect(store.exportCsv(path)).rejects.toThrow("lock files");
      await expectDatabaseIntact(store, contents);
    }
    const { writeFile: originalWriteFile } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const alias = join(root, "lock-alias.csv");
    vi.mocked(fs.writeFile).mockImplementation(async (...args) => {
      if (String(args[0]).includes("lock-alias.csv.")) await link(`${store.path}.lock`, alias);
      return originalWriteFile(...args);
    });
    await expect(store.exportCsv(alias)).rejects.toThrow("lock files");
    await expectDatabaseIntact(store, contents);
  });

  test("rolls back an import with a malformed later row and preserves the next ID", async () => {
    const { root, store } = await temporaryStore();
    await store.addLead({ name: "Safe Lead" });
    const contents = await readFile(store.path, "utf8");
    await writeFile(join(root, "invalid.csv"), `${csvHeader},Valid,,,,,new,,,,\n,Invalid,,,,,unknown,,,,\n`);
    await expect(store.importCsv("invalid.csv")).rejects.toThrow();
    await expectDatabaseIntact(store, contents);
    expect((await store.addLead({ name: "Next Lead" })).id).toBe("L-0002");
  });

  test("rolls back an unterminated quoted CSV import", async () => {
    const { root, store } = await temporaryStore();
    await store.addLead({ name: "Safe Lead" });
    const contents = await readFile(store.path, "utf8");
    await writeFile(join(root, "invalid.csv"), `${csvHeader},"Unterminated`);
    await expect(store.importCsv("invalid.csv")).rejects.toThrow("unterminated");
    await expectDatabaseIntact(store, contents);
  });

  test("keeps the previous export and database readable if publishing an export fails", async () => {
    const { root, store } = await temporaryStore();
    await store.addLead({ name: "Safe Lead" });
    const contents = await readFile(store.path, "utf8");
    const output = join(root, "leads.csv");
    await writeFile(output, "previous export");
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("Injected rename failure"));
    await expect(store.exportCsv(output)).rejects.toThrow("Injected rename failure");
    expect(await readFile(output, "utf8")).toBe("previous export");
    await expectDatabaseIntact(store, contents);
    expect(await readdir(root)).toEqual(["crm.json", "leads.csv"]);
  });

  test("releases the lock after a failed database publish and drains queued writes", async () => {
    const { root, store } = await temporaryStore();
    await store.addLead({ name: "Safe Lead" });
    const contents = await readFile(store.path, "utf8");
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("Injected rename failure"));
    await expect(store.addLead({ name: "Failed" })).rejects.toThrow("Injected rename failure");
    await expectDatabaseIntact(store, contents);
    const pending = store.addLead({ name: "Next Lead" });
    await store.drain();
    expect((await pending).id).toBe("L-0002");
    expect(await new JsonStore(store.path).listLeads()).toHaveLength(2);
    expect(await readdir(root)).toEqual(["crm.json"]);
  });
});
