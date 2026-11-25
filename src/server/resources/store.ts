import crypto from "node:crypto";
import type { Collection } from "mongodb";
import { getMongoDb } from "../db/mongo";

export type InfraResourceKind = "ssh" | "database";
export type SshAuthType = "password" | "privateKey";
export type DatabaseType = "postgresql" | "mysql" | "mongodb" | "redis";

export type InfraResourceRecord = {
  resourceId: string;
  userId: string;
  kind: InfraResourceKind;
  name: string;
  host: string;
  port: number;
  username?: string;
  authType?: SshAuthType;
  dbType?: DatabaseType;
  database?: string;
  remark?: string;
  encryptedSecret?: string;
  lastTestStatus?: "ok" | "error";
  lastTestMessage?: string;
  lastTestedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicInfraResource = Omit<InfraResourceRecord, "encryptedSecret"> & {
  hasSecret: boolean;
};

let indexesReady = false;

function getEncryptionKey(): Buffer {
  const seed =
    process.env.RESOURCE_SECRET_KEY ||
    process.env.SESSION_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "ai-studio-local-infra-resource-key";
  return crypto.createHash("sha256").update(seed).digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function toPublicResource(record: InfraResourceRecord): PublicInfraResource {
  const { encryptedSecret, ...rest } = record;
  return {
    ...rest,
    hasSecret: Boolean(encryptedSecret),
  };
}

async function getCollection(): Promise<Collection<InfraResourceRecord>> {
  const db = await getMongoDb();
  const col = db.collection<InfraResourceRecord>("user_infra_resources");
  if (!indexesReady) {
    indexesReady = true;
    await col.createIndex({ userId: 1, kind: 1, updatedAt: -1 }).catch(() => {});
    await col.createIndex({ resourceId: 1, userId: 1 }, { unique: true }).catch(() => {});
  }
  return col;
}

export async function listUserResources(
  userId: string,
  kind?: InfraResourceKind
): Promise<PublicInfraResource[]> {
  const col = await getCollection();
  const filter: Record<string, unknown> = { userId };
  if (kind) filter.kind = kind;
  const list = await col.find(filter).sort({ updatedAt: -1 }).toArray();
  return list.map(toPublicResource);
}

export async function getUserResource(
  userId: string,
  resourceId: string
): Promise<InfraResourceRecord | null> {
  const col = await getCollection();
  return col.findOne({ userId, resourceId });
}

export async function createUserResource(input: {
  userId: string;
  kind: InfraResourceKind;
  name: string;
  host: string;
  port: number;
  username?: string;
  authType?: SshAuthType;
  dbType?: DatabaseType;
  database?: string;
  remark?: string;
  secret?: string;
}): Promise<PublicInfraResource> {
  const col = await getCollection();
  const now = new Date();
  const doc: InfraResourceRecord = {
    resourceId: crypto.randomUUID(),
    userId: input.userId,
    kind: input.kind,
    name: input.name,
    host: input.host,
    port: input.port,
    username: input.username || undefined,
    authType: input.kind === "ssh" ? input.authType || "password" : undefined,
    dbType: input.kind === "database" ? input.dbType || "postgresql" : undefined,
    database: input.kind === "database" ? input.database || undefined : undefined,
    remark: input.remark || undefined,
    encryptedSecret: input.secret ? encryptSecret(input.secret) : undefined,
    createdAt: now,
    updatedAt: now,
  };
  await col.insertOne(doc);
  return toPublicResource(doc);
}

export async function updateUserResource(
  userId: string,
  resourceId: string,
  input: {
    name?: string;
    host?: string;
    port?: number;
    username?: string;
    authType?: SshAuthType;
    dbType?: DatabaseType;
    database?: string;
    remark?: string;
    secret?: string;
  }
): Promise<PublicInfraResource | null> {
  const col = await getCollection();
  const setFields: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) setFields.name = input.name;
  if (input.host !== undefined) setFields.host = input.host;
  if (input.port !== undefined) setFields.port = input.port;
  if (input.username !== undefined) setFields.username = input.username || undefined;
  if (input.authType !== undefined) setFields.authType = input.authType;
  if (input.dbType !== undefined) setFields.dbType = input.dbType;
  if (input.database !== undefined) setFields.database = input.database || undefined;
  if (input.remark !== undefined) setFields.remark = input.remark || undefined;
  if (input.secret !== undefined && input.secret.length > 0) {
    setFields.encryptedSecret = encryptSecret(input.secret);
  }

  const result = await col.findOneAndUpdate(
    { userId, resourceId },
    { $set: setFields },
    { returnDocument: "after" }
  );
  return result ? toPublicResource(result) : null;
}

export async function updateResourceTestResult(
  userId: string,
  resourceId: string,
  status: "ok" | "error",
  message: string
): Promise<void> {
  const col = await getCollection();
  await col.updateOne(
    { userId, resourceId },
    {
      $set: {
        lastTestStatus: status,
        lastTestMessage: message,
        lastTestedAt: new Date(),
      },
    }
  );
}

export async function deleteUserResource(userId: string, resourceId: string): Promise<boolean> {
  const col = await getCollection();
  const result = await col.deleteOne({ userId, resourceId });
  return result.deletedCount > 0;
}
