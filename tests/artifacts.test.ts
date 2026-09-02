import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("shipped artifacts", () => {
  test("n8n workflow is credential-free and outbound-free by default", async () => {
    const workflow = JSON.parse(await readFile("examples/n8n-followup-email.json", "utf8"));
    expect(workflow.active).toBe(false);
    expect(workflow.nodes.map((node: { type: string }) => node.type)).toEqual([
      "n8n-nodes-base.webhook",
      "n8n-nodes-base.if",
      "n8n-nodes-base.set",
      "n8n-nodes-base.noOp",
    ]);
    expect(workflow.nodes.at(-1)).toMatchObject({ disabled: true, name: "Email placeholder (disabled)" });
    expect(JSON.stringify(workflow)).not.toContain('"credentials"');
    expect(JSON.stringify(workflow)).not.toMatch(/https?:\/\//);
  });
});
