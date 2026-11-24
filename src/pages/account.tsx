import type { GetServerSideProps } from "next";
import NextLink from "next/link";
import {
  Avatar,
  Badge,
  Box,
  Button,
  Card,
  CardBody,
  Flex,
  Heading,
  HStack,
  Spinner,
  Text,
} from "@chakra-ui/react";

import { useAuth } from "@/contexts/AuthContext";
import { getAuthUserFromRequest } from "@server/auth/ssr";

const AccountPage = () => {
  const { user, loading, logout } = useAuth();

  return (
    <Flex minH="100vh" bg="gray.50" px={{ base: 6, lg: 12 }} py={{ base: 8, lg: 10 }}>
      <Box maxW="920px" w="100%" mx="auto">
        <Flex justify="space-between" align={{ base: "flex-start", md: "center" }} mb={8} gap={4}>
          <Box>
            <Heading size="lg" mb={2}>
              账号管理
            </Heading>
            <Text color="gray.600">查看你的账户信息与登录状态。</Text>
          </Box>
          <Button variant="outline" as={NextLink} href="/">
            返回工作台
          </Button>
        </Flex>

        <Card borderRadius="2xl">
          <CardBody>
            {loading ? (
              <Flex justify="center" align="center" minH="220px">
                <Spinner size="lg" />
              </Flex>
            ) : (
              <Flex direction={{ base: "column", md: "row" }} gap={6} align="center">
                <Avatar size="xl" name={user?.displayName || user?.username || "用户"} src={user?.avatar || "/icons/defaultAvatar.svg"} />
                <Box flex="1">
                  <HStack spacing={3} mb={3} flexWrap="wrap">
                    <Heading size="md">{user?.displayName || user?.username || "未命名用户"}</Heading>
                    <Badge colorScheme="blue" variant="subtle">
                      {user?.provider === "feishu" ? "飞书登录" : "密码登录"}
                    </Badge>
                  </HStack>
                  <Text color="gray.600" mb={2}>
                    账号：{user?.contact || "未绑定联系方式"}
                  </Text>
                  <Text color="gray.500" fontSize="sm">
                    用户 ID：{user?.id || "-"}
                  </Text>
                </Box>
                <Button colorScheme="red" onClick={logout}>
                  退出登录
                </Button>
              </Flex>
            )}
          </CardBody>
        </Card>
      </Box>
    </Flex>
  );
};

export default AccountPage;

export const getServerSideProps: GetServerSideProps = async (context) => {
  const authUser = getAuthUserFromRequest(context.req);
  if (!authUser) {
    return {
      redirect: {
        destination: `/login?lastRoute=${encodeURIComponent(context.resolvedUrl)}`,
        permanent: false,
      },
    };
  }

  return { props: {} };
};
