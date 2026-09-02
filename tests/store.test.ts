import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { JsonStore } from "../src/store.js";

const roots: string[] = [];

async function temporaryStore(name = "crm.json") {
  const root = await mkdtemp(join(tmpdir(), "mcp-lead-crm-store-"));
  roots.push(root);
  return { root, store: new JsonStore(join(root, name)) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("JsonStore", () => {
  test("serializes concurrent atomic writes and assigns unique IDs", async () => {
    const { root, store } = await temporaryStore();
    const leads = await Promise.all(Array.from({ length: 12 }, (_, index) => store.addLead({ name: `Lead ${index}` })));

    expect(new Set(leads.map((lead) => lead.id)).size).toBe(12);
    expect((await store.listLeads(undefined, 20))).toHaveLength(12);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

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

  test("confines CSV paths to the database directory", async () => {
    const { root, store } = await temporaryStore();
    await store.addLead({ name: "Safe Lead" });
    await expect(store.exportCsv(join(root, "..", "escape.csv"))).rejects.toThrow("CSV path must stay inside");
    await expect(store.exportCsv(join(root, "crm.json"))).rejects.toThrow("must not be the CRM database");
  });
});
