import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Flex,
  FormControl,
  FormLabel,
  HStack,
  IconButton,
  Input,
  InputGroup,
  InputLeftElement,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  Select,
  SimpleGrid,
  Text,
  Textarea,
  Tooltip,
  useToast,
  VStack,
} from "@chakra-ui/react";
import {
  ChevronDown,
  Cloud,
  Database,
  Download,
  Laptop,
  LayoutGrid,
  Link2,
  List,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Server,
  Trash2,
} from "lucide-react";
import { AppDialog } from "../ui";
import BoreLoading from "../ui/BoreLoading";
import WorkspaceSidebar, {
  SIDEBAR_ICON_SIZE,
  SidebarActionButton,
  SidebarHeaderIconButton,
  SidebarSectionHeader,
  sidebarNavItemProps,
} from "./WorkspaceSidebar";
import { deviceDisplayName } from "@/shared/localDevice/displayName";
import {
  getCloudHostStatusMeta,
  type CloudHostStatus,
} from "@shared/sandbox/cloudHostStatus";
import { withAuthHeaders } from "@features/auth/client/authClient";

type PairedDeviceItem = {
  remark?: string;
  deviceId: string;
  name: string;
  platform: string;
  online: boolean;
  browserSupported?: boolean;
};

type CloudHostInfo = {
  status: CloudHostStatus;
  sandboxId?: string;
  host?: string;
  updatedAt?: string;
};

type InfraResourceKind = "ssh" | "database";
type SshAuthType = "password" | "privateKey";
type DatabaseType = "postgresql" | "mysql" | "mongodb" | "redis";

type InfraResourceItem = {
  resourceId: string;
  kind: InfraResourceKind;
  name: string;
  host: string;
  port: number;
  username?: string;
  authType?: SshAuthType;
  dbType?: DatabaseType;
  database?: string;
  remark?: string;
  hasSecret: boolean;
  lastTestStatus?: "ok" | "error";
  lastTestMessage?: string;
  lastTestedAt?: string;
};

type ResourceCategory = "all" | "cloud" | "local" | "ssh" | "database";

type UnifiedRow = {
  id: string;
  category: Exclude<ResourceCategory, "all">;
  name: string;
  subtitle: string;
  statusLabel: string;
  statusDotColor: string;
  rawDevice?: PairedDeviceItem;
  rawResource?: InfraResourceItem;
};

const DB_DEFAULT_PORTS: Record<DatabaseType, number> = {
  postgresql: 5432,
  mysql: 3306,
  mongodb: 27017,
  redis: 6379,
};

const DB_LABELS: Record<DatabaseType, string> = {
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  mongodb: "MongoDB",
  redis: "Redis",
};

const CATEGORY_LABELS: Record<ResourceCategory, string> = {
  all: "全部",
  cloud: "云服务器",
  local: "本地设备",
  ssh: "服务器 (SSH)",
  database: "数据库",
};

type ResourceFormState = {
  resourceId?: string;
  kind: InfraResourceKind;
  name: string;
  host: string;
  port: string;
  username: string;
  authType: SshAuthType;
  dbType: DatabaseType;
  database: string;
  remark: string;
  secret: string;
  hasSecret?: boolean;
};

function createEmptyForm(kind: InfraResourceKind): ResourceFormState {
  return {
    kind,
    name: "",
    host: "",
    port: kind === "ssh" ? "22" : "5432",
    username: kind === "ssh" ? "root" : "",
    authType: "password",
    dbType: "postgresql",
    database: "",
    remark: "",
    secret: "",
    hasSecret: false,
  };
}

export default function DevicesDirectoryView() {
  const toast = useToast();
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [category, setCategory] = useState<ResourceCategory>("all");
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [searchQuery, setSearchQuery] = useState("");

  // 云服务器
  const [cloudHost, setCloudHost] = useState<CloudHostInfo | null>(null);
  const [loadingCloud, setLoadingCloud] = useState(true);

  // 本地设备
  const [devices, setDevices] = useState<PairedDeviceItem[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [listError, setListError] = useState("");
  const [remarkTarget, setRemarkTarget] = useState<PairedDeviceItem | null>(null);
  const [remark, setRemark] = useState("");
  const [savingRemark, setSavingRemark] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<PairedDeviceItem | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [pairDialogOpen, setPairDialogOpen] = useState(false);
  const [pairDialogTitle, setPairDialogTitle] = useState("连接本地设备");
  const [pairMessage, setPairMessage] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [pairingLocal, setPairingLocal] = useState(false);

  // SSH & 数据库
  const [resources, setResources] = useState<InfraResourceItem[]>([]);
  const [loadingResources, setLoadingResources] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [resourceForm, setResourceForm] = useState<ResourceFormState | null>(null);
  const [savingResource, setSavingResource] = useState(false);
  const [deleteResourceTarget, setDeleteResourceTarget] =
    useState<InfraResourceItem | null>(null);
  const [deletingResourceId, setDeletingResourceId] = useState<string | null>(null);

  const loadCloudHost = useCallback(async (background = false) => {
    if (!background) setLoadingCloud(true);
    try {
      const response = await fetch("/api/core/sandbox/hostStatus", {
        headers: withAuthHeaders({}),
      });
      if (!response.ok) throw new Error();
      const data = (await response.json()) as { host?: CloudHostInfo };
      setCloudHost(data.host || { status: "ready" });
    } catch {
      setCloudHost((prev) => prev || { status: "stopped" });
    } finally {
      setLoadingCloud(false);
    }
  }, []);

  const loadDevices = useCallback(async (background = false) => {
    if (!background) setLoadingDevices(true);
    try {
      const response = await fetch("/api/core/localDevice/manage", {
        headers: withAuthHeaders({}),
      });
      if (!response.ok) throw new Error();
      const data = (await response.json()) as { devices?: PairedDeviceItem[] };
      setDevices(Array.isArray(data.devices) ? data.devices : []);
      setListError("");
    } catch {
      setListError("设备列表加载失败，请刷新重试。");
    } finally {
      setLoadingDevices(false);
    }
  }, []);

  const loadResources = useCallback(async (background = false) => {
    if (!background) setLoadingResources(true);
    try {
      const response = await fetch("/api/core/resources/manage", {
        headers: withAuthHeaders({}),
      });
      if (!response.ok) throw new Error();
      const data = (await response.json()) as { resources?: InfraResourceItem[] };
      setResources(Array.isArray(data.resources) ? data.resources : []);
    } catch {
      // ignore
    } finally {
      setLoadingResources(false);
    }
  }, []);

  const refreshAll = useCallback(
    (background = false) => {
      void loadCloudHost(background);
      void loadDevices(background);
      void loadResources(background);
    },
    [loadCloudHost, loadDevices, loadResources]
  );

  useEffect(() => {
    refreshAll(false);
    const timer = window.setInterval(() => {
      void loadDevices(true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshAll, loadDevices]);

  const cloudMeta = getCloudHostStatusMeta(cloudHost?.status);
  const sshResources = useMemo(() => resources.filter((r) => r.kind === "ssh"), [resources]);
  const dbResources = useMemo(() => resources.filter((r) => r.kind === "database"), [resources]);

  const allRows = useMemo<UnifiedRow[]>(() => {
    const rows: UnifiedRow[] = [];

    rows.push({
      id: "cloud-host-default",
      category: "cloud",
      name: "我的云服务器",
      subtitle: cloudHost?.sandboxId
        ? `内置云端主机 · ${cloudHost.sandboxId}`
        : "内置云端执行环境",
      statusLabel: cloudMeta.label,
      statusDotColor: cloudMeta.dotColor,
    });

    for (const device of devices) {
      rows.push({
        id: `device:${device.deviceId}`,
        category: "local",
        name: deviceDisplayName(device),
        subtitle: `本地设备${device.browserSupported ? " · 支持本地浏览器" : ""}`,
        statusLabel: device.online ? "在线" : "离线",
        statusDotColor: device.online ? "#22c55e" : "#a1a1aa",
        rawDevice: device,
      });
    }

    for (const item of resources) {
      const isSsh = item.kind === "ssh";
      const endpoint = isSsh
        ? `SSH · ${item.username ? `${item.username}@` : ""}${item.host}:${item.port}`
        : `${item.dbType ? DB_LABELS[item.dbType] : "数据库"} · ${item.host}:${item.port}${item.database ? `/${item.database}` : ""}`;
      rows.push({
        id: `resource:${item.resourceId}`,
        category: item.kind,
        name: item.name,
        subtitle: item.remark ? `${endpoint} · ${item.remark}` : endpoint,
        statusLabel: item.lastTestMessage
          ? item.lastTestStatus === "ok"
            ? "已连通"
            : "连接异常"
          : "未检测",
        statusDotColor:
          item.lastTestStatus === "ok"
            ? "#22c55e"
            : item.lastTestStatus === "error"
              ? "#ef4444"
              : "#a1a1aa",
        rawResource: item,
      });
    }

    return rows;
  }, [cloudHost, cloudMeta, devices, resources]);

  const visibleRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allRows.filter((row) => {
      if (category !== "all" && row.category !== category) return false;
      if (!q) return true;
      return (
        row.name.toLowerCase().includes(q) ||
        row.subtitle.toLowerCase().includes(q) ||
        row.statusLabel.toLowerCase().includes(q)
      );
    });
  }, [allRows, category, searchQuery]);

  // 本地设备操作
  const saveRemark = async (device: PairedDeviceItem) => {
    setSavingRemark(true);
    try {
      const response = await fetch("/api/core/localDevice/manage", {
        method: "POST",
        headers: withAuthHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          action: "remark",
          deviceId: device.deviceId,
          remark: remark.trim(),
        }),
      });
      if (!response.ok) throw new Error();
      setRemarkTarget(null);
      toast({ title: "备注已更新", status: "success" });
      await loadDevices(true);
    } catch {
      toast({ title: "备注保存失败，请重试", status: "error" });
    } finally {
      setSavingRemark(false);
    }
  };

  const revokeDeviceItem = async (device: PairedDeviceItem) => {
    setRevokingId(device.deviceId);
    try {
      const response = await fetch("/api/core/localDevice/manage", {
        method: "POST",
        headers: withAuthHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ action: "revoke", deviceId: device.deviceId }),
      });
      if (!response.ok) throw new Error();
      setRevokeTarget(null);
      if (remarkTarget?.deviceId === device.deviceId) setRemarkTarget(null);
      toast({ title: `已移除「${deviceDisplayName(device)}」`, status: "success" });
      await loadDevices(true);
    } catch {
      toast({ title: "移除设备失败，请重试", status: "error" });
    } finally {
      setRevokingId(null);
    }
  };

  const createInvite = async () => {
    const response = await fetch("/api/core/localDevice/invite", {
      method: "POST",
      headers: withAuthHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ action: "create" }),
    });
    if (!response.ok) throw new Error("无法创建邀请，请重试。");
    return (await response.json()).code as string;
  };

  const inviteOtherDevice = async () => {
    setPairDialogTitle("添加其他电脑");
    setInviteLink("");
    setPairMessage("正在生成授权链接…");
    setPairDialogOpen(true);
    try {
      const code = await createInvite();
      setInviteLink(window.location.origin + "/account/devices#connect=" + code);
      setPairMessage(
        "在另一台电脑打开伯仁连接器，选择「添加授权」并粘贴链接。链接 10 分钟内有效。"
      );
    } catch {
      setPairMessage("无法创建邀请，请重试。");
    }
  };

  const handlePairLocalBridge = async () => {
    setPairDialogTitle("连接此电脑");
    setInviteLink("");
    setPairMessage("正在联系伯仁连接器…");
    setPairDialogOpen(true);
    setPairingLocal(true);
    try {
      const status = await fetch("http://127.0.0.1:13005/status")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (status?.inviteDecision || !status) {
        if (
          status &&
          devices.some(
            (device) =>
              device.deviceId === status.deviceId ||
              status.deviceIds?.includes(device.deviceId)
          )
        ) {
          setPairMessage("此电脑已在设备列表中。");
          return;
        }
        const code = await createInvite();
        setPairMessage("请在本机的伯仁连接器窗口确认账号授权。");
        const result = await fetch("http://127.0.0.1:13005/invite", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, waitForDecision: true }),
        });
        if (result.status !== 404) {
          if (!result.ok) {
            throw new Error(
              result.status === 403
                ? "本机授权未完成，可以重试连接。"
                : "连接器未能完成邀请，请重试。"
            );
          }
          setPairMessage("连接器已接受请求，正在刷新设备列表…");
          await loadDevices();
          toast({ title: "已连接此电脑", status: "success" });
          setPairDialogOpen(false);
          return;
        }
      }
      const bridgeRes = await fetch("http://127.0.0.1:13005/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: crypto.randomUUID() }),
      });
      if (!bridgeRes.ok) {
        const reason = (await bridgeRes.text()).trim();
        const hints: Record<string, string> = {
          no_pending_pairing: "配对已过期，请在连接器中重新连接后重试",
          origin_not_allowed: "连接器的平台地址与当前网页不同，请检查连接设置",
          invalid_request: "网页与连接器的配对协议不兼容，请更新连接器",
          local_pairing_rejected: "本机配对已取消",
        };
        throw new Error(hints[reason] || `本机连接器配对失败（HTTP ${bridgeRes.status}）`);
      }
      const bridgeData = (await bridgeRes.json()) as {
        deviceId?: string;
        pairingId?: string;
        confirmationCode?: string;
        name?: string;
      };
      if (bridgeData.deviceId) {
        await loadDevices();
        toast({ title: "本机电脑已绑定", status: "success" });
        setPairDialogOpen(false);
        return;
      }
      if (!bridgeData.pairingId || !bridgeData.confirmationCode) {
        throw new Error("本机配对桥返回格式异常");
      }
      const confirmRes = await fetch("/api/core/localDevice/pair", {
        method: "POST",
        headers: withAuthHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          action: "confirm",
          pairingId: bridgeData.pairingId,
          confirmationCode: bridgeData.confirmationCode,
          deviceLabel: bridgeData.name,
        }),
      });
      if (!confirmRes.ok) {
        const err = (await confirmRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || "绑定本机电脑失败");
      }
      toast({ title: "已绑定本机电脑", status: "success" });
      await loadDevices();
      setPairDialogOpen(false);
    } catch (err) {
      setPairMessage(
        err instanceof TypeError
          ? `无法联系连接器（127.0.0.1:13005）。请确认伯仁连接器已启动，并在连接设置中核对平台地址为 ${window.location.origin}`
          : err instanceof Error
            ? err.message
            : "连接失败，请重试。"
      );
    } finally {
      setPairingLocal(false);
    }
  };

  const copyInviteLink = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink);
      toast({ title: "已复制邀请链接", status: "success" });
    } catch {
      toast({ title: "复制失败，请手动复制", status: "error" });
    }
  };

  const downloadClient = () => {
    const isMac = /mac/i.test(navigator.platform || navigator.userAgent);
    const url = isMac
      ? "/downloads/AIStudio-Connector-macOS.dmg"
      : "/downloads/AIStudio-Connector-Windows.zip";
    window.open(url, "_blank", "noopener,noreferrer");
  };

  // SSH & 数据库操作
  const openEditResource = (item: InfraResourceItem) => {
    setResourceForm({
      resourceId: item.resourceId,
      kind: item.kind,
      name: item.name,
      host: item.host,
      port: String(item.port),
      username: item.username || "",
      authType: item.authType || "password",
      dbType: item.dbType || "postgresql",
      database: item.database || "",
      remark: item.remark || "",
      secret: "",
      hasSecret: item.hasSecret,
    });
  };

  const saveResource = async () => {
    if (!resourceForm) return;
    const portNum = Number(resourceForm.port);
    if (!resourceForm.name.trim() || !resourceForm.host.trim()) {
      toast({ title: "请填写名称和主机地址", status: "warning" });
      return;
    }
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      toast({ title: "请输入有效的端口号 (1-65535)", status: "warning" });
      return;
    }
    setSavingResource(true);
    try {
      const isEdit = Boolean(resourceForm.resourceId);
      const payload = {
        action: isEdit ? "update" : "create",
        ...(isEdit ? { resourceId: resourceForm.resourceId } : { kind: resourceForm.kind }),
        name: resourceForm.name.trim(),
        host: resourceForm.host.trim(),
        port: portNum,
        username: resourceForm.username.trim() || undefined,
        ...(resourceForm.kind === "ssh" ? { authType: resourceForm.authType } : {}),
        ...(resourceForm.kind === "database"
          ? {
              dbType: resourceForm.dbType,
              database: resourceForm.database.trim() || undefined,
            }
          : {}),
        remark: resourceForm.remark.trim() || undefined,
        ...(resourceForm.secret ? { secret: resourceForm.secret } : {}),
      };
      const response = await fetch("/api/core/resources/manage", {
        method: "POST",
        headers: withAuthHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error();
      setResourceForm(null);
      toast({ title: isEdit ? "配置已更新" : "添加成功", status: "success" });
      await loadResources(true);
    } catch {
      toast({ title: "保存失败，请检查填写内容后重试", status: "error" });
    } finally {
      setSavingResource(false);
    }
  };

  const testResource = async (item: InfraResourceItem) => {
    setTestingId(item.resourceId);
    try {
      const response = await fetch("/api/core/resources/manage", {
        method: "POST",
        headers: withAuthHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ action: "test", resourceId: item.resourceId }),
      });
      const data = (await response.json()) as { ok?: boolean; message?: string };
      toast({
        title: data.ok ? "连接测试通过" : "连接测试失败",
        description: data.message,
        status: data.ok ? "success" : "error",
      });
      await loadResources(true);
    } catch {
      toast({ title: "连接测试请求失败", status: "error" });
    } finally {
      setTestingId(null);
    }
  };

  const confirmDeleteResource = async (item: InfraResourceItem) => {
    setDeletingResourceId(item.resourceId);
    try {
      const response = await fetch("/api/core/resources/manage", {
        method: "POST",
        headers: withAuthHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ action: "delete", resourceId: item.resourceId }),
      });
      if (!response.ok) throw new Error();
      setDeleteResourceTarget(null);
      toast({ title: `已移除「${item.name}」`, status: "success" });
      await loadResources(true);
    } catch {
      toast({ title: "移除失败，请重试", status: "error" });
    } finally {
      setDeletingResourceId(null);
    }
  };

  const renderAddMenuItems = () => (
    <MenuList>
      <MenuItem icon={<Laptop size={15} />} onClick={() => void handlePairLocalBridge()}>
        连接此电脑
      </MenuItem>
      <MenuItem icon={<Link2 size={15} />} onClick={() => void inviteOtherDevice()}>
        添加其他电脑（授权链接）
      </MenuItem>
      <MenuItem icon={<Server size={15} />} onClick={() => setResourceForm(createEmptyForm("ssh"))}>
        添加服务器 (SSH)
      </MenuItem>
      <MenuItem
        icon={<Database size={15} />}
        onClick={() => setResourceForm(createEmptyForm("database"))}
      >
        添加数据库
      </MenuItem>
      <MenuItem icon={<Download size={15} />} onClick={downloadClient}>
        下载伯仁连接器
      </MenuItem>
    </MenuList>
  );

  const renderCategoryIcon = (cat: UnifiedRow["category"], size = 16) => {
    if (cat === "cloud") return <Cloud size={size} />;
    if (cat === "local") return <Laptop size={size} />;
    if (cat === "ssh") return <Server size={size} />;
    return <Database size={size} />;
  };

  const renderRowActions = (row: UnifiedRow) => {
    if (row.category === "cloud") {
      return (
        <Tooltip label="刷新云主机状态" placement="top">
          <IconButton
            aria-label="刷新云主机状态"
            size="sm"
            variant="ghost"
            borderRadius="8px"
            color="ink.secondary"
            isLoading={loadingCloud}
            icon={<RefreshCw size={15} />}
            onClick={() => void loadCloudHost(false)}
          />
        </Tooltip>
      );
    }

    if (row.rawDevice) {
      const device = row.rawDevice;
      return (
        <Menu placement="bottom-end" isLazy>
          <MenuButton
            as={IconButton}
            aria-label={`${row.name}更多操作`}
            size="sm"
            variant="ghost"
            borderRadius="8px"
            color="ink.secondary"
            _hover={{ bg: "blackAlpha.100", color: "ink.primary" }}
            icon={<MoreHorizontal size={16} />}
          />
          <MenuList minW="132px" py={1}>
            <MenuItem
              icon={<Pencil size={14} />}
              fontSize="sm"
              onClick={() => {
                setRemarkTarget(device);
                setRemark(device.remark || "");
              }}
            >
              修改备注
            </MenuItem>
            <MenuItem
              icon={<Trash2 size={14} />}
              fontSize="sm"
              color="red.500"
              onClick={() => {
                setRemarkTarget(null);
                setRevokeTarget(device);
              }}
            >
              移除设备
            </MenuItem>
          </MenuList>
        </Menu>
      );
    }

    if (row.rawResource) {
      const item = row.rawResource;
      return (
        <HStack spacing={0.5} justify="flex-end">
          <Tooltip label="测试连接" placement="top">
            <IconButton
              aria-label={`测试${item.name}连接`}
              size="sm"
              variant="ghost"
              borderRadius="8px"
              color="ink.secondary"
              isLoading={testingId === item.resourceId}
              icon={<PlugZap size={15} />}
              onClick={() => void testResource(item)}
            />
          </Tooltip>
          <Menu placement="bottom-end" isLazy>
            <MenuButton
              as={IconButton}
              aria-label={`${item.name}更多操作`}
              size="sm"
              variant="ghost"
              borderRadius="8px"
              color="ink.secondary"
              _hover={{ bg: "blackAlpha.100", color: "ink.primary" }}
              icon={<MoreHorizontal size={16} />}
            />
            <MenuList minW="132px" py={1}>
              <MenuItem
                icon={<PlugZap size={14} />}
                fontSize="sm"
                onClick={() => void testResource(item)}
              >
                测试连接
              </MenuItem>
              <MenuItem
                icon={<Pencil size={14} />}
                fontSize="sm"
                onClick={() => openEditResource(item)}
              >
                编辑配置
              </MenuItem>
              <MenuItem
                icon={<Trash2 size={14} />}
                fontSize="sm"
                color="red.500"
                onClick={() => setDeleteResourceTarget(item)}
              >
                移除
              </MenuItem>
            </MenuList>
          </Menu>
        </HStack>
      );
    }
    return null;
  };

  const navItems: {
    id: ResourceCategory;
    label: string;
    icon: React.ReactNode;
    count?: number;
  }[] = [
    { id: "all", label: "全部", icon: <LayoutGrid size={SIDEBAR_ICON_SIZE} /> },
    { id: "cloud", label: "云服务器", icon: <Cloud size={SIDEBAR_ICON_SIZE} />, count: 1 },
    {
      id: "local",
      label: "本地设备",
      icon: <Laptop size={SIDEBAR_ICON_SIZE} />,
      count: devices.length,
    },
    {
      id: "ssh",
      label: "服务器 (SSH)",
      icon: <Server size={SIDEBAR_ICON_SIZE} />,
      count: sshResources.length,
    },
    {
      id: "database",
      label: "数据库",
      icon: <Database size={SIDEBAR_ICON_SIZE} />,
      count: dbResources.length,
    },
  ];

  const isLoading = loadingCloud && loadingDevices && loadingResources;

  return (
    <Flex flex="1" h="100%" minW={0} overflow="hidden" bg="surface.canvas">
      {/* 左侧次级侧边栏：对齐资料空间 LibrarySidebar */}
      {sidebarOpen && (
        <WorkspaceSidebar
          title="我的设备"
          headerActions={
            <>
              <Tooltip label="搜索" placement="bottom">
                <SidebarHeaderIconButton
                  aria-label="搜索"
                  icon={<Search size={15} />}
                  onClick={() => searchInputRef.current?.focus()}
                />
              </Tooltip>
              <Tooltip label="刷新" placement="bottom">
                <SidebarHeaderIconButton
                  aria-label="刷新"
                  icon={<RefreshCw size={15} />}
                  onClick={() => refreshAll(false)}
                  isLoading={loadingDevices || loadingCloud || loadingResources}
                />
              </Tooltip>
              <Tooltip label="收起侧边栏" placement="bottom">
                <SidebarHeaderIconButton
                  aria-label="收起侧边栏"
                  icon={<PanelLeftClose size={15} />}
                  onClick={() => setSidebarOpen(false)}
                />
              </Tooltip>
            </>
          }
          primaryAction={
            <Menu placement="bottom-start">
              <MenuButton
                as={SidebarActionButton}
                leftIcon={<Plus size={SIDEBAR_ICON_SIZE} />}
                isLoading={pairingLocal}
              >
                添加
              </MenuButton>
              {renderAddMenuItems()}
            </Menu>
          }
        >
          <VStack align="stretch" spacing={0.5} px={2}>
            {navItems.map((item) => {
              const active = category === item.id;
              return (
                <Button
                  key={item.id}
                  {...sidebarNavItemProps}
                  leftIcon={item.icon as React.ReactElement}
                  bg={active ? "surface.active" : "transparent"}
                  fontWeight={active ? "500" : "400"}
                  color={active ? "ink.primary" : "ink.secondary"}
                  onClick={() => setCategory(item.id)}
                >
                  <Flex align="center" justify="space-between" w="full" minW={0}>
                    <Text isTruncated>{item.label}</Text>
                    {item.count !== undefined && (
                      <Text fontSize="11px" color="ink.muted" ml={2}>
                        {item.count}
                      </Text>
                    )}
                  </Flex>
                </Button>
              );
            })}
          </VStack>

          <Box px={2} mt={5}>
            <SidebarSectionHeader label="已连接" />
            <VStack align="stretch" spacing={0.5} mt={0.5}>
              {allRows.map((row) => (
                <Button
                  key={row.id}
                  {...sidebarNavItemProps}
                  h="32px"
                  fontSize="13px"
                  color="ink.secondary"
                  onClick={() => {
                    setCategory(row.category);
                    if (row.rawDevice) {
                      setRemarkTarget(row.rawDevice);
                      setRemark(row.rawDevice.remark || "");
                    } else if (row.rawResource) {
                      openEditResource(row.rawResource);
                    }
                  }}
                >
                  <HStack spacing={2} w="full" minW={0}>
                    <Box
                      boxSize="7px"
                      borderRadius="full"
                      flexShrink={0}
                      bg={row.statusDotColor}
                    />
                    <Text isTruncated flex="1" textAlign="left">
                      {row.name}
                    </Text>
                  </HStack>
                </Button>
              ))}
            </VStack>
          </Box>
        </WorkspaceSidebar>
      )}

      {/* 右侧主内容区：对齐资料空间 LibraryView */}
      <Box flex="1" h="100%" overflowY="auto" px={{ base: 4, md: 10 }} py={6}>
        <Box maxW="1040px" mx="auto">
          {/* 顶部栏：大标题 + 圆角搜索框 + 黑色药丸主按钮 */}
          <Flex
            direction={{ base: "column", md: "row" }}
            align={{ base: "stretch", md: "center" }}
            justify="space-between"
            gap={3}
            mb={4}
          >
            <HStack spacing={2}>
              {!sidebarOpen && (
                <Tooltip label="展开侧边栏" placement="bottom">
                  <IconButton
                    aria-label="展开侧边栏"
                    icon={<PanelLeftOpen size={16} />}
                    size="sm"
                    variant="ghost"
                    onClick={() => setSidebarOpen(true)}
                  />
                </Tooltip>
              )}
              <Text fontSize="22px" fontWeight="600" color="ink.primary">
                {CATEGORY_LABELS[category]}
              </Text>
            </HStack>

            <HStack spacing={2.5}>
              <InputGroup size="sm" w={{ base: "full", md: "220px" }}>
                <InputLeftElement pointerEvents="none" color="ink.muted">
                  <Search size={14} />
                </InputLeftElement>
                <Input
                  ref={searchInputRef}
                  placeholder="搜索"
                  borderRadius="full"
                  bg="surface.canvas"
                  borderColor="stroke.light"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </InputGroup>

              <Menu placement="bottom-end">
                <MenuButton
                  as={Button}
                  size="sm"
                  px={4}
                  borderRadius="full"
                  bg="#111111"
                  color="white"
                  fontWeight="500"
                  rightIcon={<ChevronDown size={14} />}
                  _hover={{ bg: "#2a2a2a" }}
                  _active={{ bg: "#000000" }}
                  isLoading={pairingLocal}
                >
                  添加
                </MenuButton>
                {renderAddMenuItems()}
              </Menu>
            </HStack>
          </Flex>

          {/* 第二行：药丸筛选 Tabs + 右侧网格/列表视图切换 */}
          <Flex align="center" justify="space-between" gap={3} mb={6} flexWrap="wrap">
            <HStack spacing={1.5} flexWrap="wrap">
              {(Object.keys(CATEGORY_LABELS) as ResourceCategory[]).map((key) => {
                const active = category === key;
                return (
                  <Button
                    key={key}
                    size="xs"
                    h="28px"
                    px={3.5}
                    borderRadius="full"
                    variant="ghost"
                    bg={active ? "#ececec" : "transparent"}
                    color={active ? "ink.primary" : "ink.secondary"}
                    fontWeight={active ? "500" : "400"}
                    fontSize="13px"
                    _hover={{ bg: active ? "#e5e5e5" : "surface.hover", color: "ink.primary" }}
                    onClick={() => setCategory(key)}
                  >
                    {CATEGORY_LABELS[key]}
                  </Button>
                );
              })}
            </HStack>

            <HStack spacing={1}>
              <Tooltip label="网格视图" placement="top">
                <IconButton
                  aria-label="网格视图"
                  size="xs"
                  boxSize="28px"
                  borderRadius="full"
                  variant="ghost"
                  bg={viewMode === "grid" ? "#ececec" : "transparent"}
                  color={viewMode === "grid" ? "ink.primary" : "ink.muted"}
                  icon={<LayoutGrid size={14} />}
                  onClick={() => setViewMode("grid")}
                />
              </Tooltip>
              <Tooltip label="列表视图" placement="top">
                <IconButton
                  aria-label="列表视图"
                  size="xs"
                  boxSize="28px"
                  borderRadius="full"
                  variant="ghost"
                  bg={viewMode === "list" ? "#ececec" : "transparent"}
                  color={viewMode === "list" ? "ink.primary" : "ink.muted"}
                  icon={<List size={14} />}
                  onClick={() => setViewMode("list")}
                />
              </Tooltip>
            </HStack>
          </Flex>

          {listError && (
            <Text role="alert" fontSize="sm" color="red.500" mb={4}>
              {listError}
            </Text>
          )}

          {/* 主体列表 / 网格 */}
          {isLoading ? (
            <BoreLoading label="正在加载设备与资源" />
          ) : visibleRows.length === 0 ? (
            <Box py={16} textAlign="center">
              <Text fontSize="sm" color="ink.muted" mb={3}>
                {searchQuery.trim() ? "没有找到匹配的设备或资源" : `暂无${CATEGORY_LABELS[category]}`}
              </Text>
              {!searchQuery.trim() && (
                <Button
                  size="sm"
                  variant="outline"
                  borderRadius="full"
                  leftIcon={<Plus size={14} />}
                  onClick={() => {
                    if (category === "ssh") setResourceForm(createEmptyForm("ssh"));
                    else if (category === "database") setResourceForm(createEmptyForm("database"));
                    else void handlePairLocalBridge();
                  }}
                >
                  {category === "ssh"
                    ? "添加服务器 (SSH)"
                    : category === "database"
                      ? "添加数据库"
                      : "连接此电脑"}
                </Button>
              )}
            </Box>
          ) : viewMode === "list" ? (
            /* 列表视图（完全对齐资料空间底部表格） */
            <Box>
              <Flex
                px={3}
                py={2}
                fontSize="12px"
                color="ink.muted"
                borderBottom="1px solid"
                borderColor="stroke.light"
              >
                <Box flex="2" minW={0}>名称</Box>
                <Box flex="2.5" minW={0} display={{ base: "none", sm: "block" }}>连接信息</Box>
                <Box w="110px" flexShrink={0}>状态</Box>
                <Box w="76px" flexShrink={0} textAlign="right" />
              </Flex>

              <VStack align="stretch" spacing={0}>
                {visibleRows.map((row) => (
                  <Box key={row.id} borderBottom="1px solid" borderColor="stroke.light">
                    <Flex
                      align="center"
                      px={3}
                      py={3}
                      transition="background 0.12s"
                      _hover={{ bg: "surface.hover" }}
                    >
                      <HStack flex="2" minW={0} spacing={3} pr={3}>
                        <Box
                          p={1.5}
                          borderRadius="8px"
                          bg="blackAlpha.50"
                          color="ink.secondary"
                          flexShrink={0}
                        >
                          {renderCategoryIcon(row.category, 16)}
                        </Box>
                        <Text fontSize="13.5px" fontWeight="500" color="ink.primary" noOfLines={1}>
                          {row.name}
                        </Text>
                      </HStack>

                      <Box flex="2.5" minW={0} pr={3} display={{ base: "none", sm: "block" }}>
                        <Text fontSize="13px" color="ink.secondary" noOfLines={1}>
                          {row.subtitle}
                        </Text>
                      </Box>

                      <HStack w="110px" flexShrink={0} spacing={2}>
                        <Box boxSize="7px" borderRadius="full" bg={row.statusDotColor} />
                        <Text fontSize="12.5px" color="ink.secondary" noOfLines={1}>
                          {row.statusLabel}
                        </Text>
                      </HStack>

                      <Box w="76px" flexShrink={0} textAlign="right">
                        {renderRowActions(row)}
                      </Box>
                    </Flex>
                  </Box>
                ))}
              </VStack>
            </Box>
          ) : (
            /* 网格视图 */
            <SimpleGrid columns={{ base: 1, sm: 2, lg: 3 }} spacing={3.5}>
              {visibleRows.map((row) => (
                <Box
                  key={row.id}
                  p={4}
                  borderRadius="14px"
                  bg="surface.canvas"
                  border="1px solid"
                  borderColor="stroke.light"
                  transition="border-color 0.15s, background 0.15s"
                  _hover={{ borderColor: "blackAlpha.300" }}
                >
                  <Flex align="flex-start" justify="space-between" mb={3}>
                    <Box p={2} borderRadius="10px" bg="blackAlpha.50" color="ink.secondary">
                      {renderCategoryIcon(row.category, 18)}
                    </Box>
                    {renderRowActions(row)}
                  </Flex>
                  <Text fontSize="14px" fontWeight="600" color="ink.primary" noOfLines={1}>
                    {row.name}
                  </Text>
                  <Text fontSize="12.5px" color="ink.secondary" mt={1} noOfLines={1}>
                    {row.subtitle}
                  </Text>
                  <HStack spacing={1.5} mt={3}>
                    <Box boxSize="7px" borderRadius="full" bg={row.statusDotColor} />
                    <Text fontSize="12px" color="ink.secondary">
                      {row.statusLabel}
                    </Text>
                  </HStack>
                </Box>
              ))}
            </SimpleGrid>
          )}
        </Box>
      </Box>

      {/* 连接此电脑 / 添加其他电脑弹窗 */}
      <AppDialog
        isOpen={pairDialogOpen}
        onClose={() => {
          if (!pairingLocal) setPairDialogOpen(false);
        }}
        size="md"
        title={pairDialogTitle}
        footer={
          <HStack spacing={2} justify="flex-end" w="full">
            {!inviteLink && (
              <Button
                size="sm"
                variant="outline"
                isLoading={pairingLocal}
                onClick={() => void handlePairLocalBridge()}
              >
                重试连接
              </Button>
            )}
            <Button
              size="sm"
              bg="#111111"
              color="white"
              _hover={{ bg: "#2a2a2a" }}
              isDisabled={pairingLocal}
              onClick={() => setPairDialogOpen(false)}
            >
              完成
            </Button>
          </HStack>
        }
      >
        <VStack align="stretch" spacing={3}>
          {pairingLocal && (
            <BoreLoading label={pairMessage || "正在联系伯仁连接器"} size={44} py={4} />
          )}
          {!pairingLocal && pairMessage && (
            <Text role="status" color="ink.secondary" fontSize="sm">
              {pairMessage}
            </Text>
          )}
          {inviteLink && (
            <HStack spacing={2}>
              <Input
                size="sm"
                value={inviteLink}
                isReadOnly
                onClick={(e) => e.currentTarget.select()}
                aria-label="邀请链接"
              />
              <Button
                size="sm"
                variant="outline"
                flexShrink={0}
                onClick={() => void copyInviteLink()}
              >
                复制链接
              </Button>
            </HStack>
          )}
          {inviteLink &&
            ["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname) && (
              <Text color="ink.muted" fontSize="xs">
                连接其他电脑时，请从两台电脑都能访问的平台地址打开工作台并创建邀请。
              </Text>
            )}
        </VStack>
      </AppDialog>

      {/* 修改本地设备备注弹窗 */}
      <AppDialog
        isOpen={Boolean(remarkTarget)}
        onClose={() => {
          if (!savingRemark) setRemarkTarget(null);
        }}
        size="sm"
        title="修改设备备注"
        footer={
          <HStack spacing={2} justify="flex-end" w="full">
            <Button
              size="sm"
              variant="ghost"
              isDisabled={savingRemark}
              onClick={() => setRemarkTarget(null)}
            >
              取消
            </Button>
            <Button
              size="sm"
              bg="#111111"
              color="white"
              _hover={{ bg: "#2a2a2a" }}
              isLoading={savingRemark}
              onClick={() => {
                if (remarkTarget) void saveRemark(remarkTarget);
              }}
            >
              保存
            </Button>
          </HStack>
        }
      >
        <FormControl>
          <FormLabel fontSize="xs" mb={1}>
            电脑备注
          </FormLabel>
          <Input
            size="sm"
            placeholder="例如：办公 Mac"
            maxLength={32}
            autoFocus
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && remarkTarget) {
                e.preventDefault();
                void saveRemark(remarkTarget);
              }
            }}
          />
        </FormControl>
      </AppDialog>

      {/* 移除本地设备确认弹窗 */}
      <AppDialog
        isOpen={Boolean(revokeTarget)}
        onClose={() => {
          if (!revokingId) setRevokeTarget(null);
        }}
        size="sm"
        title="移除设备"
        footer={
          <HStack spacing={2} justify="flex-end" w="full">
            <Button
              size="sm"
              variant="ghost"
              isDisabled={Boolean(revokingId)}
              onClick={() => setRevokeTarget(null)}
            >
              取消
            </Button>
            <Button
              size="sm"
              colorScheme="red"
              isLoading={Boolean(revokingId)}
              onClick={() => {
                if (revokeTarget) void revokeDeviceItem(revokeTarget);
              }}
            >
              确认移除
            </Button>
          </HStack>
        }
      >
        <Text fontSize="sm" color="ink.secondary">
          确定移除「{revokeTarget ? deviceDisplayName(revokeTarget) : ""}」？移除后如需使用需重新配对。
        </Text>
      </AppDialog>

      {/* 移除 SSH/数据库资源确认弹窗 */}
      <AppDialog
        isOpen={Boolean(deleteResourceTarget)}
        onClose={() => {
          if (!deletingResourceId) setDeleteResourceTarget(null);
        }}
        size="sm"
        title="移除资源"
        footer={
          <HStack spacing={2} justify="flex-end" w="full">
            <Button
              size="sm"
              variant="ghost"
              isDisabled={Boolean(deletingResourceId)}
              onClick={() => setDeleteResourceTarget(null)}
            >
              取消
            </Button>
            <Button
              size="sm"
              colorScheme="red"
              isLoading={Boolean(deletingResourceId)}
              onClick={() => {
                if (deleteResourceTarget) void confirmDeleteResource(deleteResourceTarget);
              }}
            >
              确认移除
            </Button>
          </HStack>
        }
      >
        <Text fontSize="sm" color="ink.secondary">
          确定移除「{deleteResourceTarget?.name}」？已保存的连接配置与加密凭据将被删除。
        </Text>
      </AppDialog>

      {/* 添加/编辑 SSH 服务器或数据库弹窗 */}
      <AppDialog
        isOpen={Boolean(resourceForm)}
        onClose={() => {
          if (!savingResource) setResourceForm(null);
        }}
        size="md"
        title={
          resourceForm
            ? `${resourceForm.resourceId ? "编辑" : "添加"}${
                resourceForm.kind === "ssh" ? "服务器 (SSH)" : "数据库"
              }`
            : ""
        }
        footer={
          <HStack spacing={2} justify="flex-end" w="full">
            <Button
              size="sm"
              variant="ghost"
              isDisabled={savingResource}
              onClick={() => setResourceForm(null)}
            >
              取消
            </Button>
            <Button
              size="sm"
              bg="#111111"
              color="white"
              _hover={{ bg: "#2a2a2a" }}
              isLoading={savingResource}
              onClick={() => void saveResource()}
            >
              保存
            </Button>
          </HStack>
        }
      >
        {resourceForm && (
          <VStack spacing={3} align="stretch">
            <FormControl isRequired>
              <FormLabel fontSize="xs" mb={1}>
                名称
              </FormLabel>
              <Input
                size="sm"
                placeholder={
                  resourceForm.kind === "ssh" ? "例如：生产环境跳板机" : "例如：业务主库"
                }
                value={resourceForm.name}
                onChange={(e) =>
                  setResourceForm((f) => (f ? { ...f, name: e.target.value } : f))
                }
              />
            </FormControl>

            {resourceForm.kind === "database" && (
              <FormControl isRequired>
                <FormLabel fontSize="xs" mb={1}>
                  数据库类型
                </FormLabel>
                <Select
                  size="sm"
                  value={resourceForm.dbType}
                  onChange={(e) => {
                    const nextType = e.target.value as DatabaseType;
                    setResourceForm((f) =>
                      f
                        ? {
                            ...f,
                            dbType: nextType,
                            port: f.resourceId ? f.port : String(DB_DEFAULT_PORTS[nextType]),
                          }
                        : f
                    );
                  }}
                >
                  <option value="postgresql">PostgreSQL</option>
                  <option value="mysql">MySQL</option>
                  <option value="mongodb">MongoDB</option>
                  <option value="redis">Redis</option>
                </Select>
              </FormControl>
            )}

            <HStack spacing={3}>
              <FormControl isRequired flex={2}>
                <FormLabel fontSize="xs" mb={1}>
                  主机地址 (Host / IP)
                </FormLabel>
                <Input
                  size="sm"
                  placeholder="例如：192.168.1.10 或 db.example.com"
                  value={resourceForm.host}
                  onChange={(e) =>
                    setResourceForm((f) => (f ? { ...f, host: e.target.value } : f))
                  }
                />
              </FormControl>
              <FormControl isRequired flex={1}>
                <FormLabel fontSize="xs" mb={1}>
                  端口
                </FormLabel>
                <Input
                  size="sm"
                  type="number"
                  value={resourceForm.port}
                  onChange={(e) =>
                    setResourceForm((f) => (f ? { ...f, port: e.target.value } : f))
                  }
                />
              </FormControl>
            </HStack>

            <HStack spacing={3}>
              <FormControl flex={1}>
                <FormLabel fontSize="xs" mb={1}>
                  用户名
                </FormLabel>
                <Input
                  size="sm"
                  placeholder={resourceForm.kind === "ssh" ? "root" : "可选"}
                  value={resourceForm.username}
                  onChange={(e) =>
                    setResourceForm((f) => (f ? { ...f, username: e.target.value } : f))
                  }
                />
              </FormControl>
              {resourceForm.kind === "database" && (
                <FormControl flex={1}>
                  <FormLabel fontSize="xs" mb={1}>
                    数据库名
                  </FormLabel>
                  <Input
                    size="sm"
                    placeholder="例如：app_prod"
                    value={resourceForm.database}
                    onChange={(e) =>
                      setResourceForm((f) => (f ? { ...f, database: e.target.value } : f))
                    }
                  />
                </FormControl>
              )}
              {resourceForm.kind === "ssh" && (
                <FormControl flex={1}>
                  <FormLabel fontSize="xs" mb={1}>
                    认证方式
                  </FormLabel>
                  <Select
                    size="sm"
                    value={resourceForm.authType}
                    onChange={(e) =>
                      setResourceForm((f) =>
                        f ? { ...f, authType: e.target.value as SshAuthType } : f
                      )
                    }
                  >
                    <option value="password">密码</option>
                    <option value="privateKey">私钥 (PEM)</option>
                  </Select>
                </FormControl>
              )}
            </HStack>

            <FormControl>
              <FormLabel fontSize="xs" mb={1}>
                {resourceForm.kind === "ssh" && resourceForm.authType === "privateKey"
                  ? "SSH 私钥"
                  : "密码"}
                {resourceForm.hasSecret && (
                  <Text as="span" color="ink.muted" fontWeight="400" ml={1.5}>
                    （已加密保存，留空则保持不变）
                  </Text>
                )}
              </FormLabel>
              {resourceForm.kind === "ssh" && resourceForm.authType === "privateKey" ? (
                <Textarea
                  size="sm"
                  rows={3}
                  fontFamily="mono"
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  value={resourceForm.secret}
                  onChange={(e) =>
                    setResourceForm((f) => (f ? { ...f, secret: e.target.value } : f))
                  }
                />
              ) : (
                <Input
                  size="sm"
                  type="password"
                  placeholder={resourceForm.hasSecret ? "••••••••" : "输入密码"}
                  value={resourceForm.secret}
                  onChange={(e) =>
                    setResourceForm((f) => (f ? { ...f, secret: e.target.value } : f))
                  }
                />
              )}
            </FormControl>

            <FormControl>
              <FormLabel fontSize="xs" mb={1}>
                备注
              </FormLabel>
              <Input
                size="sm"
                placeholder="可选描述信息"
                value={resourceForm.remark}
                onChange={(e) =>
                  setResourceForm((f) => (f ? { ...f, remark: e.target.value } : f))
                }
              />
            </FormControl>
          </VStack>
        )}
      </AppDialog>
    </Flex>
  );
}
