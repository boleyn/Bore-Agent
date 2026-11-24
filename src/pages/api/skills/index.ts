import type { NextApiRequest, NextApiResponse } from "next";
import { createCustomSkill, listManagedSkills } from "@server/skills/store";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    const skills = listManagedSkills();
    return res.status(200).json({ skills });
  }

  if (req.method === "POST") {
    const { name, description, content, templateKey } = req.body ?? {};
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "技能名称不能为空" });
    }
    const created = createCustomSkill({
      name,
      description: typeof description === "string" ? description : "",
      content: typeof content === "string" ? content : "",
      templateKey: typeof templateKey === "string" ? templateKey : undefined,
    });
    return res.status(201).json({ skill: created });
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
}
