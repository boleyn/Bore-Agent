import { ImportedMcpAddressError, isImportedMcpUrl } from "@/agent/mcp/importedTransport";
import { McpClientManager } from "@/agent/mcp";
import { ToolRegistry } from "@/agent/tools/registry";
import { requireAuth } from "@server/auth/session";
import type { NextApiRequest, NextApiResponse } from "next";
import { deleteCustomPlugin, getPluginById, listImportedMcpConfigs, toPluginView, updatePlugin } from "@server/plugins/store";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const ownerId = String(auth.user._id);
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!id) {
    return res.status(400).json({ error: "缺少插件 ID" });
  }

  if (req.method === "GET") {
    const plugin = getPluginById(id, ownerId);
    if (!plugin) return res.status(404).json({ error: "插件不存在" });
    return res.status(200).json({ plugin: toPluginView(plugin) });
  }

  if (req.method === "POST") {
    const plugin = getPluginById(id, ownerId);
    if (!plugin?.isCustom || plugin.kind !== "mcp") return res.status(404).json({ error: "MCP 插件不存在。" });
    const config = listImportedMcpConfigs(ownerId).find((candidate) => candidate.name === id);
    if (!config) return res.status(409).json({ error: "请先启用插件并保存服务器地址。" });

    const manager = new McpClientManager();
    const registry = new ToolRegistry();
    try {
      await manager.connect(config, registry);
      return res.status(200).json({ toolCount: registry.list().length });
    } catch (issue) {
      const error = issue instanceof ImportedMcpAddressError
        ? issue.message
        : "无法连接 MCP 服务器，请检查服务器地址和认证设置。";
      return res.status(502).json({ error });
    } finally {
      await manager.closeAll();
    }
  }

  if (req.method === "PATCH") {
    const plugin = getPluginById(id, ownerId);
    if (!plugin) return res.status(404).json({ error: "插件不存在" });
    if (!plugin.isCustom) return res.status(403).json({ error: "内置工具由服务端管理" });
    const { installed, enabled, configValues, name, description, endpointUrl } = req.body ?? {};
    const nextUrl = configValues?.endpointUrl ?? endpointUrl;
    if (plugin.kind === "mcp" && nextUrl !== undefined &&
      (typeof nextUrl !== "string" || !isImportedMcpUrl(nextUrl.trim()))) {
      return res.status(400).json({ error: "请输入公开的 HTTPS MCP 服务器地址。" });
    }
    const updated = updatePlugin(id, ownerId, {
      ...(typeof installed === "boolean" ? { installed } : {}),
      ...(typeof enabled === "boolean" ? { enabled } : {}),
      ...(configValues && typeof configValues === "object" ? { configValues } : {}),
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof description === "string" ? { description } : {}),
      ...(typeof endpointUrl === "string" ? { endpointUrl } : {}),
    });
    if (!updated) return res.status(404).json({ error: "插件不存在" });
    return res.status(200).json({ plugin: toPluginView(updated) });
  }

  if (req.method === "DELETE") {
    const ok = deleteCustomPlugin(id, ownerId);
    if (!ok) return res.status(400).json({ error: "仅支持删除自定义插件" });
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", ["GET", "POST", "PATCH", "DELETE"]);
  return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
}
