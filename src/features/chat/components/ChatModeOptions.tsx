import { Box, MenuItem, Text } from "@chakra-ui/react";
import { Check, Lightbulb, Play, Target } from "lucide-react";
import type { ChatInputProps } from "../types/chatInput";

export const modeOptions = {
  default: { label: "执行", description: "直接处理任务", Icon: Play },
  plan: { label: "计划", description: "先制定方案，再开始执行", Icon: Lightbulb },
  goal: { label: "目标", description: "持续推进，直到达成目标", Icon: Target },
} as const;

export function ChatModeOptions({
  mode = "default",
  onChangeMode,
}: Pick<ChatInputProps, "mode" | "onChangeMode">) {
  return (
    <>
      {(Object.keys(modeOptions) as Array<keyof typeof modeOptions>).map(
        (value) => {
          const { label, description, Icon } = modeOptions[value];
          return (
            <MenuItem
              key={value}
              icon={<Icon size={16} strokeWidth={1.7} />}
              role="menuitemradio"
              aria-checked={mode === value}
              fontSize="14px"
              onClick={() => onChangeMode?.(value)}
            >
              <Box
                as="span"
                display="flex"
                alignItems="center"
                justifyContent="space-between"
              >
                <Box as="span" minW={0}>
                  {label}
                  <Text as="span" ml={2} color="gray.500" fontSize="xs">
                    {description}
                  </Text>
                </Box>
                {mode === value && <Check size={15} />}
              </Box>
            </MenuItem>
          );
        },
      )}
    </>
  );
}
