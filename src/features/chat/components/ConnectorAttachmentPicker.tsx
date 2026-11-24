import { useEffect, useRef, useState, type RefObject } from "react";
import {
  Alert, AlertIcon, Button, Flex, Input, Modal, ModalBody, ModalCloseButton,
  ModalContent, ModalFooter, ModalHeader, ModalOverlay, Spinner, Text,
} from "@chakra-ui/react";
import { withAuthHeaders } from "@features/auth/client/authClient";
import { redirectedToLogin, responseFilename } from "../services/files";

type ConnectorFile = { id: string; name: string; folder: boolean };
type ConnectorPage = { files: ConnectorFile[]; nextCursor?: string };

export default function ConnectorAttachmentPicker({ provider, finalFocusRef, onClose, onAdd }: {
  provider: "dropbox" | "sharepoint";
  finalFocusRef: RefObject<HTMLElement>;
  onClose: () => void;
  onAdd: (files: File[]) => Promise<(string | undefined)[]>;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [folders, setFolders] = useState<ConnectorFile[]>([]);
  const [cursor, setCursor] = useState("");
  const [page, setPage] = useState<ConnectorPage>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [attaching, setAttaching] = useState(false);
  const folder = folders.at(-1)?.id ?? "";
  const endpoint = `/api/library/connectors/${provider}-files`;
  const needsQuery = provider === "sharepoint" && !query;

  useEffect(() => {
    if (needsQuery) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ query });
    if (cursor) params.set("cursor", cursor);
    if (folder && !query) params.set("folder", folder);
    void fetch(`${endpoint}?${params}`, { headers: withAuthHeaders(), signal: controller.signal })
      .then(async (response) => {
        if (redirectedToLogin(response)) throw new Error("登录已过期，请重新登录。");
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "无法读取云盘文件");
        if (!controller.signal.aborted) setPage(data);
      })
      .catch((issue) => {
        if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : "无法读取云盘文件");
      });
    return () => controller.abort();
  }, [attempt, cursor, endpoint, folder, needsQuery, query]);

  const resetPage = () => {
    setError("");
    setPage(undefined);
    setCursor("");
  };

  async function pick(item: ConnectorFile) {
    if (item.folder) {
      resetPage();
      setQuery("");
      setSearch("");
      setFolders((current) => [...current, item]);
      return;
    }
    setAttaching(true);
    setError("");
    try {
      const response = await fetch(`${endpoint}?${new URLSearchParams({ file: item.id })}`, { headers: withAuthHeaders() });
      if (redirectedToLogin(response)) throw new Error("登录已过期，请重新登录。");
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || "下载文件失败");
      const blob = await response.blob();
      const result = await onAdd([new File([blob], responseFilename(response, item.name), { type: blob.type })]);
      if (!(0 in result) || result[0]) throw new Error(result[0] || "添加文件失败");
      onClose();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "添加文件失败");
    } finally {
      setAttaching(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} initialFocusRef={searchRef} finalFocusRef={finalFocusRef}
      closeOnEsc={!attaching} closeOnOverlayClick={!attaching} scrollBehavior="inside" isCentered>
      <ModalOverlay />
      <ModalContent mx={3}>
        <ModalHeader>从 {provider === "dropbox" ? "Dropbox" : "SharePoint"} 添加文件</ModalHeader>
        <ModalCloseButton isDisabled={attaching} />
        <ModalBody>
          <Flex as="form" gap={2} onSubmit={(event) => {
            event.preventDefault();
            const nextQuery = search.trim();
            if (nextQuery === query && !cursor) setAttempt((current) => current + 1);
            resetPage();
            setQuery(nextQuery);
          }}>
            <Input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)}
              isDisabled={attaching} aria-label="搜索文件" placeholder="输入文件名" />
            <Button type="submit" isDisabled={attaching}>搜索</Button>
          </Flex>
          {folders.length > 0 && !query && (
            <Button size="sm" variant="ghost" isDisabled={attaching} onClick={() => {
              resetPage();
              setFolders((current) => current.slice(0, -1));
            }}>返回上一级</Button>
          )}
          <Flex direction="column" gap={1} mt={3}>
            {error && <Alert status="error"><AlertIcon />{error}</Alert>}
            {needsQuery ? <Text color="gray.500">输入文件名后搜索。</Text> :
              !page && !error ? <Spinner aria-label="加载文件" /> :
              page?.files.length === 0 ? <Text color="gray.500">没有找到文件。</Text> :
              page?.files.map((item) => (
                <Button key={item.id} variant="ghost" justifyContent="start" isDisabled={attaching}
                  onClick={() => void pick(item)}>
                  <Text isTruncated>{item.folder ? "文件夹 · " : ""}{item.name}</Text>
                </Button>
              ))}
          </Flex>
        </ModalBody>
        <ModalFooter gap={2}>
          {page?.nextCursor && <Button size="sm" isDisabled={attaching} onClick={() => {
            setError("");
            setCursor(page.nextCursor!);
            setPage(undefined);
          }}>下一页</Button>}
          <Button size="sm" onClick={onClose} isDisabled={attaching}>
            {attaching ? "正在添加…" : "关闭"}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
