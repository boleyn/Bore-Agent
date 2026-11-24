import { Button, Menu, MenuButton, MenuItem, MenuList, Modal, ModalContent, ModalHeader, ModalOverlay } from "@chakra-ui/react";
import { useRouter } from "next/router";
import { getPluginSourceLabel, PLUGIN_ARCHIVE_EXTENSION } from "@/types/plugin";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Blocks,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Edit3,
  FilePlus2,
  FileText,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Plus,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { PluginIcon } from "@components/customize/PluginIcon";
import { ChatGptPluginsNavIcon, ChatGptSkillsNavIcon } from "@components/customize/CustomizeIcons";
import { withAuthHeaders } from "@features/auth/client/authClient";
import type { PluginCategory, PluginItem, PluginKind } from "@/types/plugin";
import type { ManagedSkillDetail, ManagedSkillItem } from "@server/skills/store";

export type PluginAddMode = "upload" | "mcp";

type CustomizeViewProps = {
  pluginDialog?: { kind: PluginAddMode; onClose: () => void; onInstalled: (plugin: PluginItem) => void };
  initialPluginId?: string;
  onInitialPluginOpened?: () => void;
  mode: "plugins" | "skills";
  onChangeMode: (mode: "plugins" | "skills") => void;
  onSkillAvailabilityChanged?: () => void;
  onTrySkill?: (skillName: string) => void;
  onCreatePluginWithChat?: () => void;
  onCreateSkillWithChat?: () => void;
};

const CATEGORY_SECTIONS: { key: PluginCategory; label: string }[] = [
  { key: "popular", label: "热门" },
  { key: "featured", label: "新品推荐" },
  { key: "business", label: "小型企业" },
  { key: "productivity", label: "效率与协作" },
  { key: "builtin", label: "内置工具集" },
  { key: "custom", label: "我的插件" },
];

const KIND_LABELS: Record<PluginKind, string> = {
  oauth: "OAuth 连接器",
  mcp: "MCP 服务",
  api: "API / Webhook",
  builtin: "内置工具",
};

export default function CustomizeView({
  mode,
  onChangeMode,
  onTrySkill,
  onSkillAvailabilityChanged,
  onCreateSkillWithChat,
  onCreatePluginWithChat,
  initialPluginId,
  pluginDialog,
  onInitialPluginOpened,
}: CustomizeViewProps) {
  const router = useRouter();
  const callbackProvider = typeof router.query.connector === "string" ? router.query.connector : undefined;
  const callbackResult = typeof router.query.connection === "string" ? router.query.connection : undefined;
  const handledConnectorReturn = useRef<string>();
  const [connectionNotice, setConnectionNotice] = useState("");
  const [checkingPluginId, setCheckingPluginId] = useState<string>();
  const [pluginCheck, setPluginCheck] = useState<{ id: string; text: string; error: boolean }>();
  const [connecting, setConnecting] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Plugins state
  const [plugins, setPlugins] = useState<PluginItem[]>([]);
  const [loadingPlugins, setLoadingPlugins] = useState(true);
  const [pluginSearch, setPluginSearch] = useState("");
  const [pluginFilter, setPluginFilter] = useState<
    "public" | "all" | "installed" | PluginKind
  >("all");
  const [focusedCategory, setFocusedCategory] = useState<PluginCategory | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  const [selectedPlugin, setSelectedPlugin] = useState<PluginItem | null>(null);
  const [configDraft, setConfigDraft] = useState<Record<string, string | boolean>>({});
  const [savingConfig, setSavingConfig] = useState(false);
  const [connectorStatus, setConnectorStatus] = useState<{
    configured: boolean;
    connected: boolean;
  } | null>(null);

  const [addModalKind, setAddModalKind] = useState<PluginAddMode | null>(pluginDialog?.kind ?? null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [defaultPermission, setDefaultPermission] = useState<"low_risk" | "always_ask" | "always_allow">("low_risk");
  const [pluginPermissions, setPluginPermissions] = useState<Record<string, string>>({});
  const [settingsSearch, setSettingsSearch] = useState("");
  const [pluginIcon, setPluginIcon] = useState<string>();
  const [newPluginName, setNewPluginName] = useState("");
  const [newPluginDesc, setNewPluginDesc] = useState("");
  const [newPluginEndpoint, setNewPluginEndpoint] = useState("");
  const [pluginAuthType, setPluginAuthType] = useState<"none" | "bearer">("none");
  const [newPluginAuth, setNewPluginAuth] = useState("");
  const [pluginPackage, setPluginPackage] = useState<File>();
  const pluginPackageInput = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState("");
  const [creatingPlugin, setCreatingPlugin] = useState(false);

  // Skills state
  const [skills, setSkills] = useState<ManagedSkillItem[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(true);
  const [skillSearch, setSkillSearch] = useState("");
  const [skillFilter, setSkillFilter] = useState<"enabled" | "all" | "custom" | "builtin">("enabled");
  const [skillMenuOpenToken, setSkillMenuOpenToken] = useState<string | null>(null);
  const [uploadSkillOpen, setUploadSkillOpen] = useState(false);
  const [uploadSkillFileName, setUploadSkillFileName] = useState("");
  const [uploadSkillBase64, setUploadSkillBase64] = useState("");
  const [uploadSkillError, setUploadSkillError] = useState("");
  const [detailSkill, setDetailSkill] = useState<ManagedSkillDetail | null>(null);
  const [skillEditMode, setSkillEditMode] = useState(false);
  const [createSkillOpen, setCreateSkillOpen] = useState(false);
  const [draftSkillName, setDraftSkillName] = useState("");
  const [draftSkillDesc, setDraftSkillDesc] = useState("");
  const [draftSkillContent, setDraftSkillContent] = useState("");
  const [savingSkill, setSavingSkill] = useState(false);

  const closeAddPlugin = () => {
    setAddModalKind(null);
    setPluginAuthType("none");
    setNewPluginAuth("");
    setUploadError("");
    setPluginPackage(undefined);
    setPluginIcon(undefined);
    pluginDialog?.onClose();
  };

  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (pluginDialog) return;
    void (async () => {
      try {
        const [pRes, sRes] = await Promise.all([
          fetch("/api/plugins", { headers: withAuthHeaders() }),
          fetch("/api/skills"),
        ]);
        const pData = await pRes.json();
        const sData = await sRes.json();
        if (Array.isArray(pData.plugins)) setPlugins(pData.plugins);
        if (Array.isArray(sData.skills)) setSkills(sData.skills);
      } finally {
        setLoadingPlugins(false);
        setLoadingSkills(false);
      }
    })();
  }, []);

  const installedPlugins = useMemo(
    () => plugins.filter((p) => p.installed),
    [plugins],
  );

  const filteredPlugins = useMemo(() => {
    const q = pluginSearch.trim().toLowerCase();
    return plugins.filter((p) => {
      if (focusedCategory && p.category !== focusedCategory) return false;
      if (pluginFilter === "public" && !p.isPublic && !p.isCustom) return false;
      if (pluginFilter === "installed" && !p.installed) return false;
      if (
        (pluginFilter === "oauth" ||
          pluginFilter === "mcp" ||
          pluginFilter === "api" ||
          pluginFilter === "builtin") &&
        p.kind !== pluginFilter
      ) {
        return false;
      }
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        (p.author || "").toLowerCase().includes(q)
      );
    });
  }, [plugins, pluginFilter, pluginSearch, focusedCategory]);

  const filteredSkills = useMemo(() => {
    const q = skillSearch.trim().toLowerCase();
    return skills.filter((s) => {
      if (skillFilter === "custom" && s.category !== "custom") return false;
      if (skillFilter === "builtin" && s.category !== "builtin") return false;
      if (skillFilter === "enabled" && !s.enabled) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.token.toLowerCase().includes(q)
      );
    });
  }, [skills, skillFilter, skillSearch]);

  const openPluginModal = useCallback((plugin: PluginItem) => {
    setMenuOpenId(null);
    setSelectedPlugin(plugin);
    setPluginCheck(undefined);
    setConfigDraft({ ...(plugin.configValues || {}) });
    setConnectorStatus(null);
    setConnectionNotice("");
    if (plugin.connectorProvider) {
      fetch(`/api/library/connectors/${plugin.connectorProvider}?status=1`, {
        headers: withAuthHeaders(),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data) setConnectorStatus(data);
        })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!initialPluginId || loadingPlugins || mode !== "plugins") return;
    const plugin = plugins.find((item) => item.id === initialPluginId);
    if (plugin) openPluginModal(plugin);
    onInitialPluginOpened?.();
  }, [initialPluginId, loadingPlugins, mode, onInitialPluginOpened, openPluginModal, plugins]);


  const handlePluginInstallToggle = async (plugin: PluginItem, installed: boolean) => {
    setMenuOpenId(null);
    const res = await fetch(`/api/plugins/${plugin.id}`, {
      method: "PATCH",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ installed, enabled: installed }),
    });
    if (res.ok) {
      const { plugin: updated } = await res.json();
      setPlugins((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      if (selectedPlugin?.id === updated.id) setSelectedPlugin(updated);
    }
  };

  const handlePluginEnableToggle = async (plugin: PluginItem, enabled: boolean) => {
    const res = await fetch(`/api/plugins/${plugin.id}`, {
      method: "PATCH",
      headers: withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ enabled }),
    });
    if (res.ok) {
      const { plugin: updated } = await res.json();
      setPlugins((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      if (selectedPlugin?.id === updated.id) setSelectedPlugin(updated);
    }
  };

  const handleSavePluginConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPlugin) return;
    setSavingConfig(true);
    try {
      const res = await fetch(`/api/plugins/${selectedPlugin.id}`, {
        method: "PATCH",
        headers: withAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ configValues: configDraft }),
      });
      if (res.ok) {
        const { plugin: updated } = await res.json();
        setPlugins((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
        setSelectedPlugin(null);
      }
    } finally {
      setSavingConfig(false);
    }
  };

  useEffect(() => {
    if (mode !== "plugins" || loadingPlugins || !callbackProvider || !callbackResult) return;
    const callback = `${callbackProvider}:${callbackResult}`;
    if (handledConnectorReturn.current === callback) return;
    const plugin = plugins.find((item) => item.connectorProvider === callbackProvider);
    if (!plugin) return;
    handledConnectorReturn.current = callback;
    openPluginModal(plugin);
    if (callbackResult === "cancelled") setConnectionNotice("已取消连接。");
    else if (callbackResult !== "connected") setConnectionNotice("连接失败，请重试。");
  }, [callbackProvider, callbackResult, loadingPlugins, mode, openPluginModal, plugins]);

  const checkMcpConnection = async (plugin: PluginItem) => {
    setCheckingPluginId(plugin.id);
    setPluginCheck(undefined);
    try {
      const response = await fetch(`/api/plugins/${encodeURIComponent(plugin.id)}`, {
        method: "POST",
        headers: withAuthHeaders(),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "连接测试失败。");
      setPluginCheck({ id: plugin.id, text: `连接成功，发现 ${result.toolCount} 个工具。`, error: false });
    } catch (issue) {
      setPluginCheck({ id: plugin.id, text: issue instanceof Error ? issue.message : "连接测试失败。", error: true });
    } finally {
      setCheckingPluginId(undefined);
    }
  };

  const handleConnectOAuth = async (provider: string) => {
    setConnectionNotice("");
    setConnecting(true);
    try {
      const res = await fetch(`/api/library/connectors/${provider}`, {
        method: "POST",
        headers: withAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ returnTo: "plugins" }),
      });
      const { url, error } = await res.json();
      if (!res.ok || !url) throw new Error(error || "连接失败，请重试。");
      window.location.assign(url);
    } catch (issue) {
      setConnectionNotice(issue instanceof Error ? issue.message : "连接失败，请重试。");
      setConnecting(false);
    }
  };

  const choosePluginPackage = (file?: File) => {
    if (!file || creatingPlugin) return;
    setPluginPackage(undefined);
    if (!PLUGIN_ARCHIVE_EXTENSION.test(file.name)) {
      setUploadError("请选择 .zip、.tgz 或 .tar.gz 压缩包。");
      return;
    }
    if (file.size > 700 * 1024) {
      setUploadError("插件压缩包不能超过 700 KB。");
      return;
    }
    setUploadError("");
    setPluginPackage(file);
  };

  const handleCreateCustomPlugin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addModalKind) return;
    setUploadError("");

    if (addModalKind === "upload") {
      if (!pluginPackage) {
        setUploadError("请先选择插件压缩包。");
        return;
      }
      setCreatingPlugin(true);
      try {
        const fileBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = reject;
          reader.readAsDataURL(pluginPackage);
        });
        const res = await fetch("/api/plugins/upload", {
          method: "POST",
          headers: withAuthHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            fileName: pluginPackage.name,
            fileBase64,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setUploadError(data.error || "上传解析失败");
          return;
        }
        setPlugins((prev) => [data.plugin, ...prev]);
        closeAddPlugin();
        pluginDialog?.onInstalled(data.plugin);
        setNewPluginName("");
        setNewPluginDesc("");
      } catch {
        setUploadError("导入失败，请重试。");
      } finally {
        setCreatingPlugin(false);
      }
      return;
    }

    if (!newPluginName.trim()) return;
    setCreatingPlugin(true);
    try {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: withAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          name: newPluginName.trim(),
          iconDataUrl: pluginIcon,
          description: newPluginDesc.trim(),
          endpointUrl: newPluginEndpoint.trim(),
          authHeader: pluginAuthType === "bearer" ? newPluginAuth.trim() : undefined,
        }),
      });
      const { plugin, error } = await res.json();
      if (res.ok) {
        setPlugins((prev) => [plugin, ...prev]);
        closeAddPlugin();
        pluginDialog?.onInstalled(plugin);
        setNewPluginName("");
        setNewPluginDesc("");
        setNewPluginEndpoint("");
        setNewPluginAuth("");
      } else {
        setUploadError(error || "添加插件失败");
      }
    } catch {
      setUploadError("添加插件失败，请重试。");
    } finally {
      setCreatingPlugin(false);
    }
  };

  const handleUploadSkill = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uploadSkillBase64) {
      setUploadSkillError("请先选择包含 SKILL.md 的压缩包或 Markdown 文件");
      return;
    }
    setSavingSkill(true);
    setUploadSkillError("");
    try {
      const res = await fetch("/api/skills/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: uploadSkillFileName,
          fileBase64: uploadSkillBase64,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setUploadSkillError(data.error || "导入技能失败");
        return;
      }
      setSkills((prev) => [data.skill, ...prev]);
      onSkillAvailabilityChanged?.();
      setUploadSkillOpen(false);
      setUploadSkillFileName("");
      setUploadSkillBase64("");
    } finally {
      setSavingSkill(false);
    }
  };

  const handleDeleteCustomPlugin = async (plugin: PluginItem) => {
    setMenuOpenId(null);
    const res = await fetch(`/api/plugins/${plugin.id}`, { method: "DELETE", headers: withAuthHeaders() });
    if (res.ok) {
      setPlugins((prev) => prev.filter((p) => p.id !== plugin.id));
      if (selectedPlugin?.id === plugin.id) setSelectedPlugin(null);
    }
  };

  const handleToggleSkillEnabled = async (skill: ManagedSkillItem) => {
    const res = await fetch(`/api/skills/${encodeURIComponent(skill.token)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !skill.enabled }),
    });
    if (res.ok) {
      const { skill: updated } = await res.json();
      setSkills((prev) => prev.map((s) => (s.token === updated.token ? updated : s)));
      if (detailSkill?.token === updated.token) setDetailSkill(updated);
      onSkillAvailabilityChanged?.();
    }
  };

  const openSkillDetail = async (skill: ManagedSkillItem) => {
    const res = await fetch(`/api/skills/${encodeURIComponent(skill.token)}`);
    if (res.ok) {
      const { skill: detail } = await res.json();
      setDetailSkill(detail);
      setSkillEditMode(false);
      setDraftSkillName(detail.name);
      setDraftSkillDesc(detail.description);
      setDraftSkillContent(detail.content || "");
    }
  };

  const handleSaveSkillEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detailSkill) return;
    setSavingSkill(true);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(detailSkill.token)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draftSkillName.trim(),
          description: draftSkillDesc.trim(),
          content: draftSkillContent,
        }),
      });
      if (res.ok) {
        const { skill: updated } = await res.json();
        setSkills((prev) => prev.map((s) => (s.token === updated.token ? updated : s)));
        setDetailSkill(updated);
        setSkillEditMode(false);
        onSkillAvailabilityChanged?.();
      }
    } finally {
      setSavingSkill(false);
    }
  };

  const handleCreateSkill = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draftSkillName.trim()) return;
    setSavingSkill(true);
    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draftSkillName.trim(),
          description: draftSkillDesc.trim(),
          content:
            draftSkillContent.trim() ||
            `---\nname: ${draftSkillName.trim()}\ndescription: ${draftSkillDesc.trim() || "自定义技能"}\n---\n\n# ${draftSkillName.trim()}\n\n在这里编写技能指令...`,
        }),
      });
      if (res.ok) {
        const { skill } = await res.json();
        setSkills((prev) => [skill, ...prev]);
        onSkillAvailabilityChanged?.();
        setCreateSkillOpen(false);
        setDraftSkillName("");
        setDraftSkillDesc("");
        setDraftSkillContent("");
      }
    } finally {
      setSavingSkill(false);
    }
  };

  const handleDeleteCustomSkill = async (token: string) => {
    const res = await fetch(`/api/skills/${encodeURIComponent(token)}`, {
      method: "DELETE",
    });
    if (res.ok) {
      setSkills((prev) => prev.filter((s) => s.token !== token));
      onSkillAvailabilityChanged?.();
      if (detailSkill?.token === token) setDetailSkill(null);
    }
  };

  const customSkills = filteredSkills.filter((s) => s.category === "custom");
  const builtinSkills = filteredSkills.filter((s) => s.category === "builtin");

  const addPluginDialog = addModalKind ? (
        <Modal isOpen onClose={closeAddPlugin} closeOnEsc={!creatingPlugin}
          closeOnOverlayClick={!creatingPlugin} isCentered scrollBehavior="inside">
          <ModalOverlay />
          <ModalContent mx={3} p={5} borderRadius="20px" w="calc(100% - 24px)"
            maxW={addModalKind === "upload" ? "520px" : "590px"}
            maxH="calc(100dvh - 32px)" overflowY="auto">
            <div className="flex items-start gap-3">
              <ModalHeader as="h2" p={0} m={0} flex="1" minW={0} fontSize="lg" lineHeight="short">
                {addModalKind === "upload" ? "上传插件压缩包" : "添加自定义 MCP 服务器"}
              </ModalHeader>
              <button
                type="button"
                aria-label="关闭"
                disabled={creatingPlugin}
                onClick={closeAddPlugin}
                className="shrink-0 rounded-lg p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleCreateCustomPlugin} className="mt-4 space-y-4">
              {addModalKind === "upload" ? (
                <>
                  <div
                    className="flex min-h-44 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-300 bg-neutral-50 px-4 py-6 text-center"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (event.dataTransfer.files.length > 1) {
                        setPluginPackage(undefined);
                        setUploadError("每次请选择一个插件压缩包。");
                        return;
                      }
                      choosePluginPackage(event.dataTransfer.files[0]);
                    }}
                  >
                    <Upload aria-hidden="true" className="h-5 w-5 text-neutral-600" />
                    <div className="flex flex-wrap justify-center gap-1 text-sm">
                      <span>{pluginPackage ? pluginPackage.name : "将插件压缩包拖放到此处，或"}</span>
                      <button type="button" disabled={creatingPlugin}
                        onClick={() => pluginPackageInput.current?.click()}
                        className="font-medium text-neutral-900 underline underline-offset-2">
                        {pluginPackage ? "更换文件" : "选择文件"}
                      </button>
                    </div>
                    <p className="text-xs text-neutral-500">.zip、.tgz 或 .tar.gz，最大 700 KB</p>
                    <input ref={pluginPackageInput} type="file" accept=".zip,.tgz,.tar.gz" hidden
                      onChange={(event) => {
                        choosePluginPackage(event.target.files?.[0]);
                        event.target.value = "";
                      }} />
                  </div>

                </>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <label className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-neutral-200 focus-within:ring-2 focus-within:ring-neutral-400">
                      <input type="file" accept="image/png,.png" className="sr-only" aria-label="选择插件图标"
                        disabled={creatingPlugin}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.target.value = "";
                          if (!file) return;
                          if (file.type !== "image/png" || file.size > 10_240) {
                            setUploadError("请选择 10 KB 以内的 PNG 图标。");
                            return;
                          }
                          const reader = new FileReader();
                          reader.onload = () => {
                            setPluginIcon(String(reader.result));
                            setUploadError("");
                          };
                          reader.onerror = () => setUploadError("无法读取图标。");
                          reader.readAsDataURL(file);
                        }} />
                      {pluginIcon ? <img src={pluginIcon} alt="" className="h-full w-full object-cover" /> : <Plus size={16} aria-hidden />}
                    </label>
                    <div>
                      <p className="text-sm font-medium">图标（可选）</p>
                      <p className="text-xs text-neutral-500">PNG，最多 10 KB</p>
                    </div>
                    {pluginIcon && <button type="button" onClick={() => setPluginIcon(undefined)} className="ml-auto text-xs text-neutral-600 hover:underline">移除图标</button>}
                  </div>
                  <div>
                    <label htmlFor="plugin-form-name" className="mb-1 block text-xs font-medium text-neutral-700">名称</label>
                    <input id="plugin-form-name" type="text" required value={newPluginName}
                      onChange={(event) => setNewPluginName(event.target.value)}
                      className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400" />
                  </div>
                  <div>
                    <label htmlFor="plugin-form-description" className="mb-1 block text-xs font-medium text-neutral-700">描述（可选）</label>
                    <input id="plugin-form-description" type="text" value={newPluginDesc}
                      onChange={(event) => setNewPluginDesc(event.target.value)}
                      className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400" />
                  </div>
                  <div>
                    <label htmlFor="plugin-form-server" className="mb-1 block text-xs font-medium text-neutral-700">
                      服务器 URL
                    </label>
                    <input
                      id="plugin-form-server"
                      type="url"
                      required
                      value={newPluginEndpoint}
                      onChange={(e) => setNewPluginEndpoint(e.target.value)}
                      placeholder="https://mcp.example.com/mcp"
                      className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400"
                    />
                  </div>
                  <div>
                    <label htmlFor="plugin-form-auth" className="mb-1 block text-xs font-medium text-neutral-700">
                      身份验证
                    </label>
                    <select id="plugin-form-auth" value={pluginAuthType}
                      onChange={(event) => setPluginAuthType(event.target.value === "bearer" ? "bearer" : "none")}
                      className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-400">
                      <option value="none">无需身份验证</option>
                      <option value="bearer">Bearer Token</option>
                    </select>
                  </div>
                  {pluginAuthType === "bearer" && (
                    <div>
                      <label htmlFor="plugin-form-token" className="mb-1 block text-xs font-medium text-neutral-700">Bearer Token</label>
                      <input id="plugin-form-token" type="password" required autoComplete="off"
                        value={newPluginAuth} onChange={(event) => setNewPluginAuth(event.target.value)}
                        className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400" />
                    </div>
                  )}
                </>
              )}
              {uploadError && <p role="alert" className="text-xs text-red-600">{uploadError}</p>}
              <div className="flex flex-wrap justify-end gap-2 border-t border-neutral-100 pt-3">
                {addModalKind === "upload" && (
                  <button type="button" disabled={creatingPlugin} onClick={() => {
                    setPluginPackage(undefined);
                    setUploadError("");
                    setAddModalKind("mcp");
                  }} className="mr-auto rounded-full border border-neutral-200 px-3 py-1.5 text-sm text-neutral-800 hover:bg-neutral-100">
                    添加自定义 MCP 服务器
                  </button>
                )}
                <button
                  type="button"
                  onClick={closeAddPlugin}
                  className="rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={creatingPlugin || (addModalKind === "upload" && !pluginPackage)}
                  className="rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
                >
                  {creatingPlugin ? "添加中…" : "添加插件"}
                </button>
              </div>
            </form>
          </ModalContent>
        </Modal>
  ) : null;

  if (pluginDialog) return addPluginDialog;

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden bg-white text-[#0d0d0d]">
      {/* 次级左侧栏：自定义（插件 / 技能 / 已安装） */}
      {sidebarOpen && (
        <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-200/80 bg-[#f9f9f9] px-3 py-3">
          <div className="mb-3 flex items-center justify-between px-2">
            <span className="text-sm font-semibold text-neutral-900">自定义</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => searchInputRef.current?.focus()}
                title="搜索"
                className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200/70 hover:text-neutral-800"
              >
                <Search className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                title="收起侧边栏"
                className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200/70 hover:text-neutral-800"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </div>
          </div>

          <nav className="space-y-0.5">
            <button
              type="button"
              onClick={() => onChangeMode("plugins")}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition ${
                mode === "plugins"
                  ? "bg-[#ececec] font-medium text-neutral-950"
                  : "text-neutral-700 hover:bg-neutral-200/60"
              }`}
            >
              <ChatGptPluginsNavIcon size={16} />
              <span>插件</span>
            </button>
            <button
              type="button"
              onClick={() => onChangeMode("skills")}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition ${
                mode === "skills"
                  ? "bg-[#ececec] font-medium text-neutral-950"
                  : "text-neutral-700 hover:bg-neutral-200/60"
              }`}
            >
              <ChatGptSkillsNavIcon size={16} />
              <span>技能</span>
            </button>
          </nav>

          <div className="mt-6 flex min-h-0 flex-1 flex-col">
            <div className="mb-2 px-2.5 text-xs font-medium text-neutral-500">已安装</div>
            <div className="flex-1 space-y-0.5 overflow-y-auto pr-1">
              {installedPlugins.length === 0 ? (
                <div className="px-2.5 py-2 text-xs text-neutral-400">暂无已安装插件</div>
              ) : (
                installedPlugins.map((plugin) => (
                  <button
                    key={plugin.id}
                    type="button"
                    onClick={() => openPluginModal(plugin)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-neutral-700 transition hover:bg-neutral-200/60"
                  >
                    <PluginIcon plugin={plugin} size="sm" />
                    <span className="truncate">{plugin.name}</span>
                    {!plugin.enabled && (
                      <span className="ml-auto text-[10px] text-neutral-400">已停用</span>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        </aside>
      )}

      {/* 右侧主内容区 */}
      <main className="relative flex-1 overflow-y-auto bg-white">
        {!sidebarOpen && (
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            title="展开自定义侧边栏"
            className="absolute left-4 top-4 flex h-8 w-8 items-center justify-center rounded-lg border border-neutral-200 bg-white text-neutral-600 shadow-xs hover:bg-neutral-100"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        )}

        <div className="mx-auto max-w-4xl px-8 py-8">
          {mode === "plugins" ? (
            <>
              {/* 插件 Header */}
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight text-neutral-950">插件</h1>
                  <p className="mt-1 text-sm text-neutral-500">
                    连接插件，让伯仁在你的各类工具中协同工作
                  </p>
                </div>

                <div className="flex items-center gap-2.5">
                  <CustomizeSearch
                    inputRef={searchInputRef}
                    label="搜索插件"
                    value={pluginSearch}
                    onChange={setPluginSearch}
                  />
                  <button
                    type="button"
                    onClick={() => setSettingsOpen(true)}
                    title="插件设置"
                    className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-600 outline-none transition hover:bg-neutral-100"
                  >
                    <Settings className="h-[18px] w-[18px]" />
                  </button>
                  <CustomizeAddMenu>
                    <MenuItem icon={<Sparkles size={16} />} onClick={onCreatePluginWithChat}>创建插件</MenuItem>
                    <MenuItem icon={<FilePlus2 size={16} />} onClick={() => setAddModalKind("upload")}>导入 MCP 插件</MenuItem>
                    <MenuItem icon={<Plug size={16} />} onClick={() => setAddModalKind("mcp")}>添加自定义 MCP 服务器</MenuItem>
                  </CustomizeAddMenu>
                </div>
              </div>

              {/* 筛选标签 */}
              <div className="mt-5 flex flex-wrap items-center gap-2">
                {(
                  [
                    { key: "public", label: "公开" },
                    { key: "all", label: "全部" },
                    { key: "installed", label: `已安装 (${installedPlugins.length})` },
                    { key: "oauth", label: "OAuth 连接器" },
                    { key: "mcp", label: "MCP" },
                    { key: "api", label: "API / Webhook" },
                    { key: "builtin", label: "内置工具" },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => {
                      setPluginFilter(tab.key);
                      setFocusedCategory(null);
                    }}
                    className={`rounded-full px-3.5 py-1 text-xs font-medium transition ${
                      pluginFilter === tab.key && !focusedCategory
                        ? "bg-neutral-200/80 text-neutral-950"
                        : "text-neutral-600 hover:bg-neutral-100"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
                {focusedCategory && (
                  <button
                    type="button"
                    onClick={() => setFocusedCategory(null)}
                    className="rounded-full bg-neutral-900 px-3 py-1 text-xs font-medium text-white"
                  >
                    分类：{CATEGORY_SECTIONS.find((c) => c.key === focusedCategory)?.label} ×
                  </button>
                )}
              </div>

              {/* 插件列表 */}
              {loadingPlugins ? (
                <div className="mt-12 text-center text-sm text-neutral-400">正在加载插件目录...</div>
              ) : (
                <div className="mt-8 space-y-10 pb-12">
                  {[...CATEGORY_SECTIONS].sort((a, b) => Number(b.key === "custom") - Number(a.key === "custom")).map((section) => {
                    const items = filteredPlugins.filter((p) => p.category === section.key);
                    if (items.length === 0) return null;

                    return (
                      <section key={section.key}>
                        <button
                          type="button"
                          onClick={() =>
                            setFocusedCategory(
                              focusedCategory === section.key ? null : section.key,
                            )
                          }
                          className="mb-3 flex items-center gap-1 text-sm font-medium text-neutral-800 hover:text-neutral-950"
                        >
                          <span>{section.label}</span>
                          <ChevronRight className="h-4 w-4 text-neutral-400" />
                        </button>

                        <div className="grid grid-cols-1 gap-x-8 gap-y-2 md:grid-cols-2">
                          {items.map((plugin) => (
                            <div
                              key={plugin.id}
                              className="group relative flex items-center justify-between rounded-xl px-2 py-2.5 transition hover:bg-neutral-100/80"
                            >
                              <button
                                type="button"
                                onClick={() => openPluginModal(plugin)}
                                className="flex min-w-0 flex-1 items-center gap-3.5 text-left"
                              >
                                <PluginIcon plugin={plugin} size="md" />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="truncate text-sm font-medium text-neutral-900">
                                      {plugin.name}
                                    </span>
                                    {plugin.installed && !plugin.enabled && (
                                      <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-600">
                                        已停用
                                      </span>
                                    )}
                                  </div>
                                  <p className="truncate text-xs text-neutral-500">
                                    {plugin.description}
                                  </p>
                                </div>
                              </button>

                              <div className="relative ml-2 shrink-0">
                                {plugin.installed ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setMenuOpenId(menuOpenId === plugin.id ? null : plugin.id)
                                    }
                                    title="管理插件"
                                    className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-neutral-200/80 hover:text-neutral-900"
                                  >
                                    <MoreHorizontal className="h-4 w-4" />
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => void handlePluginInstallToggle(plugin, true)}
                                    title="安装插件"
                                    className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-neutral-200/80 hover:text-neutral-900"
                                  >
                                    <Plus className="h-4 w-4" />
                                  </button>
                                )}

                                {menuOpenId === plugin.id && (
                                  <div className="absolute right-0 top-9 z-20 w-40 rounded-xl border border-neutral-200 bg-white py-1 shadow-lg">
                                    <button
                                      type="button"
                                      onClick={() => openPluginModal(plugin)}
                                      className="flex w-full items-center px-3 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-100"
                                    >
                                      配置与详情
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setMenuOpenId(null);
                                        void handlePluginEnableToggle(plugin, !plugin.enabled);
                                      }}
                                      className="flex w-full items-center px-3 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-100"
                                    >
                                      {plugin.enabled ? "停用插件" : "启用插件"}
                                    </button>
                                    {plugin.isCustom ? (
                                      <button
                                        type="button"
                                        onClick={() => void handleDeleteCustomPlugin(plugin)}
                                        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50"
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                        删除插件
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => void handlePluginInstallToggle(plugin, false)}
                                        className="flex w-full items-center px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50"
                                      >
                                        卸载插件
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>
                    );
                  })}

                  {filteredPlugins.length === 0 && (
                    <div className="py-12 text-center text-sm text-neutral-400">
                      没有找到匹配的插件
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              {/* 技能 Header */}
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight text-neutral-950">技能</h1>
                  <p className="mt-1 text-sm text-neutral-500">
                    用于扩展伯仁功能的说明
                  </p>
                </div>

                <div className="flex items-center gap-2.5">
                  <CustomizeSearch
                    inputRef={searchInputRef}
                    label="搜索技能"
                    value={skillSearch}
                    onChange={setSkillSearch}
                  />
                  <CustomizeAddMenu>
                    <MenuItem icon={<Sparkles size={16} />} onClick={onCreateSkillWithChat}>通过聊天创建</MenuItem>
                    <MenuItem icon={<Edit3 size={16} />} onClick={() => {
                      setDraftSkillName("");
                      setDraftSkillDesc("");
                      setDraftSkillContent("");
                      setCreateSkillOpen(true);
                    }}>使用编辑器创建</MenuItem>
                    <MenuItem icon={<Upload size={16} />} onClick={() => {
                      setUploadSkillFileName("");
                      setUploadSkillBase64("");
                      setUploadSkillError("");
                      setUploadSkillOpen(true);
                    }}>从电脑上传</MenuItem>
                  </CustomizeAddMenu>
                </div>
              </div>

              <div className="mt-5 flex items-center gap-2">
                {(
                  [
                    { key: "enabled", label: "已启用" },
                    { key: "all", label: "全部" },
                    {
                      key: "custom",
                      label: `自定义 (${skills.filter((s) => s.category === "custom").length})`,
                    },
                    {
                      key: "builtin",
                      label: `内置技能 (${skills.filter((s) => s.category === "builtin").length})`,
                    },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setSkillFilter(tab.key)}
                    className={`rounded-full px-3.5 py-1 text-xs font-medium transition ${
                      skillFilter === tab.key
                        ? "bg-neutral-200/80 text-neutral-950"
                        : "text-neutral-600 hover:bg-neutral-100"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {loadingSkills ? (
                <div className="mt-12 text-center text-sm text-neutral-400">正在加载技能列表...</div>
              ) : (
                <div className="mt-6 space-y-2 pb-12">
                  {filteredSkills.map((skill) => (
                    <SkillRow
                      key={skill.token}
                      skill={skill}
                      menuOpen={skillMenuOpenToken === skill.token}
                      onToggleMenu={() =>
                        setSkillMenuOpenToken(
                          skillMenuOpenToken === skill.token ? null : skill.token,
                        )
                      }
                      onTry={() => {
                        setSkillMenuOpenToken(null);
                        onTrySkill?.(skill.name);
                      }}
                      onOpen={() => {
                        setSkillMenuOpenToken(null);
                        void openSkillDetail(skill);
                      }}
                      onUninstall={() => {
                        setSkillMenuOpenToken(null);
                        if (skill.category === "custom") {
                          void handleDeleteCustomSkill(skill.token);
                        } else {
                          void handleToggleSkillEnabled(skill);
                        }
                      }}
                    />
                  ))}

                  {filteredSkills.length === 0 && (
                    <div className="py-12 text-center text-sm text-neutral-400">
                      没有找到匹配的技能
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {/* 插件详情与配置弹窗 */}
      {selectedPlugin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3.5">
                <PluginIcon plugin={selectedPlugin} size="lg" />
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-semibold text-neutral-900">
                      {selectedPlugin.name}
                    </h3>
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600">
                      {getPluginSourceLabel(selectedPlugin)} · {KIND_LABELS[selectedPlugin.kind]}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    {selectedPlugin.author || "未知来源"} · v{selectedPlugin.version || "1.0.0"}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedPlugin(null)}
                className="rounded-lg p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="mt-4 text-sm leading-relaxed text-neutral-600">
              {selectedPlugin.longDescription || selectedPlugin.description}
            </p>

            {selectedPlugin.capabilities && selectedPlugin.capabilities.length > 0 && (
              <div className="mt-4 rounded-xl bg-neutral-50 p-3.5">
                <div className="mb-2 text-xs font-medium text-neutral-500">
                  {selectedPlugin.connectorProvider || getPluginSourceLabel(selectedPlugin) === "内置工具" ? "支持的能力" : "目录中的能力说明"}
                </div>
                <ul className="space-y-1.5">
                  {selectedPlugin.capabilities.map((cap) => (
                    <li key={cap} className="flex items-center gap-2 text-xs text-neutral-700">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                      <span>{cap}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {getPluginSourceLabel(selectedPlugin) === "预置目录" && (
              <p className="mt-3 text-xs text-neutral-600">此条目来自预置目录，当前暂无聊天接入。</p>
            )}
            {selectedPlugin.isCustom && selectedPlugin.kind === "mcp" && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="xs" variant="outline" isDisabled={!selectedPlugin.enabled || !selectedPlugin.installed || Boolean(checkingPluginId)}
                  isLoading={checkingPluginId === selectedPlugin.id} loadingText="正在测试"
                  onClick={() => void checkMcpConnection(selectedPlugin)}>
                  测试连接
                </Button>
                {pluginCheck?.id === selectedPlugin.id && (
                  <p role="status" className={pluginCheck.error ? "text-xs text-red-700" : "text-xs text-emerald-700"}>
                    {pluginCheck.text}
                  </p>
                )}
              </div>
            )}

            {selectedPlugin.connectorProvider && (
              <div className="mt-4 flex items-center justify-between rounded-xl border border-neutral-200 px-3.5 py-2.5">
                <div className="text-xs">
                  <div className="font-medium text-neutral-800">OAuth 账号授权</div>
                  <div className="text-neutral-500">
                    {connectorStatus?.connected
                      ? "已授权连接云盘文件"
                      : connectorStatus?.configured === false
                      ? "服务端暂未配置 OAuth 密钥"
                      : "点击连接账号以读取云端文件"}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={connecting || connectorStatus?.configured !== true}
                  onClick={() => void handleConnectOAuth(selectedPlugin.connectorProvider!)}
                  className="rounded-full bg-neutral-900 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-40"
                >
                  {connecting ? "正在打开授权…" : connectorStatus?.connected ? "重新授权" : "连接账号"}
                </button>
              </div>
            )}

            {connectionNotice && <p role="status" className="mt-2 text-xs text-neutral-600">{connectionNotice}</p>}

            {selectedPlugin.isCustom && <form onSubmit={handleSavePluginConfig} className="mt-4 space-y-3.5">
              {selectedPlugin.installed && (
                <div className="flex items-center justify-between rounded-xl border border-neutral-200 px-3.5 py-2.5">
                  <span className="text-sm font-medium text-neutral-800">启用状态</span>
                  <button
                    type="button"
                    role="switch"
                    aria-label="启用插件"
                    aria-checked={selectedPlugin.enabled}
                    onClick={() =>
                      void handlePluginEnableToggle(selectedPlugin, !selectedPlugin.enabled)
                    }
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${
                      selectedPlugin.enabled ? "bg-neutral-900" : "bg-neutral-300"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
                        selectedPlugin.enabled ? "translate-x-4" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </div>
              )}

              {(selectedPlugin.configSchema || []).map((field) => (
                <div key={field.key}>
                  <label className="mb-1 block text-xs font-medium text-neutral-700">
                    {field.label}
                  </label>
                  {field.type === "boolean" ? (
                    <label className="flex items-center gap-2 text-sm text-neutral-700">
                      <input
                        type="checkbox"
                        checked={Boolean(configDraft[field.key])}
                        onChange={(e) =>
                          setConfigDraft((prev) => ({ ...prev, [field.key]: e.target.checked }))
                        }
                        className="rounded border-neutral-300"
                      />
                      <span>开启</span>
                    </label>
                  ) : (
                    <input
                      type={field.type === "password" ? "password" : "text"}
                      value={String(configDraft[field.key] ?? "")}
                      onChange={(e) =>
                        setConfigDraft((prev) => ({ ...prev, [field.key]: e.target.value }))
                      }
                      placeholder={field.type === "password" ? "填写新凭据，留空保留原值" : field.placeholder}
                      className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400"
                    />
                  )}
                </div>
              ))}

              <div className="flex items-center justify-end gap-2 pt-2">
                {selectedPlugin.isCustom && (selectedPlugin.installed ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void handlePluginInstallToggle(selectedPlugin, false)}
                      className="rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
                    >
                      卸载
                    </button>
                    <button
                      type="submit"
                      disabled={savingConfig}
                      className="rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
                    >
                      {savingConfig ? "保存中..." : "保存配置"}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handlePluginInstallToggle(selectedPlugin, true)}
                    className="rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-800"
                  >
                    安装插件
                  </button>
                ))}
              </div>
            </form>}
          </div>
        </div>
      )}

      {/* 插件设置弹窗（对齐 ChatGPT /settings/plugins-settings） */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-neutral-900">插件设置</h3>
                <p className="mt-0.5 text-xs text-neutral-500">
                  管理插件、关联账户和权限
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="rounded-lg p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 bg-neutral-50/70 px-4 py-3">
              <div>
                <div className="text-sm font-medium text-neutral-900">默认权限</div>
                <div className="text-xs text-neutral-500">
                  选择插件默认在什么情况下征求你的同意
                </div>
              </div>
              <select
                value={defaultPermission}
                onChange={(e) => setDefaultPermission(e.target.value as any)}
                className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-800 outline-none"
              >
                <option value="low_risk">允许使用低风险工具</option>
                <option value="always_ask">每次询问</option>
                <option value="always_allow">始终允许</option>
              </select>
            </div>

            <div className="relative mt-4">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
              <input
                type="text"
                value={settingsSearch}
                onChange={(e) => setSettingsSearch(e.target.value)}
                placeholder="搜索已安装的插件"
                className="h-9 w-full rounded-xl border border-neutral-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-neutral-400"
              />
            </div>

            <div className="mt-4 flex-1 space-y-1 overflow-y-auto pr-1">
              {installedPlugins
                .filter((p) => {
                  const q = settingsSearch.trim().toLowerCase();
                  return (
                    !q ||
                    p.name.toLowerCase().includes(q) ||
                    p.description.toLowerCase().includes(q)
                  );
                })
                .map((plugin) => (
                  <div
                    key={plugin.id}
                    className="flex items-center justify-between rounded-xl px-2 py-2.5 hover:bg-neutral-50"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <PluginIcon plugin={plugin} size="md" />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-neutral-900">
                          {plugin.name}
                        </div>
                        <div className="truncate text-xs text-neutral-500">
                          {plugin.description}
                        </div>
                      </div>
                    </div>
                    <div className="ml-3 flex shrink-0 items-center gap-2">
                      <select
                        value={pluginPermissions[plugin.id] || defaultPermission}
                        onChange={(e) =>
                          setPluginPermissions((prev) => ({
                            ...prev,
                            [plugin.id]: e.target.value,
                          }))
                        }
                        className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-700 outline-none"
                      >
                        <option value="low_risk">允许使用低风险工具</option>
                        <option value="always_ask">每次询问</option>
                        <option value="always_allow">始终允许</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          setSettingsOpen(false);
                          openPluginModal(plugin);
                        }}
                        className="rounded-lg border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100"
                      >
                        配置
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      {addPluginDialog}

      {/* 技能详情与编辑弹窗 */}
      {detailSkill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-neutral-100 text-neutral-800">
                  <Sparkles className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-neutral-900">
                    {detailSkill.name}
                  </h3>
                  <p className="text-xs text-neutral-500">
                    {detailSkill.category === "custom" ? "自定义技能" : "内置技能"} ·{" "}
                    {detailSkill.token}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDetailSkill(null)}
                className="rounded-lg p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {skillEditMode ? (
              <form
                onSubmit={handleSaveSkillEdit}
                className="mt-4 flex min-h-0 flex-1 flex-col gap-3"
              >
                <div>
                  <label className="mb-1 block text-xs font-medium text-neutral-700">名称</label>
                  <input
                    type="text"
                    required
                    value={draftSkillName}
                    onChange={(e) => setDraftSkillName(e.target.value)}
                    className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-neutral-700">描述</label>
                  <input
                    type="text"
                    value={draftSkillDesc}
                    onChange={(e) => setDraftSkillDesc(e.target.value)}
                    className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400"
                  />
                </div>
                <div className="flex min-h-0 flex-1 flex-col">
                  <label className="mb-1 block text-xs font-medium text-neutral-700">
                    SKILL.md 指令内容
                  </label>
                  <textarea
                    value={draftSkillContent}
                    onChange={(e) => setDraftSkillContent(e.target.value)}
                    rows={10}
                    className="min-h-[200px] w-full flex-1 rounded-lg border border-neutral-200 p-3 font-mono text-xs outline-none focus:border-neutral-400"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setSkillEditMode(false)}
                    className="rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={savingSkill}
                    className="rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
                  >
                    {savingSkill ? "保存中..." : "保存更改"}
                  </button>
                </div>
              </form>
            ) : (
              <>
                <p className="mt-3 text-sm text-neutral-600">{detailSkill.description}</p>
                <div className="mt-4 flex-1 overflow-y-auto rounded-xl border border-neutral-200 bg-neutral-50 p-4">
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-neutral-500">
                    <FileText className="h-3.5 w-3.5" />
                    <span>SKILL.md</span>
                  </div>
                  <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-neutral-800">
                    {detailSkill.content}
                  </pre>
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <div>
                    {detailSkill.category === "custom" && (
                      <button
                        type="button"
                        onClick={() => void handleDeleteCustomSkill(detailSkill.token)}
                        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
                      >
                        <Trash2 className="h-4 w-4" />
                        <span>删除</span>
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {detailSkill.category === "custom" && (
                      <button
                        type="button"
                        onClick={() => setSkillEditMode(true)}
                        className="flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                        <span>编辑</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleToggleSkillEnabled(detailSkill)}
                      className="rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-800"
                    >
                      {detailSkill.enabled ? "停用技能" : "启用技能"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 新建技能弹窗 */}
      {createSkillOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-neutral-900">新建自定义技能</h3>
              <button
                type="button"
                onClick={() => setCreateSkillOpen(false)}
                className="rounded-lg p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleCreateSkill} className="mt-4 space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-700">技能名称</label>
                <input
                  type="text"
                  required
                  value={draftSkillName}
                  onChange={(e) => setDraftSkillName(e.target.value)}
                  placeholder="例如：周报生成器"
                  className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-700">简短描述</label>
                <input
                  type="text"
                  value={draftSkillDesc}
                  onChange={(e) => setDraftSkillDesc(e.target.value)}
                  placeholder="描述该技能的使用场景与能力"
                  className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-700">
                  技能指令 (Markdown)
                </label>
                <textarea
                  value={draftSkillContent}
                  onChange={(e) => setDraftSkillContent(e.target.value)}
                  rows={6}
                  placeholder="输入系统指令、步骤规范或输出模板..."
                  className="w-full rounded-lg border border-neutral-200 p-3 font-mono text-xs outline-none focus:border-neutral-400"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setCreateSkillOpen(false)}
                  className="rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={savingSkill}
                  className="rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
                >
                  {savingSkill ? "创建中..." : "创建技能"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* 从电脑上传技能弹窗 */}
      {uploadSkillOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-neutral-900">从电脑上传技能</h3>
              <button
                type="button"
                onClick={() => setUploadSkillOpen(false)}
                className="rounded-lg p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleUploadSkill} className="mt-4 space-y-4">
              <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-neutral-300 bg-neutral-50 px-4 py-6 text-center transition hover:border-neutral-400 hover:bg-neutral-100/70">
                <Upload className="mb-2 h-5 w-5 text-neutral-500" />
                <span className="text-xs font-medium text-neutral-700">
                  {uploadSkillFileName || "选择包含 SKILL.md 的 .zip 压缩包或 .md 文件"}
                </span>
                <input
                  type="file"
                  accept=".zip,.md"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      setUploadSkillFileName(f.name);
                      setUploadSkillError("");
                      const reader = new FileReader();
                      reader.onload = () => {
                        if (typeof reader.result === "string") {
                          setUploadSkillBase64(reader.result);
                        }
                      };
                      reader.readAsDataURL(f);
                    }
                  }}
                />
              </label>
              {uploadSkillError && (
                <p className="text-xs text-red-600">{uploadSkillError}</p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setUploadSkillOpen(false)}
                  className="rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={savingSkill}
                  className="rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
                >
                  {savingSkill ? "导入中..." : "导入技能"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function CustomizeSearch({ inputRef, label, value, onChange }: {
  inputRef: React.RefObject<HTMLInputElement>;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative w-52 max-w-full">
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-neutral-500" aria-hidden="true">
        <Search size={16} strokeWidth={1.75} />
      </span>
      <input ref={inputRef} type="search" aria-label={label} placeholder={label} value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-full border border-neutral-200 bg-white pl-9 pr-3 text-sm text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-neutral-400" />
    </div>
  );
}

function CustomizeAddMenu({ children }: { children: React.ReactNode }) {
  return (
    <Menu placement="bottom-end" isLazy>
      <MenuButton as={Button} h="36px" px={4} borderRadius="full" bg="#171717" color="white"
        fontSize="14px" fontWeight="500" rightIcon={<ChevronDown size={14} />}
        _hover={{ bg: "#303030" }} _active={{ bg: "#303030" }} _expanded={{ bg: "#303030" }}>
        添加
      </MenuButton>
      <MenuList p={1.5} borderRadius="xl" minW="220px" boxShadow="lg">{children}</MenuList>
    </Menu>
  );
}

function SkillRow({
  skill,
  menuOpen,
  onToggleMenu,
  onTry,
  onOpen,
  onUninstall,
}: {
  skill: ManagedSkillItem;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onTry: () => void;
  onOpen: () => void;
  onUninstall: () => void;
}) {
  return (
    <div className="group relative flex items-start justify-between rounded-xl px-3 py-3 transition hover:bg-neutral-100/70">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-start gap-3.5 text-left"
      >
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neutral-100 text-neutral-800">
          <ChatGptSkillsNavIcon size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-neutral-900">{skill.name}</span>
            {!skill.enabled && (
              <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-600">
                已停用
              </span>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-neutral-500">
            {skill.description}
          </p>
        </div>
      </button>

      <div className="relative ml-3 shrink-0">
        <button
          type="button"
          onClick={onToggleMenu}
          title="更多操作"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-neutral-200/80 hover:text-neutral-900"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-9 z-20 w-36 rounded-xl border border-neutral-200 bg-white py-1 shadow-lg">
            <button
              type="button"
              onClick={onTry}
              disabled={!skill.enabled}
              className="flex w-full items-center px-3 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-100 disabled:text-neutral-400"
            >
              在聊天中使用
            </button>
            <button
              type="button"
              onClick={onOpen}
              className="flex w-full items-center px-3 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-100"
            >
              设置
            </button>
            <button
              type="button"
              onClick={onUninstall}
              className="flex w-full items-center px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50"
            >
              {skill.category === "custom" ? "卸载" : skill.enabled ? "停用" : "启用"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
