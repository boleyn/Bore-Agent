import AttachmentFilename from "./AttachmentFilename";
import ImageCreationTemplates from "./ImageCreationTemplates";
import { getCloudHostStatusMeta } from "@shared/sandbox/cloudHostStatus";
import { ChatModeOptions } from "./ChatModeOptions";
import {
  Box,
  Button,
  CloseButton,
  Portal,
  Flex,
  HStack,
  IconButton,
  Input,
  Menu,
  MenuButton,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuItemOption,
  MenuGroup,
  MenuOptionGroup,
  Text,
  Textarea,
  useTheme,
  useToast,
} from "@chakra-ui/react";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronRight,
  Cloud,
  CircleAlert,
  RotateCcw,
  Laptop,
  Layers,
  MessageSquareText,
  Paperclip,
  Plus,
  Square,
  Settings2,
  X,
} from "lucide-react";
import { PluginIcon } from "@/components/customize/PluginIcon";
import type { PluginItem } from "@/types/plugin";
import useDriveConnected from "@/components/agent-workspace/useDriveConnected";
import LibraryItemIcon from "@/components/agent-workspace/LibraryItemIcon";
import { getFileIcon } from "@fastgpt/global/common/file/icon";
import { AgentSkillsIcon } from "@components/common/Icon";
import { ChatGptPluginsRailIcon, ChatGptSkillsNavIcon } from "@components/customize/CustomizeIcons";
import { createId } from "@shared/chat/messages";
import { useTranslation } from "next-i18next";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import MyTooltip from "@/components/ui/MyTooltip";

import {
  getReasoningEffortLabel,
  type ChatInputFile,
  type ChatInputProps,
  type ChatInputSubmitPayload,
  type ReasoningEffortLevel,
} from "../types/chatInput";
import type { UploadedFileArtifact } from "../types/fileArtifact";
import { formatUserSkillTag, normalizeAttachmentWorkspacePath, toFileTagLabel } from "../utils/chatPanelUtils";
import ModelCascader from "./ModelCascader";
import { withAuthHeaders } from "@features/auth/client/authClient";
import ConnectorAttachmentPicker from "./ConnectorAttachmentPicker";
import LibraryAttachmentPicker from "./LibraryAttachmentPicker";
import SlashFilePicker from "./SlashFilePicker";
import SkillMentionPicker from "./SkillMentionPicker";
import InlineSkillEditor, { decodeSkillTokenName, focusEditor, getEditorSelection, skillToken, skillTokenPattern } from "./InlineSkillEditor";

type LocalInputFile = ChatInputFile & {
  uploadState: "uploading" | "ready" | "error";
  uploadedArtifact?: UploadedFileArtifact;
  uploadError?: string;
};

const ChatInput = ({
  placeholder,
  artifactRevision,
  draftStorageKey,
  conversationLoading = false,
  workspaceLayout = false,
  workspaceComposer,
  isSending,
  model,
  modelOptions,
  modelGroups,
  modelLoading,
  thinkingEnabled = true,
  reasoningEffort = "high",
  showThinkingToggle = true,
  mode = "default",
  thinkingTooltipEnabled,
  thinkingTooltipDisabled,
  selectedSkill,
  selectedSkills,
  skillOptions = [],
  fileOptions = [],
  addFileRequest,
  selectionQuotes = [],
  onRemoveSelectionQuote,
  focusInputSignal,
  prefillText,
  prefillVersion,
  onChangeModel,
  onChangeMode,
  onChangeThinkingEnabled,
  onChangeReasoningEffort,
  onChangeSelectedSkill,
  onChangeSelectedSkills,
  onUploadFiles,
  onSend,
  onStop,
}: ChatInputProps) => {
  const toast = useToast();
  const composerRef = useRef<HTMLDivElement>(null);
  const addMenuModifiers = useMemo(() => [{
    name: "anchorToComposer",
    enabled: true,
    phase: "beforeRead" as const,
    fn: ({ state }: { state: {
      elements: { reference: { getBoundingClientRect: () => DOMRect }; popper: HTMLElement };
      rects: { reference: { x: number; y: number; width: number; height: number }; popper: { height: number } };
    } }) => {
      const composer = composerRef.current?.getBoundingClientRect();
      if (!composer) return;
      const { popper } = state.elements;
      const viewportHeight = popper.ownerDocument.documentElement.clientHeight;
      const spaceAbove = composer.top - 16;
      const spaceBelow = viewportHeight - composer.bottom - 16;
      const availableHeight = spaceAbove >= 240 ? spaceAbove : Math.max(spaceAbove, spaceBelow);
      popper.style.setProperty("--composer-menu-height", `${Math.max(0, availableHeight)}px`);
      state.rects.popper.height = popper.offsetHeight;
      const trigger = state.elements.reference.getBoundingClientRect();
      const reference = state.rects.reference;
      state.rects.reference = {
        x: reference.x + composer.left - trigger.left,
        y: reference.y + composer.top - trigger.top,
        width: composer.width,
        height: composer.height,
      };
    },
  }], []);
  const [showMenuSkills, setShowMenuSkills] = useState(false);
  const skillMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const skillMenuBackRef = useRef<HTMLButtonElement>(null);
  const showSkillMenuPage = (show: boolean) => {
    setShowMenuSkills(show);
    requestAnimationFrame(() => (show ? skillMenuBackRef : skillMenuTriggerRef).current?.focus());
  };
  const [composerPlugins, setComposerPlugins] = useState<Array<PluginItem & { chatAction?: { label: string; prompt: string } }>>();
  const [connectedFileProviders, setConnectedFileProviders] = useState<Set<string>>(() => new Set());
  const [attachmentProvider, setAttachmentProvider] = useState<"dropbox" | "sharepoint">();
  const [composerPluginsFailed, setComposerPluginsFailed] = useState(false);
  const openAddMenu = () => {
    setShowMenuSkills(false);
    if (!workspaceComposer?.onOpenPlugins) return;
    setComposerPlugins(undefined);
    setComposerPluginsFailed(false);
    void fetch("/api/plugins", { headers: withAuthHeaders() })
      .then(async (response) => {
        if (!response.ok) throw new Error("Plugin list request failed");
        const data: {
          plugins: PluginItem[];
          runtimeTools?: { webFetch: boolean; webSearch: boolean; siteStatus: boolean };
        } = await response.json();
        const { runtimeTools } = data;
        const chatActions: Record<string, { label: string; prompt: string }> = {};
        if (runtimeTools?.webFetch) {
          chatActions["builtin-web"] = runtimeTools.webSearch
            ? { label: "联网搜索", prompt: "联网搜索：" }
            : { label: "读取指定网页", prompt: "请读取这个网页：" };
        }
        if (runtimeTools?.siteStatus) {
          chatActions["builtin-site"] = {
            label: "查看当前项目站点状态",
            prompt: "查看当前项目的站点状态。",
          };
        }
        const connectorStatuses = await Promise.allSettled((["dropbox", "sharepoint"] as const).map(async (provider) => {
          const response = await fetch(`/api/library/connectors/${provider}?status=1`, { headers: withAuthHeaders() });
          if (!response.ok) return;
          const status = await response.json();
          if (status.configured && status.connected) return provider;
        }));
        const connected = new Set(connectorStatuses.flatMap((result) =>
          result.status === "fulfilled" && result.value ? [result.value] : []
        ));
        setConnectedFileProviders(connected);
        setComposerPlugins(data.plugins
          .filter((plugin) => plugin.installed && plugin.enabled && (
            plugin.connectorProvider === "google" || plugin.connectorProvider === "dropbox" ||
            plugin.connectorProvider === "sharepoint" || (plugin.isCustom && plugin.kind === "mcp") ||
            Object.hasOwn(chatActions, plugin.id)
          ))
          .map((plugin) => ({
            ...plugin,
            chatAction: Object.hasOwn(chatActions, plugin.id) ? chatActions[plugin.id] : undefined,
          })));
      })
      .catch(() => setComposerPluginsFailed(true));
  };
  const { t } = useTranslation();
  const theme = useTheme() as Record<string, any>;
  const chatInputTheme = theme?.workspace?.chatInput || {};
  const skillTheme = chatInputTheme?.skillMention || {};
  const pendingLibraryMention = useRef<{text:string;start:number;end:number}>();
  const [libraryQuery, setLibraryQuery] = useState<string>();
  const [librarySource, setLibrarySource] = useState<"library" | "drive">("library");
  const driveConnected = useDriveConnected();
  const [imageModeKey,setImageModeKey] = useState<string>();
  const imageMode = Boolean(draftStorageKey && imageModeKey === draftStorageKey);
  const [text, setText] = useState("");
  const [loadedDraftKey, setLoadedDraftKey] = useState<string>();
  useEffect(() => {
    if (!draftStorageKey) return;
    try {
      setImageModeKey(sessionStorage.getItem(draftStorageKey+":image-mode") ? draftStorageKey : undefined);
      setText(sessionStorage.getItem(draftStorageKey) ?? "");
    } catch {
      // Storage can be unavailable in restricted browser sessions.
    }
    setLoadedDraftKey(draftStorageKey);
  }, [draftStorageKey]);
  useEffect(() => {
    if (!artifactRevision) return;
    setText((draft) => draft ? `${draft}\n\n${artifactRevision.text}` : artifactRevision.text);
    const frame = requestAnimationFrame(() => {
      const editor = textAreaRef.current;
      if (editor) focusEditor(editor);
      artifactRevision.onApplied();
    });
    return () => cancelAnimationFrame(frame);
  }, [artifactRevision]);
  useEffect(() => {
    if (!draftStorageKey || loadedDraftKey !== draftStorageKey) return;
    try {
      if (text) sessionStorage.setItem(draftStorageKey, text);
      else sessionStorage.removeItem(draftStorageKey);
    } catch {
      // Draft editing still works without browser storage.
    }
  }, [draftStorageKey, loadedDraftKey, text]);
  const [files, setFiles] = useState<LocalInputFile[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [skillQuery, setSkillQuery] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [selectedFilePaths, setSelectedFilePaths] = useState<string[]>([]);
  useEffect(() => {
    const requestedPath = addFileRequest?.path?.trim();
    if (!requestedPath) return;
    const normalizedPath = requestedPath.startsWith("/") ? requestedPath : `/${requestedPath}`;
    setSelectedFilePaths((current) =>
      current.includes(normalizedPath) ? current : [...current, normalizedPath]
    );
    textAreaRef.current?.focus();
  }, [addFileRequest]);
  useEffect(() => {
    if (!focusInputSignal) return;
    const frame = requestAnimationFrame(() => {
      textAreaRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusInputSignal]);
  const [mentionRange, setMentionRange] = useState<{ start: number; end: number } | null>(null);
  const [fileRange, setFileRange] = useState<{ start: number; end: number } | null>(null);
  const inputBaseHeight = 50;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textAreaRef = useRef<HTMLDivElement>(null);
  const editorSelection = useRef<{ start: number; end: number }>();
  const skillPickerRef = useRef<HTMLDivElement | null>(null);
  const filePickerRef = useRef<HTMLDivElement | null>(null);
  const updateTriggerState = useCallback((value: string, cursorPosition: number) => {
    const safeCursor = Math.max(0, Math.min(cursorPosition, value.length));
    const prefix = value.slice(0, safeCursor);
    const skillMatch = prefix.match(/(^|\s)@([^\s@]*)$/);
    if (skillMatch) {
      const query = skillMatch[2] || "";
      const triggerStart = safeCursor - query.length - 1;
      setMentionRange({ start: triggerStart, end: safeCursor });
      setSkillQuery(query.toLowerCase());
      setFileRange(null);
      setFileQuery("");
      return;
    }
    const fileMatch = prefix.match(/(^|\s)\/([^\s/]*)$/);
    if (fileMatch) {
      const query = fileMatch[2] || "";
      const triggerStart = safeCursor - query.length - 1;
      setFileRange({ start: triggerStart, end: safeCursor });
      setFileQuery(query.toLowerCase());
      setMentionRange(null);
      setSkillQuery("");
      return;
    }
    setMentionRange(null);
    setSkillQuery("");
    setFileRange(null);
    setFileQuery("");
  }, []);
  const isInputLocked = isSending || isSubmitting;
  const hasUploadingFiles = useMemo(
    () => files.some((item) => item.uploadState === "uploading"),
    [files]
  );
  const hasUploadErrors = useMemo(
    () => files.some((item) => item.uploadState === "error"),
    [files]
  );

  const canSend = useMemo(
    () =>
      !conversationLoading &&
      !isSending &&
      !isSubmitting &&
      !hasUploadingFiles &&
      !hasUploadErrors &&
      (text.replace(skillTokenPattern(), "").trim().length > 0 || files.length > 0 || selectedFilePaths.length > 0 || selectionQuotes.length > 0),
    [conversationLoading, files.length, hasUploadErrors, hasUploadingFiles, isSending, isSubmitting, selectedFilePaths.length, selectionQuotes.length, text]
  );
  const selectedSkillList = useMemo(
    () => Array.from(new Set(Array.from(text.matchAll(skillTokenPattern()), (match) => decodeSkillTokenName(match[1])))),
    [text]
  );

  useEffect(() => {
    if (draftStorageKey && loadedDraftKey !== draftStorageKey) return;
    const requestedSkills = selectedSkills?.length ? selectedSkills : selectedSkill ? [selectedSkill] : [];
    if (!requestedSkills.some(Boolean)) return;

    setText((current) => {
      const existing = new Set(Array.from(current.matchAll(skillTokenPattern()), (match) => decodeSkillTokenName(match[1])));
      const additions = Array.from(new Set(requestedSkills.filter((name) => name && !existing.has(name))), skillToken);
      if (additions.length === 0) return current;
      return current + (current && !/\s$/.test(current) ? " " : "") + additions.join(" ") + " ";
    });
    if (onChangeSelectedSkills) onChangeSelectedSkills([]);
    else onChangeSelectedSkill?.(undefined);
  }, [draftStorageKey, loadedDraftKey, onChangeSelectedSkill, onChangeSelectedSkills, selectedSkill, selectedSkills]);

  const [disabledManagedSkills, setDisabledManagedSkills] = useState<Set<string>>(() => new Set());
  const [customSkillOptions, setCustomSkillOptions] = useState<Array<{ name: string; description?: string }>>([]);
  const managedSkillsRevision = workspaceComposer?.managedSkillsRevision;
  useEffect(() => {
    if (managedSkillsRevision === undefined) return;
    const controller = new AbortController();
    void fetch("/api/skills", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const { skills }: { skills: Array<{ name: string; description?: string; enabled: boolean; category: string }> } = await response.json();
        if (!controller.signal.aborted) {
          setCustomSkillOptions(skills.filter((skill) => skill.category === "custom" && skill.enabled));
          setDisabledManagedSkills(new Set(skills
            .filter((skill) => skill.category === "builtin" && !skill.enabled)
            .map((skill) => skill.name)));
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [managedSkillsRevision]);

  const availableSkillOptions = useMemo(
    () => {
      const available = new Map(customSkillOptions.map((skill) => [skill.name.toLowerCase(), skill]));
      for (const skill of skillOptions) {
        if (skill.name && !disabledManagedSkills.has(skill.name)) available.set(skill.name.toLowerCase(), skill);
      }
      return Array.from(available.values());
    },
    [customSkillOptions, disabledManagedSkills, skillOptions]
  );

  const filteredSkillOptions = useMemo(() => {
    const keyword = skillQuery.trim();
    const selectedSet = new Set(selectedSkillList);
    const ranked = [...availableSkillOptions].sort((a, b) => {
      const aSelected = selectedSet.has(a.name) ? 1 : 0;
      const bSelected = selectedSet.has(b.name) ? 1 : 0;
      // Unselected first, selected later (still visible).
      if (aSelected !== bSelected) return aSelected - bSelected;
      return a.name.localeCompare(b.name);
    });
    const library = {name:"/library", label:"从资料空间添加", description:"搜索文件或页面"};

    if (!keyword) return [...ranked.slice(0, 8), library];
    const matches = ranked
      .filter((item) => {
        const name = item.name.toLowerCase();
        const description = (item.description || "").toLowerCase();
        return name.includes(keyword) || description.includes(keyword);
      })
      .slice(0, 8);
    return [...matches, library];
  }, [availableSkillOptions, selectedSkillList, skillQuery]);
  const showSkillPicker =
    Boolean(mentionRange) &&
    !isSending &&
    !isSubmitting;
  const filteredFileOptions = useMemo(() => {
    const keyword = fileQuery.trim();
    const selectedSet = new Set(selectedFilePaths);
    const available = fileOptions
      .map((item) => normalizeAttachmentWorkspacePath(item))
      .filter(Boolean)
      .filter((item, index, arr) => arr.indexOf(item) === index)
      .filter((item) => !selectedSet.has(item));
    if (!keyword) return available.slice(0, 10);
    return available
      .filter((item) => item.toLowerCase().includes(keyword))
      .slice(0, 10);
  }, [fileOptions, fileQuery, selectedFilePaths]);
  const showFilePicker = Boolean(fileRange) && filteredFileOptions.length > 0 && !isSending && !isSubmitting;
  const inputPlaceholder = useMemo(() => {
    if (isSending) {
      return t("chat:generating", { defaultValue: "正在生成回复..." });
    }
    return placeholder ?? t("chat:input_placeholder", {
      defaultValue: "输入你的问题，按 Enter 发送，Shift + Enter 换行",
    });
  }, [isSending, placeholder, t]);
  const previewFiles = useMemo(
    () =>
      files.map((item) => {
        const icon = getFileIcon(item.file.name);
        const isImage = item.file.type.startsWith("image/") || icon === "image";
        return {
          ...item,
          icon,
          isImage,
          previewUrl: isImage ? URL.createObjectURL(item.file) : "",
        };
      }),
    [files]
  );

  useEffect(() => {
    return () => {
      previewFiles.forEach((item) => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      });
    };
  }, [previewFiles]);

  useEffect(() => {
    if (!prefillVersion || !prefillText?.trim()) return;
    setText((prev) => {
      const current = prev.trim();
      if (!current) return prefillText.trim();
      return `${prev}\n${prefillText.trim()}`;
    });
    const frame = requestAnimationFrame(() => {
      const editor = textAreaRef.current;
      if (editor) focusEditor(editor);
    });
    return () => cancelAnimationFrame(frame);
  }, [prefillText, prefillVersion]);

  useEffect(() => {
    setActiveSkillIndex(0);
  }, [skillQuery, showSkillPicker]);
  useEffect(() => {
    setActiveFileIndex(0);
  }, [fileQuery, showFilePicker]);
  useEffect(() => {
    if (!showSkillPicker || filteredSkillOptions.length === 0) return;
    setActiveSkillIndex((prev) => Math.min(prev, filteredSkillOptions.length - 1));
  }, [filteredSkillOptions.length, showSkillPicker]);
  useEffect(() => {
    if (!showFilePicker || filteredFileOptions.length === 0) return;
    setActiveFileIndex((prev) => Math.min(prev, filteredFileOptions.length - 1));
  }, [filteredFileOptions.length, showFilePicker]);
  useEffect(() => {
    if (!showSkillPicker) return;
    const container = skillPickerRef.current;
    if (!container) return;
    const activeNode = container.querySelector<HTMLElement>(`[data-skill-option-index="${activeSkillIndex}"]`);
    activeNode?.scrollIntoView({ block: "nearest" });
  }, [activeSkillIndex, showSkillPicker]);
  useEffect(() => {
    if (!showFilePicker) return;
    const container = filePickerRef.current;
    if (!container) return;
    const activeNode = container.querySelector<HTMLElement>(`[data-file-option-index="${activeFileIndex}"]`);
    activeNode?.scrollIntoView({ block: "nearest" });
  }, [activeFileIndex, showFilePicker]);

  const applySelectedSkill = useCallback(
    (skillName: string) => {
      if (skillName === "/library" && mentionRange) {
        pendingLibraryMention.current = {text,...mentionRange};
        setMentionRange(null);
        setSkillQuery("");
        const query = text.slice(mentionRange.start + 1, mentionRange.end);
        setLibraryQuery(/^(资料空间|文件|页面|library|drive|google)$/i.test(query) ? "" : query);
        return;
      }
      const range = mentionRange ?? editorSelection.current ?? { start: text.length, end: text.length };
      const before = text.slice(0, range.start);
      const after = text.slice(range.end);
      const token = skillToken(skillName);
      const insertion = `${before && !/\s$/.test(before) ? " " : ""}${token} `;
      setText(before + insertion + after);
      setMentionRange(null);
      setSkillQuery("");
      requestAnimationFrame(() => {
        const editor = textAreaRef.current;
        if (editor) focusEditor(editor, before.length + insertion.length);
      });
    },
    [mentionRange, text]
  );
  const applySelectedFile = useCallback(
    (filePath: string) => {
      if (!fileRange) return;
      const normalizedPath = normalizeAttachmentWorkspacePath(filePath);
      const nextText = `${text.slice(0, fileRange.start)}${text.slice(fileRange.end)}`;
      const nextCursor = fileRange.start;
      setText(nextText);
      setSelectedFilePaths((prev) => (prev.includes(normalizedPath) ? prev : [...prev, normalizedPath]));
      setFileRange(null);
      setFileQuery("");
      requestAnimationFrame(() => {
        const editor = textAreaRef.current;
        if (editor) focusEditor(editor, nextCursor);
      });
    },
    [fileRange, text]
  );

  const uploadSingleFile = useCallback(
    async (fileItem: LocalInputFile) => {
      try {
        const uploaded = await onUploadFiles([
          {
            id: fileItem.id,
            file: fileItem.file,
          },
        ]);
        const matched = uploaded.find((artifact) => artifact.id === fileItem.id) || uploaded[0];

        setFiles((prev) =>
          prev.map((item) =>
            item.id === fileItem.id
              ? matched
                ? {
                    ...item,
                    uploadState: "ready",
                    uploadedArtifact: matched,
                    uploadError: undefined,
                  }
                : {
                    ...item,
                    uploadState: "error",
                    uploadError: "上传失败，请重试",
                  }
              : item
          )
        );
        return matched ? undefined : "上传失败，请重试";
      } catch (error) {
        const message = error instanceof TypeError && /fetch|network|load failed/i.test(error.message)
          ? "连接失败，请检查网络后重试。"
          : (error instanceof Error && error.message.trim()) || "上传失败，请重试。";
        setFiles((prev) =>
          prev.map((item) =>
            item.id === fileItem.id
              ? {
                  ...item,
                  uploadState: "error",
                  uploadError: message,
                }
              : item
          )
        );
        return message;
      }
    },
    [onUploadFiles]
  );

  const retryUploadFile = useCallback(
    (fileItem: LocalInputFile) => {
      setFiles((prev) =>
        prev.map((item) =>
          item.id === fileItem.id
            ? {
                ...item,
                uploadState: "uploading",
                uploadError: undefined,
                uploadedArtifact: undefined,
              }
            : item
        )
      );
      void uploadSingleFile(fileItem);
    },
    [uploadSingleFile]
  );

  const onPickFiles = useCallback(
    async (picked: FileList | File[] | null, fromLibrary = false) => {
      if (!picked || picked.length === 0) return [];
      const pickedFiles = Array.isArray(picked) ? picked : Array.from(picked);
      const next = pickedFiles.map((file) => ({
        id: createId(),
        file,
        uploadState: "uploading" as const,
      }));
      setFiles((prev) => [...prev, ...next]);
      const errors: (string | undefined)[] = [];
      const batchSize = 6;
      for (let start = 0; start < next.length; start += batchSize) {
        const batch = next.slice(start, start + batchSize);
        errors.push(...await Promise.all(batch.map(uploadSingleFile)));
      }
      if (fromLibrary && errors.some(Boolean)) {
        const failedIds = new Set(next.filter((_, index) => errors[index]).map(item => item.id));
        setFiles(previous => previous.filter(item => !failedIds.has(item.id)));
      }
      return errors;
    },
    [uploadSingleFile]
  );
  const pendingDraftFocus = useRef<{ key: string | undefined; draftText: string }>();
  useLayoutEffect(() => {
    const pending = pendingDraftFocus.current;
    const editor = textAreaRef.current;
    if (!pending || !editor || isInputLocked || conversationLoading ||
      pending.key !== draftStorageKey || !text.endsWith(pending.draftText)) return;
    pendingDraftFocus.current = undefined;
    focusEditor(editor);
  }, [conversationLoading, draftStorageKey, isInputLocked, text]);

  const consumedLibraryDrafts = useRef(new WeakSet<object>());
  useEffect(() => {
    const draft = workspaceComposer?.libraryDraft;
    if (!draft || consumedLibraryDrafts.current.has(draft) ||
      loadedDraftKey !== draftStorageKey || draftStorageKey !== `aistudio:draft:${workspaceComposer?.projectToken}:${draft.chatId}`) return;
    consumedLibraryDrafts.current.add(draft);
    if (draft.imageMode) {
      setImageModeKey(draftStorageKey);
      try { sessionStorage.setItem(draftStorageKey+":image-mode","1"); } catch {}
      requestAnimationFrame(() => textAreaRef.current?.focus());
    }
    let draftText = draft.text ?? "";
    for (const name of new Set(draft.skills)) {
      const mention = `@${name}`;
      draftText = draftText.includes(mention)
        ? draftText.replace(mention, () => skillToken(name))
        : [skillToken(name), draftText].filter(Boolean).join(" ");
    }
    if (draftText) {
      pendingDraftFocus.current = { key: draftStorageKey, draftText };
      setText((previous) => previous ? previous + "\n\n" + draftText : draftText);
    }
    if (draft.files.length) void onPickFiles(draft.files);
    workspaceComposer?.onLibraryDraftConsumed?.();
  },[workspaceComposer,draftStorageKey,loadedDraftKey,onPickFiles]);
  const getPastedFiles = useCallback((data: DataTransfer | null) => {
    if (!data) return [] as File[];

    const itemFiles = Array.from(data.items || [])
      .map((item) => (item.kind === "file" ? item.getAsFile() : null))
      .filter((item): item is File => item instanceof File);

    if (itemFiles.length > 0) return itemFiles;

    return Array.from(data.files || []);
  }, []);

  const handleSend = useCallback(async () => {
    if (!canSend) return;
    const selectedFiles: ChatInputFile[] = files.map((item) => ({
      id: item.id,
      file: item.file,
    }));
    const uploadedFiles = files
      .map((item) => item.uploadedArtifact)
      .filter((item): item is UploadedFileArtifact => Boolean(item));

    const message = text.replace(skillTokenPattern(), "").trim();
    const payload: ChatInputSubmitPayload = {
      text: imageMode ? "创建图像：" + message : message,
      ...(selectedSkillList.length > 0 ? {
        bubbleText: (imageMode ? "创建图像：" : "") +
          text.replace(skillTokenPattern(), (_, name: string) => formatUserSkillTag(decodeSkillTokenName(name))).trim(),
      } : {}),
      files: selectedFiles,
      uploadedFiles,
      selectedSkill: selectedSkillList[0] || undefined,
      selectedSkills: selectedSkillList.length > 0 ? selectedSkillList : undefined,
      selectedFilePaths: selectedFilePaths.length > 0 ? selectedFilePaths : undefined,
      selectionQuotes: selectionQuotes.length > 0 ? selectionQuotes : undefined,
      thinkingEnabled: showThinkingToggle ? thinkingEnabled : undefined,
      reasoningEffort: workspaceLayout || showThinkingToggle ? reasoningEffort : undefined,
    };

    setIsSubmitting(true);
    try {
      await onSend(payload, { onAccepted: () => {
        setImageModeKey(undefined);
        try { sessionStorage.removeItem(draftStorageKey+":image-mode"); } catch {}
        setText("");
        setFiles([]);
        setSelectedFilePaths([]);
        if (fileInputRef.current) fileInputRef.current.value = "";
      } });
    } catch {
      toast({ status: "error", title: "发送失败", description: "请检查连接后重试。", isClosable: true });
    } finally {
      setIsSubmitting(false);
    }
  }, [canSend, imageMode, draftStorageKey, files, onSend, toast, reasoningEffort, selectedFilePaths, selectionQuotes, text, selectedSkillList, thinkingEnabled, showThinkingToggle, workspaceLayout]);

  return (
    <Box px={4} py={3}>
      <Flex
        ref={composerRef}
        bg="white"
        border={workspaceLayout ? "1px solid" : "0.5px solid"}
        borderColor={
          workspaceLayout
            ? isFocused
              ? "rgba(0,0,0,0.18)"
              : "rgba(0,0,0,0.09)"
            : isFocused
            ? "rgba(0,0,0,0.24)"
            : "rgba(0,0,0,0.18)"
        }
        borderRadius={workspaceLayout ? "22px" : "26px"}
        boxShadow={
          workspaceLayout
            ? isFocused
              ? "0px 4px 18px rgba(0, 0, 0, 0.06)"
              : "0px 2px 10px rgba(0, 0, 0, 0.035)"
            : isFocused
            ? "0px 5px 20px -4px rgba(19, 51, 107, 0.13)"
            : "0px 5px 16px -4px rgba(19, 51, 107, 0.08)"
        }
        direction="column"
        minH={workspaceLayout ? "96px" : "116px"}
        overflow="visible"
      >
        {selectionQuotes.length > 0 ? (
          <Flex gap={2.5} px={3.5} pt={3} pb={0.5} wrap="wrap" userSelect="none">
            {selectionQuotes.map((quote) => (
              <Box
                key={quote.id}
                position="relative"
                w="162px"
                minH="114px"
                bg="white"
                border="1px solid"
                borderColor="rgba(0, 0, 0, 0.11)"
                borderRadius="16px"
                px={3}
                py={2.5}
                display="flex"
                flexDirection="column"
                justifyContent="space-between"
                transition="border-color 0.15s, box-shadow 0.15s"
                _hover={{
                  borderColor: "rgba(0, 0, 0, 0.2)",
                  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.05)",
                }}
                sx={{
                  "@media (hover: hover) and (pointer: fine)": {
                    "&:not(:hover):not(:focus-within) .quote-card-close": { opacity: 0 },
                  },
                }}
              >
                <CloseButton
                  className="quote-card-close"
                  aria-label="移除选中引用"
                  size="sm"
                  w="20px"
                  h="20px"
                  fontSize="9px"
                  position="absolute"
                  top="-7px"
                  right="-7px"
                  bg="#18181b"
                  color="white"
                  borderRadius="full"
                  boxShadow="0 1px 4px rgba(0,0,0,0.2)"
                  _hover={{ bg: "#3f3f46" }}
                  transition="opacity 0.12s ease"
                  onClick={() => {
                    onRemoveSelectionQuote?.(quote.id);
                    textAreaRef.current?.focus();
                  }}
                />
                <Text
                  fontSize="12.5px"
                  lineHeight="1.45"
                  color="#3f3f46"
                  noOfLines={4}
                  wordBreak="break-word"
                  title={quote.text}
                >
                  {quote.text}
                </Text>
                <Flex align="center" gap={1.5} mt={2.5} color="#52525b">
                  <MessageSquareText size={13} strokeWidth={1.9} />
                  <Text fontSize="11.5px" fontWeight="500" color="#3f3f46">
                    选中引用
                  </Text>
                </Flex>
              </Box>
            ))}
          </Flex>
        ) : null}

        {previewFiles.length > 0 ? (
          <Flex gap="6px" mb={2} pt={2} px={3} userSelect="none" wrap="wrap">
            {previewFiles.map((item) => item.uploadState === "error" ? (
              <Flex key={item.id} align="center" gap={2} bg="#fffaf6" border="1px solid #eadbd0" borderRadius="12px"
                px={2.5} py={2} maxW="100%" minW={0}>
                <CircleAlert size={16} color="#975735" aria-hidden="true"/>
                <Box minW={0} maxW="200px"><Text noOfLines={1} fontSize="xs" fontWeight="600">{item.file.name}</Text>
                  <Text color="#785d4c" fontSize="11px" role="status">{item.uploadError || "上传未完成"}</Text></Box>
                <Button size="xs" variant="ghost" color="#754a32" leftIcon={<RotateCcw size={12}/>} onClick={() => retryUploadFile(item)}>重试</Button>
                <CloseButton size="sm" aria-label={`移除 ${item.file.name}`} onClick={() => setFiles(prev => prev.filter(file => file.id !== item.id))}/>
              </Flex>
            ) : (
              <Box
                key={item.id}
                aspectRatio={item.isImage ? 1 : 4}
                maxW={item.isImage ? "56px" : "224px"}
                w={item.isImage ? "12.5%" : "calc(50% - 3px)"}
              >
                <Box
                  sx={{ "@media (hover: hover) and (pointer: fine)": {
                    "&:not(:hover):not(:focus-within) .file-preview-close": { opacity: 0 },
                  } }}
                  alignItems="center"
                  border="1px solid #E2E8F0"
                  borderRadius="8px"
                  boxShadow="0px 2.571px 6.429px 0px rgba(19, 51, 107, 0.08), 0px 0px 0.643px 0px rgba(19, 51, 107, 0.08)"
                  h="100%"
                  pl={item.isImage ? 0 : 2}
                  position="relative"
                  w="100%"
                >
                  <CloseButton
                    bg="white"
                    borderRadius="999px"
                    transition="none"
                    className="file-preview-close"
                    aria-label={`移除附件 ${item.file.name}`}
                    onClick={() => {
                      setFiles((prev) => prev.filter((f) => f.id !== item.id));
                      textAreaRef.current?.focus();
                    }}
                    position="absolute"
                    right="-8px"
                    size="sm"
                    top="-8px"
                    zIndex={10}
                  />
                  {item.isImage ? (
                    <Box
                      alt={item.file.name}
                      as="img"
                      borderRadius="8px"
                      h="100%"
                      objectFit="contain"
                      src={item.previewUrl}
                      w="100%"
                    />
                  ) : (
                    <Flex align="center" gap={2} h="100%" pr={2}>
                      <LibraryItemIcon item={{name:item.file.name}}/>
                      <Box minW={0}>
                        <AttachmentFilename name={item.file.name}/>
                        <Text
                          color="gray.500"
                          fontSize="10px"
                          noOfLines={1}
                        >
                          {item.uploadState === "uploading"
                            ? "上传中..."
                            : "已上传"}
                        </Text>
                      </Box>
                    </Flex>
                  )}
                </Box>
              </Box>
            ))}
          </Flex>
        ) : null}

        <Flex align="center" px={2}>
          <Box position="relative" w="100%">
            {imageMode && <Flex align="center" gap={1} w="fit-content" mx={2} mt={2} pl={2} bg="gray.100" borderRadius="full">
              <Text fontSize="sm">创建图像</Text><CloseButton size="sm" aria-label="退出创建图像" onClick={()=>{
                setImageModeKey(undefined);
                try { sessionStorage.removeItem(draftStorageKey+":image-mode"); } catch {}
                textAreaRef.current?.focus();
              }}/></Flex>}
            {selectedFilePaths.length > 0 ? (
              <Flex px={3} pt={2.5} pb={0.5}>
                <Flex align="center" gap={1.5} wrap="wrap">
                  {selectedFilePaths.map((filePath) => {
                    const fileLabel = toFileTagLabel(filePath);
                    return (
                      <Flex
                        key={filePath}
                        role="group"
                        align="center"
                        bg="#F4F4F5"
                        borderRadius="8px"
                        color="#18181B"
                        gap={1.5}
                        h="24px"
                        maxW="300px"
                        pl={2}
                        pr={1}
                        transition="all 0.15s ease"
                        _hover={{ bg: "#E4E4E7" }}
                      >
                        <LibraryItemIcon item={{ name: fileLabel }} compact />
                        <Text fontSize="12px" fontWeight={500} noOfLines={1} title={filePath}>
                          {fileLabel}
                        </Text>
                        <Box
                          as="button"
                          type="button"
                          onClick={() => {
                            setSelectedFilePaths((prev) => prev.filter((item) => item !== filePath));
                          }}
                          aria-label={`移除文件 ${fileLabel}`}
                          display="flex"
                          alignItems="center"
                          justifyContent="center"
                          w="16px"
                          h="16px"
                          borderRadius="full"
                          color="#71717A"
                          opacity={0.75}
                          transition="all 0.15s ease"
                          _hover={{ opacity: 1, bg: "rgba(0, 0, 0, 0.08)", color: "#18181B" }}
                        >
                          <X size={11} />
                        </Box>
                      </Flex>
                    );
                  })}
                </Flex>
              </Flex>
            ) : null}
            <Flex align="center" gap={2} px={3} pt={3}>
              <InlineSkillEditor
                editorRef={textAreaRef}
                value={text}
                placeholder={inputPlaceholder}
                disabled={isInputLocked}
                minHeight={inputBaseHeight}
                maxHeight={128}
                onFocus={() => setIsFocused(true)}
                onBlur={() => {
                  const editor = textAreaRef.current;
                  if (editor) editorSelection.current = getEditorSelection(editor);
                  setIsFocused(false);
                  window.setTimeout(() => {
                    setMentionRange(null);
                    setSkillQuery("");
                    setFileRange(null);
                    setFileQuery("");
                  }, 80);
                }}
                onChange={(nextValue, caretOffset) => {
                  setText(nextValue);
                  updateTriggerState(nextValue, caretOffset);
                }}
                onPaste={(event) => {
                  if (isInputLocked) return;
                  const pastedFiles = getPastedFiles(event.clipboardData);
                  if (pastedFiles.length === 0) return;

                  void onPickFiles(pastedFiles);
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                  if (event.key === "Backspace" && !text && !showFilePicker && !showSkillPicker) {
                    if (selectedFilePaths.length > 0) {
                      event.preventDefault();
                      setSelectedFilePaths((prev) => prev.slice(0, -1));
                      return;
                    }
                  }
                  if (showFilePicker) {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setActiveFileIndex((prev) => (prev + 1) % filteredFileOptions.length);
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setActiveFileIndex((prev) => (prev <= 0 ? filteredFileOptions.length - 1 : prev - 1));
                      return;
                    }
                    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                      event.preventDefault();
                      const picked = filteredFileOptions[activeFileIndex];
                      if (picked) {
                        applySelectedFile(picked);
                      }
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setFileRange(null);
                      setFileQuery("");
                      return;
                    }
                  }
                  if (showSkillPicker) {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setActiveSkillIndex((prev) => (prev + 1) % filteredSkillOptions.length);
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setActiveSkillIndex((prev) =>
                        prev <= 0 ? filteredSkillOptions.length - 1 : prev - 1
                      );
                      return;
                    }
                    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                      event.preventDefault();
                      const picked = filteredSkillOptions[activeSkillIndex];
                      if (picked?.name) {
                        applySelectedSkill(picked.name);
                      } else {
                        setMentionRange(null);
                        setSkillQuery("");
                      }
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setMentionRange(null);
                      setSkillQuery("");
                      return;
                    }
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    handleSend();
                  }
                }}
              />
            </Flex>
            {showFilePicker ? (
              <SlashFilePicker
                activeIndex={activeFileIndex}
                onPick={applySelectedFile}
                options={filteredFileOptions}
                pickerRef={filePickerRef}
              />
            ) : null}
            {showSkillPicker ? (
              <SkillMentionPicker
                activeIndex={activeSkillIndex}
                onPick={applySelectedSkill}
                options={filteredSkillOptions}
                pickerRef={skillPickerRef}
              />
            ) : null}
          </Box>
        </Flex>

        <Flex align="center" h="44px" justify="space-between" mt="auto" pb={2} pl={3} pr={3}>
          <Flex align="center" gap={workspaceLayout ? 1 : 2} minW={0} flex={workspaceLayout ? 1 : undefined}>
            <Input
              ref={fileInputRef}
              display="none"
              onChange={(event) => onPickFiles(event.target.files)}
              type="file"
              multiple
            />
            <Menu placement="top-start" matchWidth modifiers={addMenuModifiers} isLazy onOpen={openAddMenu}>
              <MenuButton as={IconButton} aria-label="添加文件和工具" icon={<Plus size={18} strokeWidth={1.8}/>}
                isDisabled={isSending || isSubmitting} size="sm" variant="ghost" borderRadius="full"/>
              <Portal>
                <MenuList w="full" minW={0} maxH="min(440px, 65dvh, var(--composer-menu-height, 440px))" overflowY="auto" overscrollBehavior="contain"
                  borderRadius="16px" p={1.5} borderColor="gray.200" boxShadow="lg"
                  sx={{ ".chakra-menu__menuitem": { borderRadius: "9px", minHeight: "34px" } }}>
                  {showMenuSkills ? (
                    <>
                      <MenuItem ref={skillMenuBackRef} icon={<ArrowLeft size={16} />} closeOnSelect={false} onClick={() => showSkillMenuPage(false)}>
                        返回添加菜单
                      </MenuItem>
                      <MenuDivider />
                      {availableSkillOptions.length === 0 ? (
                        <MenuItem fontSize="13px" borderRadius="8px" isDisabled>
                          暂无可用技能
                        </MenuItem>
                      ) : (
                        availableSkillOptions.map((skill) => {
                          const checked = selectedSkillList.includes(skill.name);
                          return (
                            <MenuItem
                              key={skill.name}
                              borderRadius="10px"
                              px={2.5}
                              py={2}
                              bg={checked ? "rgba(2, 133, 255, 0.06)" : "transparent"}
                              _hover={{ bg: checked ? "rgba(2, 133, 255, 0.1)" : "#F4F4F5" }}
                              onClick={() => {
                                if (!checked) {
                                  applySelectedSkill(skill.name);
                                  return;
                                }
                                setText((current) => current.replace(skillTokenPattern(), (token, name) =>
                                  decodeSkillTokenName(name) === skill.name ? "" : token
                                ));
                              }}
                            >
                              <HStack justify="space-between" w="full" spacing={2.5}>
                                <Flex align="center" gap={2} minW={0}>
                                  <Box color={checked ? "#0285FF" : "#6B7280"} flexShrink={0}>
                                    <ChatGptSkillsNavIcon size={14} />
                                  </Box>
                                  <Box minW={0}>
                                    <Text fontSize="13px" fontWeight={checked ? "600" : "500"} color="#111827" noOfLines={1}>
                                      {skill.name}
                                    </Text>
                                    {skill.description && (
                                      <Text fontSize="11px" color="#6B7280" noOfLines={1}>
                                        {skill.description}
                                      </Text>
                                    )}
                                  </Box>
                                </Flex>
                                {checked ? (
                                  <Box color="#0285FF" flexShrink={0}>
                                    <Check size={14} />
                                  </Box>
                                ) : null}
                              </HStack>
                            </MenuItem>
                          );
                        })
                      )}
                      {workspaceComposer?.onOpenSkills && (
                        <>
                          <MenuDivider />
                          <MenuItem icon={<ChatGptSkillsNavIcon size={16} />} onClick={workspaceComposer.onOpenSkills}>
                            管理技能
                          </MenuItem>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <MenuGroup title="添加">
                        <MenuItem icon={<Paperclip size={16} />} onClick={() => fileInputRef.current?.click()}>从本机上传</MenuItem>
                        <MenuItem icon={<Layers size={16} />} onClick={() => setLibraryQuery("")}>从资料空间添加</MenuItem>
                        <ChatModeOptions mode={mode} onChangeMode={onChangeMode} />
                        {workspaceLayout && showThinkingToggle && (
                          <MenuItem onClick={() => onChangeThinkingEnabled?.(!thinkingEnabled)}>
                            深度思考：{thinkingEnabled ? "开启" : "关闭"}
                          </MenuItem>
                        )}
                        <MenuItem ref={skillMenuTriggerRef} icon={<ChatGptSkillsNavIcon size={16} />} closeOnSelect={false} onClick={() => showSkillMenuPage(true)}>
                          <Flex justify="space-between" align="center">
                            {selectedSkillList.length ? `技能 · ${selectedSkillList.length}` : "技能"}
                            <ChevronRight size={15} />
                          </Flex>
                        </MenuItem>
                      </MenuGroup>
                      {workspaceComposer?.onOpenPlugins && (
                        <MenuGroup title="插件">
                          {!composerPlugins && !composerPluginsFailed && (
                            <MenuItem isDisabled>正在加载插件…</MenuItem>
                          )}
                          {composerPlugins?.length === 0 && (
                            <MenuItem isDisabled>暂无已启用的插件</MenuItem>
                          )}
                          {composerPlugins?.map((plugin) => (
                            <MenuItem key={plugin.id} icon={<PluginIcon plugin={plugin} size="sm" />}
                              onClick={() => {
                                if (plugin.connectorProvider === "google" && driveConnected) {
                                  setLibrarySource("drive");
                                  setLibraryQuery("");
                                  return;
                                }
                                if (plugin.connectorProvider === "dropbox" || plugin.connectorProvider === "sharepoint") {
                                  if (connectedFileProviders.has(plugin.connectorProvider)) {
                                    setAttachmentProvider(plugin.connectorProvider);
                                  } else {
                                    workspaceComposer.onOpenPlugins?.(plugin.id);
                                  }
                                  return;
                                }
                                const prompt = plugin.chatAction?.prompt;
                                if (prompt) {
                                  setText((current) => current ? `${current}\n${prompt}` : prompt);
                                  requestAnimationFrame(() => {
                                    if (textAreaRef.current) focusEditor(textAreaRef.current);
                                  });
                                } else {
                                  workspaceComposer.onOpenPlugins?.(plugin.id);
                                }
                              }}>
                              <Flex align={{ base: "start", sm: "center" }} direction={{ base: "column", sm: "row" }}
                                columnGap={2} w="full" minW={0}>
                                <Text fontSize="sm" overflowWrap="anywhere" flexShrink={0} maxW={{ base: "100%", sm: "55%" }}>
                                  {plugin.name}
                                </Text>
                                <Text noOfLines={1} fontSize="xs" color="gray.500">
                                  {plugin.connectorProvider === "google"
                                    ? driveConnected ? "从云盘添加文件" : "连接账号"
                                    : plugin.connectorProvider
                                      ? connectedFileProviders.has(plugin.connectorProvider) ? "从云盘添加文件" : "连接账号"
                                      : plugin.chatAction?.label ?? "已启用 · 管理配置"}
                                </Text>
                              </Flex>
                            </MenuItem>
                          ))}
                          {workspaceComposer.onAddPlugin && (
                            <>
                              <MenuItem icon={<ChatGptPluginsRailIcon size={16} />} onClick={() => workspaceComposer.onAddPlugin?.("upload")}>
                                导入并安装插件
                              </MenuItem>
                              <MenuItem icon={<Plus size={16} />} onClick={() => workspaceComposer.onAddPlugin?.("mcp")}>
                                添加 MCP 插件
                              </MenuItem>
                            </>
                          )}
                          <MenuItem icon={<ChatGptPluginsRailIcon size={16} />} onClick={() => workspaceComposer.onOpenPlugins?.()}>
                            {composerPluginsFailed ? "打开插件页查看" : "管理插件"}
                          </MenuItem>
                        </MenuGroup>
                      )}
                    </>
                  )}
                </MenuList>
              </Portal>
            </Menu>
            {attachmentProvider && <ConnectorAttachmentPicker
              provider={attachmentProvider}
              finalFocusRef={textAreaRef}
              onClose={() => setAttachmentProvider(undefined)}
              onAdd={(picked) => onPickFiles(picked, true)}
            />}
            {libraryQuery !== undefined && <LibraryAttachmentPicker finalFocusRef={textAreaRef} initialQuery={libraryQuery} initialSource={librarySource} onClose={() => {
              setLibrarySource("library");
              pendingLibraryMention.current = undefined;
              setLibraryQuery(undefined);
            }} onAdd={async picked => {
              const errors = await onPickFiles(picked, true);
              const mention = pendingLibraryMention.current;
              if (mention && errors.some(error => !error)) {
                setText(current => current === mention.text ? current.slice(0,mention.start) + current.slice(mention.end) : current);
                pendingLibraryMention.current = undefined;
              }
              return errors;
            }}/>}
            {workspaceLayout ? (
              <>
                <Box w="1px" h="16px" bg="rgba(0,0,0,0.1)" mx={1} flexShrink={0} />
                {workspaceComposer?.onOpenDeviceManagement && (
                  <Menu onOpen={workspaceComposer.onOpenHostMenu} placement="top-start" gutter={8} isLazy>
                    <MenuButton as={Button} size="xs" h="30px" px={2.5} maxW="150px" variant="ghost"
                      borderRadius="full" fontSize="12.5px" fontWeight="500" color="#374151"
                      _hover={{ bg: "#f4f4f5" }}
                      aria-label={`访问设备：${workspaceComposer.deviceAccessLabel}`}
                      isLoading={workspaceComposer.requestingDeviceAccess} loadingText="等待授权"
                      leftIcon={(workspaceComposer.deviceAccessKind ?? workspaceComposer.projectDeviceKind) === "remote-vm" ? <Cloud size={14} /> : <Laptop size={14} />}
                      rightIcon={<ChevronRight size={13} color="#9ca3af" />}>
                      <Text as="span" isTruncated>{workspaceComposer.deviceAccessLabel || "访问设备"}</Text>
                    </MenuButton>
                    <Portal>
                      <MenuList w="min(320px, calc(100vw - 24px))" minW={0} maxH="65dvh" overflowY="auto"
                        p={2} borderRadius="14px" border="1px solid #dfe5ef" boxShadow="0 10px 36px rgba(33,48,78,.13)">
                        <MenuOptionGroup type="radio" title="AI 访问设备"
                          value={workspaceComposer.selectedDeviceId || workspaceComposer.deviceAccessKind || "project"}
                          onChange={value => {
                            if (value === "project") workspaceComposer.onClearDeviceAccess?.();
                            else if (value === "remote-vm") workspaceComposer.onSelectCloudHost?.();
                            else {
                              const device = workspaceComposer.devices?.find(item => item.deviceId === value);
                              if (device) workspaceComposer.onSelectDeviceHost?.(device);
                            }
                          }}>
                          <MenuItemOption value="project">
                            <HStack minW={0}>
                              {workspaceComposer.projectDeviceKind === "connector" ? <Laptop size={16} /> : <Cloud size={16} />}
                              <Text noOfLines={1}>{workspaceComposer.projectDeviceLabel}</Text>
                              <Text fontSize="xs" color="ink.muted" flexShrink={0}>项目默认</Text>
                            </HStack>
                          </MenuItemOption>
                          {(workspaceComposer.projectDeviceKind !== "remote-vm" || workspaceComposer.deviceAccessKind === "remote-vm") && (
                          <MenuItemOption value="remote-vm">
                            <HStack><Cloud size={16} /><Text>云电脑</Text>
                              <Text fontSize="xs" color="ink.muted">{getCloudHostStatusMeta(workspaceComposer.cloudHostStatus).label}</Text>
                            </HStack>
                          </MenuItemOption>
                          )}
                          {workspaceComposer.devices?.map(device => (
                            <MenuItemOption key={device.deviceId} value={device.deviceId} isDisabled={!device.online}>
                              <HStack minW={0}><Laptop size={16} /><Text noOfLines={1}>{device.name}</Text>
                                <Text fontSize="xs" color="ink.muted" flexShrink={0}>{device.online ? "在线" : "离线"}</Text>
                              </HStack>
                            </MenuItemOption>
                          ))}
                        </MenuOptionGroup>
                        <MenuDivider my={2} />
                        <MenuItem px={3} borderRadius="8px" fontSize="sm" icon={<Settings2 size={15} />}
                          onClick={workspaceComposer.onOpenDeviceManagement}>我的设备</MenuItem>
                      </MenuList>
                    </Portal>
                  </Menu>
                )}

                <Box flex={1} />
              </>
            ) : (
              <>
                <ModelCascader
                  showLabel={false}
                  disabled={Boolean(modelLoading || isSending || isSubmitting)}
                  loading={modelLoading}
                  model={model}
                  modelOptions={modelOptions}
                  modelGroups={modelGroups}
                  onChangeModel={onChangeModel}
                />
                {showThinkingToggle ? (
                  <MyTooltip
                    fontSize="12px"
                    label={
                      thinkingEnabled
                        ? thinkingTooltipEnabled || "思考模式：开启"
                        : thinkingTooltipDisabled || "思考模式：关闭"
                    }
                    openDelay={150}
                  >
                    <IconButton
                      _hover={{
                        bg: "rgba(0, 0, 0, 0.04)",
                      }}
                      aria-label={thinkingEnabled ? "关闭思考模式" : "开启思考模式"}
                      bg="transparent"
                      border="1px solid transparent"
                      borderRadius="8px"
                      h="30px"
                      icon={
                        <Flex
                          align="center"
                          bg={thinkingEnabled ? "#16A34A" : "transparent"}
                          border="1px solid"
                          borderColor={thinkingEnabled ? "#16A34A" : "#CBD5E1"}
                          borderRadius="999px"
                          h="20px"
                          justify="center"
                          w="20px"
                        >
                          <Box
                            as="svg"
                            fill="none"
                            h="13px"
                            viewBox="0 0 24 24"
                            w="13px"
                          >
                            <path
                              d="M12 3.5a6.5 6.5 0 0 0-3.5 12v2.25a.75.75 0 0 0 .75.75h5.5a.75.75 0 0 0 .75-.75V15.5A6.5 6.5 0 0 0 12 3.5Z"
                              stroke={thinkingEnabled ? "#FFFFFF" : "#64748B"}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth="2"
                            />
                            <path
                              d="M9.5 21h5"
                              stroke={thinkingEnabled ? "#FFFFFF" : "#64748B"}
                              strokeLinecap="round"
                              strokeWidth="2"
                            />
                          </Box>
                        </Flex>
                      }
                      isDisabled={Boolean(modelLoading || isSending || isSubmitting)}
                      minW="30px"
                      onClick={() => onChangeThinkingEnabled?.(!thinkingEnabled)}
                      variant="ghost"
                    />
                  </MyTooltip>
                ) : null}
              </>
            )}
            {hasUploadingFiles ? (
              <Text color="myGray.500" fontSize="xs">
                {t("chat:uploading_files", { defaultValue: "文件上传中..." })}
              </Text>
            ) : null}
          </Flex>

          <Flex align="center" gap={1.5}>
            {workspaceLayout && (
              <ModelCascader
                showLabel
                rightSuffix={getReasoningEffortLabel(reasoningEffort, true)}
                reasoningEffort={reasoningEffort}
                onChangeReasoningEffort={onChangeReasoningEffort}
                disabled={Boolean(modelLoading || isSending || isSubmitting)}
                loading={modelLoading}
                model={model}
                modelOptions={modelOptions}
                modelGroups={modelGroups}
                onChangeModel={onChangeModel}
              />
            )}
            <IconButton
              _hover={{
                bg: isSending
                  ? "rgba(15, 23, 42, 0.14)"
                  : canSend
                  ? "#111827"
                  : "#e4e4e7",
              }}
              aria-label={
                isSending
                  ? t("chat:stop_generating", { defaultValue: "停止生成" })
                  : t("common:Send", { defaultValue: "发送" })
              }
              bg={isSending ? "#f4f4f5" : canSend ? "#0f172a" : "#f4f4f5"}
              color={isSending ? "#0f172a" : canSend ? "#ffffff" : "#71717a"}
              borderRadius="full"
              h="34px"
              icon={
                isSending ? (
                  <Square size={13} fill="currentColor" />
                ) : (
                  <ArrowUp size={17} strokeWidth={2.2} />
                )
              }
              isDisabled={!isSending && !canSend}
              onClick={() => {
                if (isSending) {
                  onStop?.();
                  return;
                }
                handleSend();
              }}
              type="button"
              w="34px"
              minW="34px"
            />
          </Flex>
        </Flex>
      </Flex>
      {imageMode && <ImageCreationTemplates onUpload={photos=>void onPickFiles(photos)} onPick={prompt=>{
        setText(previous=>previous.trim() ? prompt+"\n\n"+previous : prompt);
        requestAnimationFrame(()=>textAreaRef.current?.focus());
      }}/>}
    </Box>
  );
};

export default ChatInput;
