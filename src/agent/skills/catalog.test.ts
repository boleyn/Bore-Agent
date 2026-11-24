import { test, expect } from "bun:test";
import { createSkillCatalog } from "./catalog";
import type { Sandbox } from "../sandbox";
import { SkillTool } from "../tools/builtin/skillTool";
import type { ToolContext } from "../tools/types";

test("plugin skills disclose reference names without their bodies, then read selected lines", async () => {
  const sandbox = { fs: { readdir: async () => [] } } as unknown as Sandbox;
  const catalog = createSkillCatalog(sandbox, [{ name: "finance:invoice", description: "Invoices", path: "plugin:finance/invoice/SKILL.md", content: "Invoice instructions", tools: ["invoice_lookup"], resources: { "tax.json": "secret first line\nsecond line" } }]);
  const loaded = await catalog.load("finance:invoice");
  expect(loaded?.references).toEqual(["tax.json"]);
  expect(loaded?.content).not.toContain("secret");
  const ctx = { sandbox, skills: catalog } as ToolContext;
  const result = await SkillTool.handler({ skill: "finance:invoice", resource: "tax.json", offset: 2, limit: 1 }, ctx);
  expect(result.content).toContain("2: second line");
  expect(result.content).not.toContain("secret");
  expect(catalog.readReference!("finance:invoice", "../private")).rejects.toThrow("Invalid");
});

test("selected managed skills load their content and preserve existing plugin skills", async () => {
  const sandbox = { fs: { readdir: async () => [] } } as unknown as Sandbox;
  const catalog = createSkillCatalog(
    sandbox,
    [{ name: "existing", description: "Plugin", path: "plugin:existing/SKILL.md", content: "Plugin content" }],
    [
      { name: "会议摘要", description: "Managed", path: "managed:summary/SKILL.md", content: "Summarize decisions" },
      { name: "existing", description: "Managed", path: "managed:existing/SKILL.md", content: "Managed content" },
    ],
  );
  expect((await catalog.load("会议摘要"))?.content).toBe("Summarize decisions");
  expect((await catalog.load("existing"))?.content).toBe("Plugin content");
});

test("excluded built-in paths cannot be loaded from a persistent workspace", async () => {
  const sandbox = {
    fs: {
      readdir: async (path: string) => path === "/skills"
        ? [{ type: "directory", path: "/skills/disabled", name: "disabled" }]
        : [],
      readText: async () => "---\nname: disabled\ndescription: Built-in fixture\n---\nInstructions",
    },
  } as unknown as Sandbox;
  const catalog = createSkillCatalog(sandbox, [], [], new Set(["/skills/disabled/SKILL.md"]));
  expect(await catalog.list()).toEqual([]);
  expect(await catalog.load("disabled")).toBeUndefined();
});

test("cloud projects can load enabled bundled skills without scanning legacy directories", async () => {
  const visited: string[] = [];
  const sandbox = { fs: {
    readdir: async (directory: string) => {
      visited.push(directory);
      throw new Error("Project does not have a skills directory");
    },
  } } as unknown as Sandbox;
  const catalog = createSkillCatalog(sandbox, [], [{
    name: "plugin-creator",
    description: "Build a plugin",
    path: "builtin:plugin-creator/SKILL.md",
    content: "Plugin creator instructions",
  }]);

  expect((await catalog.list()).map(skill => skill.name)).toEqual(["plugin-creator"]);
  expect((await catalog.load("plugin-creator"))?.content).toBe("Plugin creator instructions");
  expect(new Set(visited)).toEqual(new Set(["/skills"]));
});
