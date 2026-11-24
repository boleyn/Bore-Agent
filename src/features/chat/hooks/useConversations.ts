import Router, { type NextRouter } from "next/router";
import { useCallback, useEffect, useRef, useState } from "react";
import { createChatId } from "@shared/chat/ids";
import { buildWorkspaceLocation, parseWorkspaceRoute } from "@shared/workspaceRoute";

import {
  deleteConversation as deleteConversationRequest,
  deleteAllConversations as deleteAllConversationsRequest,
  getConversation,
  listConversations,
} from "../services/conversations";

import type { Conversation, ConversationSummary } from "@/types/conversation";

const CONVERSATION_LIST_CACHE_MS = 1000;
const conversationListCache = new Map<
  string,
  { data: ConversationSummary[]; expiresAt: number }
>();
const conversationListRequests = new Map<string, Promise<ConversationSummary[]>>();

export interface UseConversationsResult {
  conversations: ConversationSummary[];
  activeConversation: Conversation | null;
  isLoadingConversation: boolean;
  isInitialized: boolean;
  loadConversation: (id: string, options?: { refresh?: boolean }) => Promise<void>;
  selectConversation: (id: string) => void;
  startNewConversation: () => void;
  ensureConversation: () => Promise<Conversation | null>;
  updateConversationTitle: (id: string, title: string) => void;
  deleteConversation: (id: string) => Promise<void>;
  deleteAllConversations: () => Promise<void>;
}

interface UseConversationsOptions {
  externalConversationId?: string;
}

export function useConversations(
  token: string,
  router: NextRouter,
  options?: UseConversationsOptions
): UseConversationsResult {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [isLoadingConversation, setIsLoadingConversation] = useState(false);
  const [initializedToken, setInitializedToken] = useState<string>();
  const isInitialized = initializedToken === token;
  const pendingConversation = useRef<{ id: string } | null>(null);
  const activeConversationIdRef = useRef<string | null>(null);


  const parsedRoute = parseWorkspaceRoute(router.asPath, router.query);
  const isChatRoute = parsedRoute.view === "chat";
  const selectedConversationId = isChatRoute ? parsedRoute.conversationId : options?.externalConversationId;

  const updateChatRoute = useCallback((id?: string, replace = false) => {
    if (parseWorkspaceRoute(Router.asPath, Router.query).view !== "chat") return;
    const loc = buildWorkspaceLocation(Router.pathname, {
      view: "chat",
      conversationId: id,
      extraQuery: { di: Router.query.di, workspaceProject: Router.query.workspaceProject },
    });
    void Router[replace ? "replace" : "push"](loc.href, loc.as, { shallow: true, scroll: false });
  }, []);

  const refreshConversations = useCallback(async (): Promise<ConversationSummary[]> => {
    const cacheKey = token;
    const cached = conversationListCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
    const inflight = conversationListRequests.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const request = (async () => listConversations(token))();
    conversationListRequests.set(cacheKey, request);
    try {
      const data = await request;
      conversationListCache.set(cacheKey, {
        data,
        expiresAt: Date.now() + CONVERSATION_LIST_CACHE_MS,
      });
      return data;
    } finally {
      conversationListRequests.delete(cacheKey);
    }
  }, [token]);

  const loadConversation = useCallback(
    async (id: string, options?: { refresh?: boolean }) => {
      if (!token) return;
      if (activeConversationIdRef.current === id && !options?.refresh) return;
      if (pendingConversation.current?.id === id) return;
      const request = { id };
      pendingConversation.current = request;
      if (activeConversationIdRef.current !== id) {
        activeConversationIdRef.current = null;
        setActiveConversation(null);
      }
      setIsLoadingConversation(true);
      try {
        const conversation = await getConversation(token, id);
        if (conversation && pendingConversation.current === request) {
          activeConversationIdRef.current = conversation.id;
          setActiveConversation(conversation);
          setConversations((prev) => {
            const exists = prev.some((item) => item.id === conversation.id);
            if (exists) {
              return prev.map((item) =>
                item.id === conversation.id
                  ? { ...item, title: conversation.title, updatedAt: conversation.updatedAt }
                  : item
              );
            }
            return [conversation, ...prev];
          });
        }
      } finally {
        if (pendingConversation.current === request) {
          setIsLoadingConversation(false);
          pendingConversation.current = null;
        }
      }
    },
    [token]
  );

  const createNewConversation = useCallback(async (): Promise<Conversation | null> => {
    if (!token) return null;
    const now = new Date().toISOString();
    const previousConversation = activeConversation;
    const conversation: Conversation = {
      id: createChatId(),
      title: "新对话",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };

    pendingConversation.current = null;
    setIsLoadingConversation(false);
    activeConversationIdRef.current = conversation.id;
    setActiveConversation(conversation);
    setConversations((prev) => {
      // 若上一个对话为空且仅为本地草稿，切换到新对话时从历史列表中移除
      if (previousConversation && previousConversation.messages.length === 0) {
        return prev.filter((item) => item.id !== previousConversation.id && item.id !== conversation.id);
      }
      return prev.filter((item) => item.id !== conversation.id);
    });

    return conversation;
  }, [activeConversation, token]);

  const selectConversation = useCallback((id: string) => {
    updateChatRoute(id);
  }, [updateChatRoute]);

  const resetConversation = useCallback(() => {
    pendingConversation.current = null;
    activeConversationIdRef.current = null;
    setActiveConversation(null);
    setIsLoadingConversation(false);
  }, []);

  const startNewConversation = useCallback(() => {
    resetConversation();
    updateChatRoute();
  }, [resetConversation, updateChatRoute]);

  const ensureConversation = useCallback(async () => {
    if (activeConversation && (!selectedConversationId || activeConversation.id === selectedConversationId)) {
      if (!selectedConversationId) updateChatRoute(activeConversation.id, true);
      return activeConversation;
    }
    if (selectedConversationId) return null;
    const conversation = await createNewConversation();
    if (conversation) updateChatRoute(conversation.id, true);
    return conversation;
  }, [activeConversation, createNewConversation, selectedConversationId, updateChatRoute]);

  const updateConversationTitle = useCallback((id: string, title: string) => {
    const now = new Date().toISOString();
    setActiveConversation((prev) => (prev?.id === id ? { ...prev, title, updatedAt: now } : prev));
    setConversations((prev) => {
      const index = prev.findIndex((item) => item.id === id);
      if (index >= 0) {
        const next = [...prev];
        next[index] = { ...next[index], title, updatedAt: now };
        return next;
      }
      const active = activeConversationIdRef.current === id ? activeConversation : null;
      return [
        {
          id,
          title,
          createdAt: active?.createdAt || now,
          updatedAt: now,
        },
        ...prev,
      ];
    });
  }, []);

  const deleteConversation = useCallback(
    async (id: string) => {
      setConversations((prev) => prev.filter((item) => item.id !== id));
      if (id === selectedConversationId || activeConversationIdRef.current === id) {
        resetConversation();
        updateChatRoute(undefined, true);
      }
      if (token) await deleteConversationRequest(token, id);
    },
    [resetConversation, selectedConversationId, token, updateChatRoute]
  );

  const deleteAllConversations = useCallback(async () => {
    setConversations([]);
    resetConversation();
    updateChatRoute(undefined, true);
    if (token) await deleteAllConversationsRequest(token);
  }, [resetConversation, token, updateChatRoute]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    void refreshConversations().then((list) => {
      if (!active) return;
      setConversations(list);
      setInitializedToken(token);
    });
    return () => { active = false; };
  }, [refreshConversations, token]);

  useEffect(() => () => { pendingConversation.current = null; }, [token]);

  useEffect(() => {
    if (!token || !router.isReady) return;
    let current = true;
    queueMicrotask(() => {
      if (!current) return;
      if (selectedConversationId) void loadConversation(selectedConversationId);
      else if (isChatRoute) resetConversation();
    });
    return () => {
      current = false;
      if (pendingConversation.current?.id === selectedConversationId) {
        pendingConversation.current = null;
      }
    };
  }, [isChatRoute, loadConversation, resetConversation, router.isReady, selectedConversationId, token]);

  return {
    conversations,
    activeConversation,
    isLoadingConversation,
    isInitialized,
    loadConversation,
    selectConversation,
    startNewConversation,
    ensureConversation,
    updateConversationTitle,
    deleteConversation,
    deleteAllConversations,
  };
}
