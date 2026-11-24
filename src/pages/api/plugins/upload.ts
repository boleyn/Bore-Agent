import type { NextApiRequest, NextApiResponse } from "next";
import { gunzipSync } from "node:zlib";
import { PLUGIN_ARCHIVE_EXTENSION } from "@/types/plugin";
import JSZip from "jszip";
import { isImportedMcpUrl } from "@/agent/mcp/importedTransport";
import { requireAuth } from "@server/auth/session";
import { createCustomPlugin, toPluginView } from "@server/plugins/store";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const manifestName = /(^|\/)(plugin|manifest|mcp)\.json$/i;
const maxManifestSize = 256 * 1024;

function readTarManifest(bytes: Buffer): string | undefined {
  const tar = gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 });
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return;
    const sizeField = header.toString("ascii", 124, 136).replace(/\0.*$/, "").trim();
    if (!/^[0-7]+$/.test(sizeField)) throw new Error("Invalid TAR size");
    const size = Number.parseInt(sizeField, 8);
    const start = offset + 512;
    const next = start + Math.ceil(size / 512) * 512;
    if (next > tar.length) throw new Error("Truncated TAR entry");
    const kind = header[156];
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    if ((kind === 0 || kind === 48) && manifestName.test(name)) {
      if (size > maxManifestSize) throw new Error("MCP 配置清单过大。");
      return tar.toString("utf8", start, start + size);
    }
    offset = next;
  }
}

async function readZipManifest(bytes: Buffer): Promise<string | undefined> {
  const archive = await JSZip.loadAsync(bytes);
  const entry = Object.values(archive.files).find((file) => !file.dir && manifestName.test(file.name));
  if (!entry) return;
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const stream = entry.nodeStream("nodebuffer");
    stream.on("data", (chunk: Buffer) => {
      length += chunk.byteLength;
      if (length > maxManifestSize) {
        stream.pause();
        reject(new Error("MCP 配置清单过大。"));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (req.method !== "POST") return res.setHeader("Allow", "POST").status(405).end();
  const { fileName, fileBase64 } = req.body ?? {};
  if (typeof fileBase64 !== "string" || typeof fileName !== "string" || !PLUGIN_ARCHIVE_EXTENSION.test(fileName)) {
    return res.status(400).json({ error: "请选择包含配置清单的 .zip、.tgz 或 .tar.gz 插件压缩包。" });
  }

  try {
    const bytes = Buffer.from(fileBase64.replace(/^data:[^,]+,/, ""), "base64");
    if (bytes.length > 700 * 1024) return res.status(400).json({ error: "插件压缩包不能超过 700 KB。" });
    const manifest = /\.zip$/i.test(fileName) ? await readZipManifest(bytes) : readTarManifest(bytes);
    if (!manifest) return res.status(400).json({ error: "压缩包中没有找到 MCP 配置清单。" });
    const document = asRecord(JSON.parse(manifest));
    const servers = Object.entries(asRecord(document.mcpServers));
    if (servers.length > 1) {
      return res.status(400).json({ error: "每次请导入一个 MCP 服务器配置。" });
    }
    const [serverName, serverConfig] = servers[0] ?? ["", document];
    const server = asRecord(serverConfig);
    const endpointUrl = readString(server.endpointUrl) || readString(server.url);
    if (server.command || !isImportedMcpUrl(endpointUrl) || server.type === "sse" || server.transport === "sse") {
      return res.status(400).json({ error: "请提供使用公开 HTTPS 地址的 Streamable HTTP MCP 配置。" });
    }
    const headers = asRecord(server.headers);
    const authHeader = Object.entries(headers).find(([key]) => key.toLowerCase() === "authorization")?.[1];
    const created = createCustomPlugin({
      name: readString(document.displayName) || readString(document.name) || serverName || fileName.replace(PLUGIN_ARCHIVE_EXTENSION, ""),
      description: readString(document.description),
      kind: "mcp",
      endpointUrl,
      authHeader: readString(authHeader),
    }, String(auth.user._id));
    return res.status(201).json({ plugin: toPluginView(created) });
  } catch (issue) {
    return res.status(400).json({ error: issue instanceof SyntaxError ? "配置清单不是有效的 JSON。" : "无法读取插件配置清单。" });
  }
}
