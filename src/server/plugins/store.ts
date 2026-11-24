import { randomUUID } from "node:crypto";
import type { McpServerConfig } from "@/agent/mcp";
import { isImportedMcpUrl } from "@/agent/mcp/importedTransport";
import fs from "fs";
import path from "path";
import type { CreateCustomPluginInput, PluginItem } from "@/types/plugin";

const DATA_DIR = process.env.AISTUDIO_CUSTOMIZATION_DIR?.trim() || path.join(process.cwd(), "data");
const PLUGINS_FILE = path.join(DATA_DIR, "plugins.json");

type StoredPlugin = PluginItem & { ownerId?: string };

const BUILTIN_PLUGINS: PluginItem[] = [
  {
    id: "builtin-web",
    name: "Web Search & Fetch",
    description: "实时联网检索与网页内容提取工具集",
    longDescription: "平台内置的联网搜索与网页正文抓取工具，支持实时信息查证。",
    category: "builtin",
    kind: "builtin",
    iconKey: "web",
    iconBg: "#EFF6FF",
    iconText: "WEB",
    iconColor: "#2563EB",
    author: "AI Studio 内置",
    version: "1.0.0",
    capabilities: ["WebSearch 实时搜索", "WebFetch 网页正文提取"],
    isPublic: true,
    installed: true,
    enabled: true,
    installedAt: "2026-11-01T00:00:00.000Z",
  },
  {
    id: "builtin-site",
    name: "Site Builder & Hosting",
    description: "静态站点构建、发布与运行状态诊断插件",
    longDescription: "平台内置的站点工具插件（site-connections），用于构建与发布静态站点。",
    category: "builtin",
    kind: "builtin",
    iconKey: "site",
    iconBg: "#ECFDF5",
    iconText: "SITE",
    iconColor: "#059669",
    author: "AI Studio 内置",
    version: "1.0.0",
    capabilities: ["get_site_status 诊断", "publish_site 一键发布", "站点数据库与域名管理"],
    isPublic: true,
    installed: true,
    enabled: true,
    installedAt: "2026-11-01T00:00:00.000Z",
  },
];

function readCustomPlugins(): StoredPlugin[] {
  if (!fs.existsSync(PLUGINS_FILE)) return [];
  const entries: StoredPlugin[] = JSON.parse(fs.readFileSync(PLUGINS_FILE, "utf8"));
  return entries.filter((entry) => entry?.isCustom === true);
}

function savePlugins(items: StoredPlugin[]) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(PLUGINS_FILE, JSON.stringify(items, null, 2), "utf8");
}

/** Keep stored credentials on the server; the editor accepts replacements. */
export function toPluginView(plugin: PluginItem): PluginItem {
  const visibleFields = new Set(
    (plugin.configSchema ?? []).filter((field) => field.type !== "password").map((field) => field.key)
  );
  const { ownerId: _ownerId, ...view } = plugin as StoredPlugin;
  return {
    ...view,
    configValues: Object.fromEntries(
      Object.entries(plugin.configValues ?? {}).filter(([key]) => visibleFields.has(key))
    ),
  };
}

export function listPlugins(ownerId?: string): StoredPlugin[] {
  const owned = ownerId ? readCustomPlugins().filter((plugin) => plugin.ownerId === ownerId) : [];
  return [...owned, ...BUILTIN_PLUGINS];
}

export function listImportedMcpConfigs(ownerId?: string): McpServerConfig[] {
  if (!ownerId) return [];
  return listPlugins(ownerId).flatMap((plugin): McpServerConfig[] => {
    if (!plugin.isCustom || plugin.kind !== "mcp" || !plugin.installed || !plugin.enabled) return [];
    const url = String(plugin.configValues?.endpointUrl || plugin.endpointUrl || "").trim();
    if (!isImportedMcpUrl(url)) return [];
    const token = String(plugin.configValues?.apiKey ?? "").trim();
    return [{
      name: plugin.id,
      transport: "http",
      url,
      userImported: true,
      ...(token ? { headers: { Authorization: /^Bearer /i.test(token) ? token : `Bearer ${token}` } } : {}),
    }];
  });
}

export function getPluginById(id: string, ownerId: string): PluginItem | undefined {
  return listPlugins(ownerId).find((plugin) => plugin.id === id);
}

export function updatePlugin(
  id: string,
  ownerId: string,
  patch: Partial<Pick<PluginItem, "installed" | "enabled" | "configValues" | "name" | "description" | "endpointUrl">>,
): PluginItem | null {
  const items = readCustomPlugins();
  const idx = items.findIndex((p) => p.id === id && p.ownerId === ownerId);
  if (idx === -1) return null;

  const current = items[idx];
  const now = new Date().toISOString();
  const next: StoredPlugin = {
    ...current,
    ...patch,
    ...(patch.configValues ? {
      configValues: {
        ...current.configValues,
        ...Object.fromEntries((current.configSchema ?? []).flatMap<[string, string | boolean]>(({ key, type }) => {
          const value = patch.configValues?.[key];
          if (type === "boolean") return typeof value === "boolean" ? [[key, value]] : [];
          return typeof value === "string" && (type !== "password" || value.trim()) ? [[key, value]] : [];
        })),
      },
    } : {}),
    updatedAt: now,
    installedAt:
      patch.installed === true && !current.installed ? now : patch.installed === false ? undefined : current.installedAt,
  };
  if (patch.installed === false) {
    next.enabled = false;
  }
  items[idx] = next;
  savePlugins(items);
  return next;
}

export function createCustomPlugin(input: CreateCustomPluginInput, ownerId: string): PluginItem {
  const items = readCustomPlugins();
  const now = new Date().toISOString();
  const kind = input.kind || "mcp";
  const slug = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const id = `custom-${slug || "plugin"}-${randomUUID().slice(0, 8)}`;
  const newPlugin: StoredPlugin = {
    id,
    ownerId,
    name: input.name.trim(),
    description: input.description.trim() || (kind === "mcp" ? "自定义 MCP 服务" : kind === "api" ? "自定义 REST API / Webhook" : "自定义连接器"),
    longDescription: input.description.trim() || "用户自定义的扩展插件连接。",
    category: input.category || "custom",
    kind,
    ...(input.iconDataUrl ? { iconDataUrl: input.iconDataUrl } : {}),
    iconKey: kind === "mcp" ? "mcp" : "api",
    iconBg: kind === "mcp" ? "#111827" : "#2563EB",
    iconText: input.name.trim().slice(0, 2).toUpperCase() || "PL",
    iconColor: "#FFFFFF",
    author: input.author?.trim() || "Custom",
    version: "1.0.0",
    capabilities:
      kind === "mcp"
        ? ["MCP 工具发现与调用", "上下文资源读取"]
        : ["HTTP API / Webhook 调用", "自定义鉴权头"],
    isPublic: false,
    installed: true,
    enabled: true,
    isCustom: true,
    endpointUrl: input.endpointUrl?.trim() || "",
    configSchema:
      kind === "mcp"
        ? [
            { key: "endpointUrl", label: "MCP 服务器 HTTPS URL (Streamable HTTP)", type: "url", placeholder: "https://example.com/mcp" },
            { key: "apiKey", label: "Bearer Token / API Key", type: "password", placeholder: "sk-..." },
          ]
        : [
            { key: "endpointUrl", label: "API Base URL / Webhook URL", type: "url", placeholder: "https://api.example.com/v1" },
            { key: "apiKey", label: "Authorization / API Key", type: "password", placeholder: "Bearer ..." },
          ],
    configValues: {
      endpointUrl: input.endpointUrl?.trim() || "",
      ...(input.authHeader ? { apiKey: input.authHeader } : {}),
    },
    installedAt: now,
    updatedAt: now,
  };
  items.unshift(newPlugin);
  savePlugins(items);
  return newPlugin;
}

export function deleteCustomPlugin(id: string, ownerId: string): boolean {
  const items = readCustomPlugins();
  const target = items.find((p) => p.id === id);
  if (!target || !target.isCustom || target.ownerId !== ownerId) return false;
  const next = items.filter((p) => p.id !== id);
  savePlugins(next);
  return true;
}
