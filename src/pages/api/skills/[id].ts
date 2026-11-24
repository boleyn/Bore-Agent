import type { NextApiRequest, NextApiResponse } from "next";
import { deleteCustomSkill, getManagedSkillDetail, updateManagedSkill } from "@server/skills/store";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!id) {
    return res.status(400).json({ error: "缺少技能 ID" });
  }

  if (req.method === "GET") {
    const skill = getManagedSkillDetail(id);
    if (!skill) return res.status(404).json({ error: "技能不存在" });
    return res.status(200).json({ skill });
  }

  if (req.method === "PATCH") {
    const { name, description, content, enabled } = req.body ?? {};
    const updated = updateManagedSkill(id, {
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof description === "string" ? { description } : {}),
      ...(typeof content === "string" ? { content } : {}),
      ...(typeof enabled === "boolean" ? { enabled } : {}),
    });
    if (!updated) return res.status(404).json({ error: "技能不存在" });
    return res.status(200).json({ skill: updated });
  }

  if (req.method === "DELETE") {
    const ok = deleteCustomSkill(id);
    if (!ok) return res.status(400).json({ error: "仅支持删除自定义技能" });
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", ["GET", "PATCH", "DELETE"]);
  return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
}
