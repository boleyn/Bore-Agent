import { Box, HStack, Text, VStack } from "@chakra-ui/react";
import { keyframes } from "@emotion/react";

const floatBob = keyframes`
  0%, 100% {
    transform: translateY(0px) rotate(-1.5deg);
  }
  50% {
    transform: translateY(-7px) rotate(1.5deg);
  }
`;

const haloPulse = keyframes`
  0%, 100% {
    transform: scale(0.92);
    opacity: 0.45;
  }
  50% {
    transform: scale(1.1);
    opacity: 0.85;
  }
`;

const shadowPulse = keyframes`
  0%, 100% {
    transform: scaleX(1);
    opacity: 0.25;
  }
  50% {
    transform: scaleX(0.8);
    opacity: 0.14;
  }
`;

const dotBounce = keyframes`
  0%, 80%, 100% {
    transform: translateY(0);
    opacity: 0.35;
  }
  40% {
    transform: translateY(-3px);
    opacity: 1;
  }
`;

type BoreLoadingProps = {
  label?: string;
  size?: number;
  py?: number;
};

export default function BoreLoading({
  label = "伯仁正在加载中",
  size = 52,
  py = 14,
}: BoreLoadingProps) {
  return (
    <VStack spacing={3} py={py} align="center" justify="center" role="status" aria-live="polite">
      <Box position="relative" w={`${size + 24}px`} h={`${size + 18}px`} display="flex" alignItems="center" justifyContent="center">
        {/* 柔和星环光晕 */}
        <Box
          position="absolute"
          w={`${size + 14}px`}
          h={`${size + 14}px`}
          borderRadius="full"
          bg="radial-gradient(circle, rgba(170,169,242,0.34) 0%, rgba(255,167,97,0.12) 55%, transparent 75%)"
          animation={`${haloPulse} 2s ease-in-out infinite`}
          pointerEvents="none"
        />
        {/* 伯仁小机器人悬浮 */}
        <Box
          as="img"
          src="/icon/logo.svg"
          alt="伯仁"
          w={`${size}px`}
          h={`${size}px`}
          position="relative"
          zIndex={1}
          animation={`${floatBob} 1.8s ease-in-out infinite`}
          sx={{ willChange: "transform" }}
        />
        {/* 底部投影 */}
        <Box
          position="absolute"
          bottom="0px"
          w={`${Math.round(size * 0.56)}px`}
          h="6px"
          borderRadius="full"
          bg="rgba(41, 37, 79, 0.22)"
          filter="blur(2px)"
          animation={`${shadowPulse} 1.8s ease-in-out infinite`}
          pointerEvents="none"
        />
      </Box>

      {label && (
        <HStack spacing={1.5} color="ink.secondary" fontSize="sm">
          <Text>{label}</Text>
          <HStack spacing={1} pt="2px">
            {[0, 1, 2].map((idx) => (
              <Box
                key={idx}
                boxSize="4px"
                borderRadius="full"
                bg="#8b87e8"
                animation={`${dotBounce} 1.2s ease-in-out ${idx * 0.16}s infinite`}
              />
            ))}
          </HStack>
        </HStack>
      )}
    </VStack>
  );
}
