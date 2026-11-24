import { expect, test } from "bun:test";
import { createLocalDeviceGateway } from "./gateway";

const target = { teamId: "team", memberId: "member", deviceId: "device" };
const query = { operationId: "operation", grantId: "grant", grantVersion: 1 };
const record = { operationId: "operation", grantId: "grant", digest: "a".repeat(64), deadline: Date.now() + 60_000, updatedAt: Date.now(), status: "completed" };

test("execution and query payloads remain separate from strict identity validation", async () => {
  const requests: any[] = [];
  const gateway = createLocalDeviceGateway(async body => {
    requests.push(body);
    return Response.json({ data: (body as any).action === "output" ? { events: [], next: 0, gap: false, done: true, truncated: false } : record });
  });
  await gateway.execute({ ...target, operation: { ...query, command: "printf ok", workdir: "/tmp", timeoutMs: 1000, deadline: record.deadline } });
  await gateway.query({ ...target, query });
  await gateway.cancel({ ...target, query });
  await gateway.output({ ...target, outputQuery: { ...query, after: 0, limit: 1 } });
  expect(requests.map(r => r.action)).toEqual(["execute", "query", "cancel", "output"]);
  for (const request of requests) {
    expect(request.principal).toEqual({ teamId: "team", memberId: "member" });
    expect(request.deviceId).toBe("device");
  }
  expect(() => gateway.query({ ...target, query, extraIdentity: "forged" } as any)).toThrow();
  expect(() => gateway.query({ ...target, query: { ...query, grantVersion: 0 } })).toThrow();
  expect(requests).toHaveLength(4);
});

test("browser operations are scoped to a browser-enabled connection and can be cancelled", async () => {
  const { createServer } = await import("node:http");
  const { WebSocket } = await import("ws");
  const { EmbeddedDeviceGateway } = await import("./socket");
  const embedded = new EmbeddedDeviceGateway(async () => ({ ...target, expiresAt: Date.now() + 60_000 }));
  const server = createServer();
  embedded.attach(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/local-device/connect`, {
    headers: { authorization: `Bearer ${"a".repeat(43)}`, "x-fastgpt-browser": "v1" },
  });
  const receive = () => new Promise<any>(resolve => {
    socket.once("message", (data: Buffer) => resolve(JSON.parse(data.toString())));
  });
  try {
    const welcome = await receive();
    const gateway = createLocalDeviceGateway((body, signal) => embedded.dispatch(body, signal));
    const principal = { teamId: target.teamId, memberId: target.memberId };
    expect(await gateway.presence({ ...principal, deviceIds: [target.deviceId] })).toEqual([
      { deviceId: target.deviceId, online: true, browserSupported: true },
    ]);
    const browserOperation = {
      ...query, deadline: Date.now() + 10_000, browserAction: { action: "snapshot" as const },
    };
    await expect(gateway.executeBrowser({ ...target, memberId: "other", browserOperation }))
      .rejects.toThrow("device_owner_mismatch");

    const start = receive();
    const result = gateway.executeBrowser({ ...target, browserOperation });
    const request = await start;
    expect(request).toMatchObject({ type: "browser_start", operationId: query.operationId, browserRequest: browserOperation });
    socket.send(JSON.stringify({
      version: 1, epoch: welcome.epoch, type: "browser_result",
      requestId: request.requestId, operationId: query.operationId, browserResult: { content: "fixture" },
    }));
    expect(await result).toEqual({ content: "fixture" });

    const controller = new AbortController();
    const nextStart = receive();
    const pending = gateway.executeBrowser({ ...target, browserOperation }, controller.signal);
    const failure = pending.catch(error => error);
    const next = await nextStart;
    const cancelled = receive();
    controller.abort();
    expect(await cancelled).toMatchObject({ type: "browser_cancel", requestId: next.requestId, operationId: query.operationId });
    expect(await failure).toMatchObject({ message: "execution_outcome_unknown" });
  } finally {
    socket.terminate();
    server.close();
  }
});
