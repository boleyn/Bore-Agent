import { useEffect } from "react";
import { useRouter } from "next/router";
import { Flex, Spinner } from "@chakra-ui/react";
import { useAuth } from "@/contexts/AuthContext";

const PUBLIC_ROUTES = new Set([
  "/login",
  "/auth/feishu/login",
  "/auth/feishu/callback",
  "/feishu/oauth/callback",
  "/share/preview/[shareId]",
  "/s/[slug]",
  "/404",
  "/500",
  "/_error",
]);

const AuthGuard = ({ children }: { children: React.ReactNode }) => {
  const { isReady, pathname, asPath, replace } = useRouter();
  const { user, loading } = useAuth();
  const isPublic = PUBLIC_ROUTES.has(pathname);

  useEffect(() => {
    if (!isReady || isPublic || loading || user) return;
    void replace({ pathname: "/login", query: { lastRoute: asPath } });
  }, [isReady, isPublic, loading, user, asPath, replace]);

  if (!isPublic && (loading || !user)) {
    return (
      <Flex minH="100vh" align="center" justify="center" bg="gray.50">
        <Spinner size="xl" color="blue.500" />
      </Flex>
    );
  }

  return <>{children}</>;
};

export default AuthGuard;
