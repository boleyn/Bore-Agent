import fs from "fs";
import path from "path";
import type { SkillDetail, SkillListItem } from "@/types/skill";

const DATA_DIR = process.env.AISTUDIO_CUSTOMIZATION_DIR?.trim() || path.join(process.cwd(), "data");
const SKILLS_STATE_FILE = path.join(DATA_DIR, "skills.json");
const WORKSPACE_SKILLS_DIR = path.join(process.cwd(), "skills");

export type ManagedSkillItem = SkillListItem & {
  enabled: boolean;
  category: "builtin" | "custom";
};

export type ManagedSkillDetail = ManagedSkillItem & SkillDetail;

type StoredSkillRecord = {
  token: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  sourceType: "custom" | "template";
  templateKey?: string;
  createdAt: string;
  updatedAt: string;
};

function parseSkillFrontmatter(raw: string, fallbackName: string): { name: string; description: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) {
    return { name: fallbackName, description: "内置技能模块" };
  }
  const frontmatter = match[1];
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : fallbackName,
    description: descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, "") : "内置技能模块",
  };
}

function readBuiltinSkills(): ManagedSkillDetail[] {
  if (!fs.existsSync(WORKSPACE_SKILLS_DIR)) return [];
  const entries = fs.readdirSync(WORKSPACE_SKILLS_DIR, { withFileTypes: true });
  const results: ManagedSkillDetail[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(WORKSPACE_SKILLS_DIR, entry.name);
    const skillMdPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;
    const content = fs.readFileSync(skillMdPath, "utf8");
    const { name, description } = parseSkillFrontmatter(content, entry.name);
    const stat = fs.statSync(skillMdPath);
    const dirFiles = fs.readdirSync(skillDir);

    results.push({
      token: entry.name,
      name,
      description,
      sourceType: "template",
      templateKey: entry.name,
      category: "builtin",
      enabled: true,
      fileCount: dirFiles.length,
      content,
      createdAt: stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
    });
  }
  return results;
}

function readStoredState(): {
  disabledTokens: string[];
  customSkills: StoredSkillRecord[];
} {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(SKILLS_STATE_FILE)) {
    const initial = { disabledTokens: [], customSkills: [] };
    fs.writeFileSync(SKILLS_STATE_FILE, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(SKILLS_STATE_FILE, "utf8"));
    return {
      disabledTokens: Array.isArray(parsed.disabledTokens) ? parsed.disabledTokens : [],
      customSkills: Array.isArray(parsed.customSkills) ? parsed.customSkills : [],
    };
  } catch {
    return { disabledTokens: [], customSkills: [] };
  }
}

function saveStoredState(state: { disabledTokens: string[]; customSkills: StoredSkillRecord[] }) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(SKILLS_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

export function getDisabledBuiltinSkillTokens(): ReadonlySet<string> {
  return new Set(readStoredState().disabledTokens);
}

export function getSelectedBuiltinSkills(names: readonly string[]) {
  if (names.length === 0) return [];
  const requested = new Set(names.map((name) => name.trim().toLowerCase()));
  const disabled = getDisabledBuiltinSkillTokens();
  return readBuiltinSkills().flatMap((skill) => {
    if (disabled.has(skill.token) || !requested.has(skill.name.toLowerCase())) return [];
    const directory = path.join(WORKSPACE_SKILLS_DIR, skill.token);
    const resources: Record<string, string> = {};
    for (const folder of ["references", "scripts", "agents"]) {
      const root = path.join(directory, folder);
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.(md|txt|json|yaml|yml|py|sh|js|ts)$/i.test(entry.name)) continue;
        const location = path.join(root, entry.name);
        if (fs.statSync(location).size <= 128 * 1024) {
          resources[`${folder}/${entry.name}`] = fs.readFileSync(location, "utf8");
        }
      }
    }
    return [{
      name: skill.name,
      description: skill.description,
      content: skill.content,
      path: `builtin:${skill.token}/SKILL.md`,
      resources,
    }];
  });
}

export function getSelectedCustomSkills(names: readonly string[]) {
  if (names.length === 0) return [];
  const requested = new Set(names.map((name) => name.trim().toLowerCase()));
  const selected = new Map<string, StoredSkillRecord>();
  for (const skill of readStoredState().customSkills) {
    const name = skill.name.toLowerCase();
    if (skill.enabled && requested.has(name) && !selected.has(name)) selected.set(name, skill);
  }
  return Array.from(selected.values(), ({ token, name, description, content }) => ({
    name,
    description,
    content,
    path: `managed:${token}/SKILL.md`,
  }));
}

export function listManagedSkills(): ManagedSkillItem[] {
  const state = readStoredState();
  const disabledSet = new Set(state.disabledTokens);
  const builtins: ManagedSkillItem[] = readBuiltinSkills().map(({ content: _c, files: _f, ...rest }) => ({
    ...rest,
    enabled: !disabledSet.has(rest.token),
  }));

  const customs: ManagedSkillItem[] = state.customSkills.map((s) => ({
    token: s.token,
    name: s.name,
    description: s.description,
    sourceType: s.sourceType,
    templateKey: s.templateKey,
    category: "custom",
    enabled: s.enabled,
    fileCount: 1,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }));

  return [...customs, ...builtins];
}

export function getManagedSkillDetail(token: string): ManagedSkillDetail | null {
  const state = readStoredState();
  const custom = state.customSkills.find((s) => s.token === token);
  if (custom) {
    return {
      token: custom.token,
      name: custom.name,
      description: custom.description,
      sourceType: custom.sourceType,
      templateKey: custom.templateKey,
      category: "custom",
      enabled: custom.enabled,
      fileCount: 1,
      content: custom.content,
      createdAt: custom.createdAt,
      updatedAt: custom.updatedAt,
    };
  }

  const builtin = readBuiltinSkills().find((s) => s.token === token);
  if (!builtin) return null;
  return {
    ...builtin,
    enabled: !state.disabledTokens.includes(builtin.token),
  };
}

export function createCustomSkill(input: {
  name: string;
  description: string;
  content: string;
  templateKey?: string;
}): ManagedSkillDetail {
  const state = readStoredState();
  const now = new Date().toISOString();
  const slug = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const token = `skill-${slug || "custom"}-${Date.now().toString(36)}`;
  const record: StoredSkillRecord = {
    token,
    name: input.name.trim(),
    description: input.description.trim() || "自定义技能指令",
    content: input.content,
    enabled: true,
    sourceType: input.templateKey ? "template" : "custom",
    templateKey: input.templateKey,
    createdAt: now,
    updatedAt: now,
  };
  state.customSkills.unshift(record);
  saveStoredState(state);
  return {
    ...record,
    category: "custom",
    fileCount: 1,
  };
}

export function updateManagedSkill(
  token: string,
  patch: Partial<Pick<StoredSkillRecord, "name" | "description" | "content" | "enabled">>,
): ManagedSkillDetail | null {
  const state = readStoredState();
  const customIdx = state.customSkills.findIndex((s) => s.token === token);
  if (customIdx !== -1) {
    const current = state.customSkills[customIdx];
    const next: StoredSkillRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    state.customSkills[customIdx] = next;
    saveStoredState(state);
    return {
      ...next,
      category: "custom",
      fileCount: 1,
    };
  }

  const builtin = readBuiltinSkills().find((s) => s.token === token);
  if (!builtin) return null;
  if (typeof patch.enabled === "boolean") {
    const set = new Set(state.disabledTokens);
    if (patch.enabled) {
      set.delete(token);
    } else {
      set.add(token);
    }
    state.disabledTokens = Array.from(set);
    saveStoredState(state);
  }
  return {
    ...builtin,
    enabled: !state.disabledTokens.includes(token),
  };
}

export function deleteCustomSkill(token: string): boolean {
  const state = readStoredState();
  const exists = state.customSkills.some((s) => s.token === token);
  if (!exists) return false;
  state.customSkills = state.customSkills.filter((s) => s.token !== token);
  saveStoredState(state);
  return true;
}
