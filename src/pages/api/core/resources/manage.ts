import net from "node:net";
import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";
import { requireAuth } from "@server/auth/session";
import {
  createUserResource,
  deleteUserResource,
  getUserResource,
  listUserResources,
  updateResourceTestResult,
  updateUserResource,
} from "@/server/resources/store";

const CreateSchema = z.object({
  action: z.literal("create"),
  kind: z.enum(["ssh", "database"]),
  name: z.string().trim().min(1).max(64),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().max(128).optional(),
  authType: z.enum(["password", "privateKey"]).optional(),
  dbType: z.enum(["postgresql", "mysql", "mongodb", "redis"]).optional(),
  database: z.string().trim().max(128).optional(),
  remark: z.string().trim().max(128).optional(),
  secret: z.string().max(16384).optional(),
});

const UpdateSchema = z.object({
  action: z.literal("update"),
  resourceId: z.string().uuid(),
  name: z.string().trim().min(1).max(64).optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().trim().max(128).optional(),
  authType: z.enum(["password", "privateKey"]).optional(),
  dbType: z.enum(["postgresql", "mysql", "mongodb", "redis"]).optional(),
  database: z.string().trim().max(128).optional(),
  remark: z.string().trim().max(128).optional(),
  secret: z.string().max(16384).optional(),
});

const DeleteSchema = z.object({
  action: z.literal("delete"),
  resourceId: z.string().uuid(),
});

const TestSchema = z.object({
  action: z.literal("test"),
  resourceId: z.string().uuid(),
});

const ActionSchema = z.discriminatedUnion("action", [
  CreateSchema,
  UpdateSchema,
  DeleteSchema,
  TestSchema,
]);

function probeConnection(
  host: string,
  port: number,
  expectSshBanner: boolean,
  timeoutMs = 4500
): Promise<{ ok: boolean; message: string; latencyMs: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const finish = (ok: boolean, message: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, message, latencyMs: Date.now() - start });
    };

    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);

    socket.on("connect", () => {
      if (!expectSshBanner) {
        finish(true, `TCP 连接成功 (${Date.now() - start}ms)`);
      }
    });

    socket.on("data", (chunk) => {
      if (!expectSshBanner) return;
      const line = chunk.toString("utf8").split(/\r?\n/)[0]?.trim() || "";
      if (line.startsWith("SSH-")) {
        finish(true, `SSH 握手成功 (${line}, ${Date.now() - start}ms)`);
      } else {
        finish(false, `目标端口已连通，但未返回 SSH 协议标识`);
      }
    });

    socket.on("timeout", () => {
      finish(false, `连接超时 (${timeoutMs}ms)`);
    });

    socket.on("error", (err) => {
      finish(false, err.message || "连接失败");
    });
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const userId = auth.user._id != null ? String(auth.user._id) : "";
  if (!userId) {
    res.status(401).json({ error: "用户身份无效" });
    return;
  }

  if (req.method === "GET") {
    const resources = await listUserResources(userId);
    res.status(200).json({ resources });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const parsed = ActionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
    return;
  }

  const body = parsed.data;

  if (body.action === "create") {
    const resource = await createUserResource({ ...body, userId });
    res.status(200).json({ resource });
    return;
  }

  if (body.action === "update") {
    const { action: _, resourceId, ...patch } = body;
    const resource = await updateUserResource(userId, resourceId, patch);
    if (!resource) {
      res.status(404).json({ error: "resource_not_found" });
      return;
    }
    res.status(200).json({ resource });
    return;
  }

  if (body.action === "delete") {
    const deleted = await deleteUserResource(userId, body.resourceId);
    if (!deleted) {
      res.status(404).json({ error: "resource_not_found" });
      return;
    }
    res.status(200).json({ success: true });
    return;
  }

  if (body.action === "test") {
    const record = await getUserResource(userId, body.resourceId);
    if (!record) {
      res.status(404).json({ error: "resource_not_found" });
      return;
    }
    const result = await probeConnection(record.host, record.port, record.kind === "ssh");
    await updateResourceTestResult(
      userId,
      record.resourceId,
      result.ok ? "ok" : "error",
      result.message
    );
    res.status(200).json(result);
    return;
  }
}
