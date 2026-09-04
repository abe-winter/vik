import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import extension from "../src/index";

function schema() {
  return {
    optional() { return this; },
    describe() { return this; },
    int() { return this; },
    positive() { return this; },
    min() { return this; },
    max() { return this; },
  };
}

test("extension registers exactly the approved Vikunja tool surface", () => {
  const tools: Array<{ name: string; approval: string; parameters: unknown }> = [];
  const z = {
    object: (shape: unknown) => ({ shape }),
    array: (_item: unknown) => schema(),
    number: schema,
    string: schema,
    boolean: schema,
    enum: (_values: unknown) => schema(),
  };
  extension({ zod: z, registerTool: (tool: { name: string; approval: string; parameters: unknown }) => tools.push(tool) } as never);
  expect(tools.map(({ name, approval }) => ({ name, approval }))).toEqual([
    { name: "vik_read", approval: "read" },
    { name: "vik_write", approval: "write" },
  ]);
  expect(tools.every((tool) => tool.parameters)).toBe(true);
});

test("OMP loads and registers the extension without a model", async () => {
  const loaded = await createAgentSession({
    additionalExtensionPaths: [resolve(import.meta.dir, "../src/index.ts")],
    cwd: resolve(import.meta.dir, "../.."),
    disableExtensionDiscovery: true,
    enableLsp: false,
    enableMCP: false,
    sessionManager: SessionManager.inMemory(),
  });
  try {
    expect(loaded.extensionsResult.errors).toEqual([]);
    expect(loaded.session.getAllToolNames()).toContain("vik_read");
    expect(loaded.session.getAllToolNames()).toContain("vik_write");
  } finally {
    await loaded.session.dispose();
  }
});
