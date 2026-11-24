import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import type { LocalDeviceBrowserActionSchema, LocalDeviceBrowserModeSchema } from "@/shared/localDevice/browser";
import { withExecutionLease } from "@/agent/sandbox/environments/executionLease";
import { createLocalDeviceGateway } from "./gateway";
import { findDevice, findGrant, listGrantsForScope, markGrantRevoked, upsertGrant } from "./store";

export async function runLocalBrowser(input: {
  userId: string;
  projectToken: string;
  projectName?: string;
  chatId: string;
  deviceId: string;
  executionGrantId: string;
  operationKey: string;
  mode: z.infer<typeof LocalDeviceBrowserModeSchema>;
  action: z.infer<typeof LocalDeviceBrowserActionSchema>;
  signal?: AbortSignal;
}) {
  const { userId, projectToken, deviceId, chatId, mode, signal } = input;
  signal?.throwIfAborted();
  const [device, executionGrant] = await Promise.all([
    findDevice(deviceId),
    findGrant(input.executionGrantId),
  ]);
  if (!device || device.revoked || device.teamId !== userId || device.memberId !== userId ||
      !executionGrant || executionGrant.revoked || !executionGrant.locallyApproved ||
      executionGrant.deviceId !== deviceId || executionGrant.teamId !== userId ||
      executionGrant.memberId !== userId || executionGrant.appId !== projectToken ||
      !executionGrant.capabilities.includes("exec") ||
      (executionGrant.expiresAt > 0 && executionGrant.expiresAt <= Date.now())) {
    throw new Error("local_device_grant_unavailable");
  }

  const gateway = createLocalDeviceGateway();
  const principal = { teamId: userId, memberId: userId, deviceId };
  const sourceTarget = `browser:${projectToken}:${mode}`;
  const scope = { ...principal, appId: projectToken, chatId, sourceTarget, browserMode: mode };
  const grants = await listGrantsForScope({ userId, appId: projectToken, deviceId });
  const existing = grants.find(grant => grant.chatId === chatId && grant.sourceTarget === sourceTarget &&
    grant.browserMode === mode && grant.locallyApproved &&
    (grant.expiresAt === 0 || grant.expiresAt > Date.now()));
  const grant = {
    ...scope,
    grantId: existing?.grantId ?? randomUUID(),
    version: existing?.version ?? 1,
    expiresAt: existing?.expiresAt ?? executionGrant.expiresAt,
    workdir: "",
    revoked: false,
  };
  if (!existing) {
    const name = input.projectName || projectToken;
    const approved = await gateway.controlGrant({
      action: "grant_request",
      grant: { ...grant, display: { teamName: "AI Studio", memberName: userId, appName: name, chatTitle: name } },
    }, signal);
    const { display: _display, ...record } = approved;
    await upsertGrant({ ...record, capabilities: ["browser"], locallyApproved: true, createdAt: new Date() });
  }

  return withExecutionLease(
    async (leaseExpiresAt, leaseSignal) => {
      try {
        await gateway.controlGrant({
          action: "grant_renew",
          grant,
          leaseExpiresAt: Math.min(leaseExpiresAt, grant.expiresAt || Infinity),
        }, leaseSignal);
      } catch (error) {
        if (error instanceof Error && (
          ["browser_grant_missing", "grant_expired", "grant_revoked", "grant_unavailable"].includes(error.message) ||
          (mode === "sharedTab" && error.message === "browser_unavailable")
        )) {
          await markGrantRevoked(grant.grantId, userId);
          await gateway.controlGrant({ action: "grant_revoke", grant }, leaseSignal).catch(() => {});
        }
        throw error;
      }
    },
    leaseSignal => gateway.executeBrowser({
      ...principal,
      browserOperation: {
        operationId: createHash("sha256").update(JSON.stringify([grant.grantId, input.operationKey])).digest("hex"),
        grantId: grant.grantId,
        grantVersion: grant.version,
        deadline: Date.now() + 60_000,
        browserAction: input.action,
      },
    }, leaseSignal),
    signal,
  );
}
