import { deviceDisplayName } from "@/shared/localDevice/displayName";
import { useEffect, useState } from "react";
import {
  Box,
  Button,
  HStack,
  IconButton,
  Menu, MenuButton, MenuList, MenuItem,
  Input,
  Skeleton,
  Text,
  useToast,
  VStack,
} from "@chakra-ui/react";
import { AppDialog } from "../ui";
import {
  RefreshCw,
  Laptop,
  Pencil,
  Plus,
  Link2,
  Download,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { withAuthHeaders } from "@features/auth/client/authClient";

type PairedDeviceItem = {
  remark?: string;
  deviceId: string;
  name: string;
  platform: string;
  online: boolean;
  browserSupported?: boolean;
};

type DeviceManagementModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

export default function DeviceManagementModal({ isOpen, onClose }: DeviceManagementModalProps) {
  const toast = useToast();
  const [devices, setDevices] = useState<PairedDeviceItem[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [remark, setRemark] = useState("");
  const [savingRemark, setSavingRemark] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<PairedDeviceItem | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const saveRemark = async (device: PairedDeviceItem) => {
    setSavingRemark(true);
    try {
      const response = await fetch("/api/core/localDevice/manage", {
        method: "POST", headers: withAuthHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ action: "remark", deviceId: device.deviceId, remark: remark.trim() }),
      });
      if (!response.ok) throw new Error();
      setEditing(null);
      await loadDevices(true);
    } catch { toast({ title: "备注保存失败，请重试", status: "error" }); }
    finally { setSavingRemark(false); }
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
      if (editing === device.deviceId) setEditing(null);
      toast({ title: `已移除「${deviceDisplayName(device)}」`, status: "success" });
      await loadDevices(true);
    } catch {
      toast({ title: "移除设备失败，请重试", status: "error" });
    } finally {
      setRevokingId(null);
    }
  };
  const [pairMessage, setPairMessage] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [listError, setListError] = useState("");
  const [pairingLocal, setPairingLocal] = useState(false);
  const loadDevices = async (background = false) => {
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
  };

  useEffect(() => {
    if (!isOpen) return;
    setEditing(null);
    setRevokeTarget(null);
    setPairMessage("");
    setInviteLink("");
    void loadDevices();
    const timer = window.setInterval(() => { void loadDevices(true); }, 5000);
    return () => window.clearInterval(timer);
  }, [isOpen]);

  const createInvite = async () => {
    const response = await fetch("/api/core/localDevice/invite", {
      method: "POST", headers: withAuthHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ action: "create" }),
    });
    if (!response.ok) throw new Error("无法创建邀请，请重试。");
    return (await response.json()).code as string;
  };

  const inviteOtherDevice = async () => {
    try {
      const code = await createInvite();
      setInviteLink(window.location.origin + "/account/devices#connect=" + code);
      setPairMessage("在另一台电脑打开伯仁连接器，选择「添加授权」并粘贴链接。链接 10 分钟内有效。");
    } catch { setPairMessage("无法创建邀请，请重试。"); }
  };

  const handlePairLocalBridge = async () => {
    setPairingLocal(true);
    try {
      setInviteLink("");
      setPairMessage("正在联系伯仁连接器…");
      const status = await fetch("http://127.0.0.1:13005/status").then(r => r.ok ? r.json() : null).catch(() => null);
      if (status?.inviteDecision || !status) {
        if (status && devices.some(device => device.deviceId === status.deviceId || status.deviceIds?.includes(device.deviceId))) {
          setPairMessage("此电脑已在设备列表中。");
          return;
        }
        const code = await createInvite();
        setPairMessage("请在本机的伯仁连接器窗口确认账号授权。");
        const result = await fetch("http://127.0.0.1:13005/invite", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, waitForDecision: true }),
        });
        if (result.status !== 404) {
          if (!result.ok) throw new Error(result.status === 403 ? "本机授权未完成。可以再次连接。" : "连接器未能完成邀请，请重试。");
          setPairMessage("连接器已接受请求，正在刷新设备列表。");
          await loadDevices();
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
        toast({ title: "本机电脑已绑定", status: "success", duration: 2500 });
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
      toast({ title: "已绑定本机电脑", status: "success", duration: 2500 });
      await loadDevices();
    } catch (err) {
      setPairMessage(err instanceof TypeError
        ? "无法联系连接器。请确认它已启动，并在连接设置中核对平台地址 " + window.location.origin
        : err instanceof Error ? err.message : "连接失败，请重试。");
    } finally {
      setPairingLocal(false);
    }
  };

  const footer = (
    <HStack w="full" justify="space-between">
      <Menu placement="top-start" strategy="fixed">
        <MenuButton as={Button} size="sm" variant="ghost" leftIcon={<Plus size={15} />}>添加电脑</MenuButton>
        <MenuList zIndex={20} fontSize="sm">
          <MenuItem icon={<Link2 size={15} />} onClick={() => void handlePairLocalBridge()} isDisabled={pairingLocal}>连接此电脑</MenuItem>
          <MenuItem icon={<Laptop size={15} />} onClick={() => void inviteOtherDevice()}>邀请其他电脑</MenuItem>
          <MenuItem as="a" href="/downloads/AIStudio-Connector-macOS.dmg" download="伯仁连接器-macOS.dmg" icon={<Download size={15} />}>下载 Mac 连接器</MenuItem>
          <MenuItem icon={<RefreshCw size={15} />} onClick={() => void loadDevices()}>刷新设备</MenuItem>
        </MenuList>
      </Menu>
      <Button size="sm" variant="primary" onClick={onClose}>完成</Button>
    </HStack>
  );

  const copyInviteLink = async () => {
    if (!inviteLink) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(inviteLink);
        toast({ title: "邀请链接已复制", status: "success" });
        return;
      }
    } catch {
      // Fallback to execCommand in non-HTTPS / restricted clipboard contexts
    }
    try {
      const textarea = document.createElement("textarea");
      textarea.value = inviteLink;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(textarea);
      if (copied) {
        toast({ title: "邀请链接已复制", status: "success" });
        return;
      }
    } catch {
      // Ignore fallback error
    }
    setPairMessage("无法自动写入剪贴板，请直接选中下方链接手动复制。");
  };

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="md" title="我的设备" footer={footer}>
      <VStack align="stretch" spacing={2} minW={{ base: "100%", sm: "380px" }}>
        {pairMessage && <Text role="status" color="ink.secondary" fontSize="sm">{pairMessage}</Text>}
        {inviteLink && (
          <VStack align="stretch" spacing={2} minW={{ base: "100%", sm: "380px" }}>
            <Input size="sm" value={inviteLink} isReadOnly onClick={(e) => e.currentTarget.select()} aria-label="邀请链接" />
            <Button size="sm" variant="outline" onClick={() => void copyInviteLink()}>复制邀请链接</Button>
          </VStack>
        )}
        {inviteLink && ["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname) && (
          <Text color="ink.secondary" fontSize="sm">连接其他电脑时，请从两台电脑都能访问的平台地址打开工作台并创建邀请。</Text>
        )}
        {listError ? <Text role="alert" fontSize="sm">{listError}</Text> : loadingDevices ? (
          <VStack align="stretch" spacing={2}>
            {[0, 1].map((idx) => (
              <HStack key={idx} px={3} py={2} borderRadius="10px" bg="gray.50" spacing={3}>
                <Skeleton boxSize="20px" borderRadius="4px" flexShrink={0} />
                <VStack align="start" spacing={1.5} flex={1}>
                  <Skeleton h="14px" w="140px" borderRadius="4px" />
                  <Skeleton h="10px" w="72px" borderRadius="4px" />
                </VStack>
                <Skeleton boxSize="24px" borderRadius="6px" flexShrink={0} />
              </HStack>
            ))}
          </VStack>
        ) : devices.length === 0 ? (
          <Text fontSize="sm" color="ink.secondary">还没有连接电脑。</Text>
        ) : devices.map((device) => {
          const name = deviceDisplayName(device);
          return (
            <Box key={device.deviceId}>
              <HStack px={3} py={2} borderRadius="10px" bg={device.online ? "green.50" : "gray.50"}>
                <Laptop size={20} />
                <Box flex={1} minW={0}>
                  <Text fontSize="sm" noOfLines={1}>{name}</Text>
                  <Text fontSize="xs" color="ink.secondary">{device.online ? "在线" : "离线"}{device.browserSupported && " · 支持本地浏览器"}</Text>
                </Box>
                <Menu placement="bottom-end" isLazy>
                  <MenuButton
                    as={IconButton}
                    aria-label={`${name}更多操作`}
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
                        setRevokeTarget(null);
                        setEditing(device.deviceId);
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
                        setEditing(null);
                        setRevokeTarget(device);
                      }}
                    >
                      移除设备
                    </MenuItem>
                  </MenuList>
                </Menu>
              </HStack>
              {editing === device.deviceId && <HStack mt={2}>
                <Input size="sm" aria-label="电脑备注" placeholder="例如：办公 Mac" maxLength={32} autoFocus
                  value={remark} onChange={e => setRemark(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault(); void saveRemark(device);
                  } }} />
                <Button type="button" size="sm" isLoading={savingRemark} onClick={() => void saveRemark(device)}>保存备注</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>取消</Button>
              </HStack>}
            </Box>
          );
        })}
      </VStack>
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
    </AppDialog>
  );
}
