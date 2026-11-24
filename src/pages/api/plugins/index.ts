import { isImportedMcpUrl } from "@/agent/mcp/importedTransport";
import { requireAuth } from "@server/auth/session";
import type { NextApiRequest, NextApiResponse } from "next";
import { createCustomPlugin, listPlugins, toPluginView } from "@server/plugins/store";

import { loadPluginPolicy } from "@/agent/plugins/config";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const ownerId = String(auth.user._id);
  if (req.method === "GET") {
    const plugins = listPlugins(ownerId).map(toPluginView);
    const disabled = new Set(loadPluginPolicy().disabled);
    const runtimeTools = {
      webFetch: !disabled.has("web"),
      webSearch: !disabled.has("web") && Boolean(process.env.WEB_SEARCH_API_URL?.trim()),
      siteStatus: !disabled.has("site-connections"),
    };
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).json({ plugins, runtimeTools });
  }

  if (req.method === "POST") {
    const { name, description, endpointUrl, authHeader, iconDataUrl } = req.body ?? {};
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "插件名称不能为空" });
    }
    if (typeof endpointUrl !== "string" || !isImportedMcpUrl(endpointUrl.trim())) {
      return res.status(400).json({ error: "请输入公开的 HTTPS MCP 服务器地址。" });
    }
    let customIcon: string | undefined;
    if (iconDataUrl !== undefined) {
      const encoded = typeof iconDataUrl === "string" && /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(iconDataUrl)?.[1];
      const bytes = encoded && encoded.length <= 13_656 ? Buffer.from(encoded, "base64") : undefined;
      if (!bytes || bytes.length < 33 || bytes.length > 10_240 ||
        bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
        bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR" ||
        ![bytes.readUInt32BE(16), bytes.readUInt32BE(20)].every((size) => size > 0 && size <= 1024)) {
        return res.status(400).json({ error: "图标必须是 10 KB 以内、长宽不超过 1024 像素的 PNG 图片。" });
      }
      customIcon = "data:image/png;base64," + bytes.toString("base64");
    }
    const created = createCustomPlugin({
      name,
      description: typeof description === "string" ? description : "",
      kind: "mcp",
      iconDataUrl: customIcon,
      endpointUrl: typeof endpointUrl === "string" ? endpointUrl : "",
      authHeader: typeof authHeader === "string" ? authHeader : undefined,
    }, ownerId);
    return res.status(201).json({ plugin: toPluginView(created) });
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
}
