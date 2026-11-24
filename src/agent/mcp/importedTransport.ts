import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";

const reserved = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) reserved.addSubnet(address, prefix, "ipv4");

const fakeIpRange = new BlockList();
fakeIpRange.addSubnet("198.18.0.0", 15, "ipv4");

async function resolvePublicIpv4(hostname: string) {
  const query = new URL("https://cloudflare-dns.com/dns-query");
  query.search = new URLSearchParams({ name: hostname, type: "A" }).toString();
  const response = await undiciFetch(query, {
    headers: { accept: "application/dns-json" },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("Public DNS lookup failed");
  const result = await response.json() as { Status?: number; Answer?: Array<{ type: number; data: string }> };
  return (result.Status === 0 && Array.isArray(result.Answer) ? result.Answer : [])
    .filter(({ type, data }) => type === 1 && isIP(data) === 4)
    .map(({ data }) => ({ address: data, family: 4 }));
}

export function isImportedMcpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash &&
      !isIP(url.hostname) && !url.hostname.includes(":") && url.hostname.includes(".");
  } catch {
    return false;
  }
}

export class ImportedMcpAddressError extends Error {}

export async function createImportedMcpTransport(value: string) {
  if (!isImportedMcpUrl(value)) throw new ImportedMcpAddressError("MCP 服务器需要公开 HTTPS 地址。");
  const url = new URL(value);
  let addresses = await lookup(url.hostname, { family: 4, all: true });
  if (addresses.length && addresses.every(({ address }) => fakeIpRange.check(address, "ipv4"))) {
    try {
      addresses = await resolvePublicIpv4(url.hostname);
    } catch {
      throw new ImportedMcpAddressError("代理返回了 Fake IP，公网 DNS 复查失败。");
    }
  }
  if (!addresses.length || addresses.some(({ address }) => reserved.check(address, "ipv4"))) {
    throw new ImportedMcpAddressError("服务器域名解析到了私有或保留地址，无法连接。");
  }

  // Pin the validated address while keeping the original hostname for TLS.
  const connect = buildConnector({
    timeout: 10_000,
    lookup: (_hostname, options, callback) => {
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, 4);
    },
  });
  const dispatcher = new Agent({ connect });
  return {
    fetch: async (target: string | URL, init?: RequestInit) => {
      if (new URL(target).origin !== url.origin) throw new Error("MCP 请求超出了插件配置的来源");
      const options = { ...init, redirect: "error" as const, dispatcher };
      return undiciFetch(target, options as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
    },
    close: () => dispatcher.destroy(),
  };
}
