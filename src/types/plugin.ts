export const PLUGIN_ARCHIVE_EXTENSION = /\.(zip|tgz|tar\.gz)$/i;

export type PluginCategory =
  | "popular"
  | "featured"
  | "business"
  | "productivity"
  | "builtin"
  | "custom";

export type PluginKind = "oauth" | "mcp" | "api" | "builtin";

export type PluginConfigField = {
  key: string;
  label: string;
  type: "text" | "password" | "url" | "boolean" | "select";
  placeholder?: string;
  required?: boolean;
  description?: string;
  options?: string[];
};

export type PluginItem = {
  id: string;
  name: string;
  description: string;
  longDescription?: string;
  category: PluginCategory;
  kind: PluginKind;
  iconKey: string;
  iconDataUrl?: string;
  iconBg: string;
  iconText: string;
  iconColor?: string;
  author?: string;
  version?: string;
  homepage?: string;
  capabilities?: string[];
  connectorProvider?: "google" | "dropbox" | "sharepoint" | "box";
  isPublic: boolean;
  installed: boolean;
  enabled: boolean;
  isCustom?: boolean;
  endpointUrl?: string;
  configSchema?: PluginConfigField[];
  configValues?: Record<string, string | boolean>;
  installedAt?: string;
  updatedAt?: string;
};

export type CreateCustomPluginInput = {
  iconDataUrl?: string;
  name: string;
  description: string;
  kind?: PluginKind;
  endpointUrl?: string;
  author?: string;
  category?: PluginCategory;
  authHeader?: string;
};

/** Directory entries do not grant access to the services they describe. */
export function getPluginSourceLabel(plugin: PluginItem): string {
  if (plugin.connectorProvider) return "资料空间连接器";
  if (plugin.id === "builtin-web" || plugin.id === "builtin-site") return "内置工具";
  if (plugin.isCustom) return "自定义插件";
  return "预置目录";
}
