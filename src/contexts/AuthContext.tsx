import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from "react";
import { useToast } from "@chakra-ui/react";
import { clearAuthToken, getAuthToken, withAuthHeaders } from "@features/auth/client/authClient";
import type { AuthUser } from "../types/auth";

type AuthContextValue = {
  user: AuthUser | null;
  loading: boolean;
  loadUser: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const sessionRequest = useRef<AbortController>();
  const logoutPending = useRef(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const loadUser = useCallback(async () => {
    if (logoutPending.current) return;
    sessionRequest.current?.abort();
    const controller = new AbortController();
    sessionRequest.current = controller;
    const token = getAuthToken();
    try {
      const response = await fetch("/api/auth/me", {
        headers: withAuthHeaders(),
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) {
        if (!controller.signal.aborted) {
          if (response.status === 401 && getAuthToken() === token) clearAuthToken();
          setUser(null);
        }
        return;
      }
      const data = await response.json();
      if (!controller.signal.aborted) setUser(data.user ?? data);
    } catch {
      if (!controller.signal.aborted) setUser(null);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => { if (mounted) void loadUser(); });
    const syncSession = (event: StorageEvent) => {
      if (event.key !== "authToken" && event.key !== null) return;
      if (getAuthToken()) {
        void loadUser();
      } else {
        sessionRequest.current?.abort();
        setUser(null);
        setLoading(false);
      }
    };
    const restoreSession = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setLoading(true);
      void loadUser();
    };
    window.addEventListener("storage", syncSession);
    window.addEventListener("pageshow", restoreSession);
    return () => {
      mounted = false;
      sessionRequest.current?.abort();
      window.removeEventListener("storage", syncSession);
      window.removeEventListener("pageshow", restoreSession);
    };
  }, [loadUser]);

  const logout = useCallback(async () => {
    if (logoutPending.current) return;
    logoutPending.current = true;
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: withAuthHeaders(),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("退出登录失败");
      sessionRequest.current?.abort();
      clearAuthToken();
      window.location.replace("/login");
    } catch {
      toast({ title: "退出登录失败，请重试", status: "error" });
    } finally {
      logoutPending.current = false;
    }
  }, [toast]);

  const value: AuthContextValue = { user, loading, loadUser, logout };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
