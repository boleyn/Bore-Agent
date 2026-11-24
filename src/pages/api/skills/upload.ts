import type { NextApiRequest, NextApiResponse } from "next";
import JSZip from "jszip";
import { createCustomSkill } from "@server/skills/store";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "15mb",
    },
  },
};

function parseFrontmatter(raw: string): { name?: string; description?: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = match[1];
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : undefined,
    description: descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, "") : undefined,
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  try {
    const { fileName, fileBase64 } = req.body ?? {};
    if (!fileBase64 || typeof fileBase64 !== "string") {
      return res.status(400).json({ error: "请上传有效的技能压缩包或 SKILL.md 文件" });
    }

    const cleanBase64 = fileBase64.replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(cleanBase64, "base64");
    const safeName = typeof fileName === "string" ? fileName : "skill.zip";

    let content = "";
    if (safeName.toLowerCase().endsWith(".md")) {
      content = buffer.toString("utf8");
    } else {
      const zip = await JSZip.loadAsync(buffer);
      const entries = Object.values(zip.files).filter((f) => !f.dir);
      const skillMd =
        entries.find((f) => /(^|\/)SKILL\.md$/i.test(f.name)) ||
        entries.find((f) => /\.md$/i.test(f.name));
      if (!skillMd) {
        return res.status(400).json({ error: "压缩包中未找到 SKILL.md 文件" });
      }
      content = await skillMd.async("string");
    }

    const meta = parseFrontmatter(content);
    const fallbackName = safeName.replace(/\.(zip|md)$/i, "") || "导入的技能";
    const created = createCustomSkill({
      name: meta.name || fallbackName,
      description: meta.description || `从 ${safeName} 导入的技能`,
      content,
    });

    return res.status(201).json({ skill: created });
  } catch (err) {
    console.error("[skills/upload]", err);
    return res.status(400).json({ error: "解析技能包失败，请确认文件为包含 SKILL.md 的 ZIP 或 Markdown 文件" });
  }
}
