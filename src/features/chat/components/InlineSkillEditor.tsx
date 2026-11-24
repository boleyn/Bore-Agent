import { getSkillDisplayName } from "../utils/chatPanelUtils";
import React, { useLayoutEffect, useRef } from "react";
import { Box } from "@chakra-ui/react";

type InlineSkillEditorProps = {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  minHeight?: number;
  maxHeight?: number;
  onChange: (nextValue: string, caretOffset: number) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onPaste?: (event: React.ClipboardEvent<HTMLDivElement>) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  editorRef?: React.RefObject<HTMLDivElement>;
};

const SKILL_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="display:inline-block;vertical-align:-2px;margin-right:3px;flex-shrink:0;"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.643 1.497a2.53 2.53 0 0 1 2.69.083l1.746 1.177a2.53 2.53 0 0 1 1.113 2.094v5.317c0 .896-.475 1.725-1.247 2.178l-3.68 2.16a2.52 2.52 0 0 1-2.69-.085l-1.654-1.115a2.53 2.53 0 0 1-1.113-2.094v-5.43c0-.894.475-1.723 1.246-2.176zm-.101 9.689q-.058.032-.117.057v2.49q.16-.048.309-.133l3.68-2.16c.45-.265.728-.749.728-1.272V8.48zm-3.683.026c0 .49.243.95.65 1.224l1.654 1.115q.101.068.212.117v-2.463q-.055-.026-.105-.06L3.859 9.514zm3.683-3.81q-.056.032-.117.057v2.577l4.58-2.692a.5.5 0 0 1 .137-.054V4.85q-.001-.075-.01-.148zM3.86 5.782v2.463L6.375 9.95V7.42q-.053-.027-.104-.06l-2.41-1.627zm5.888-3.33a1.48 1.48 0 0 0-1.573-.05l-3.588 2.11a1.5 1.5 0 0 0-.305.237l2.578 1.743c.045.03.104.032.151.004l4.65-2.734a1.5 1.5 0 0 0-.168-.135z"/></svg>`;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildRichHtml(value: string): string {
  if (!value) return "";
  const parts: string[] = [];
  const regex = skillTokenPattern();
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(value)) !== null) {
    const skillName = decodeSkillTokenName(match[1]);
    if (match.index > lastIndex) {
      parts.push(escapeHtml(value.slice(lastIndex, match.index)).replace(/\n/g, "<br>"));
    }
    parts.push(
      `<span contenteditable="false" data-skill="${escapeHtml(skillName).replace(/"/g, "&quot;")}" style="display:inline-flex;align-items:center;color:#0285FF;font-weight:500;user-select:all;vertical-align:baseline;">${SKILL_ICON_SVG}<span>${escapeHtml(getSkillDisplayName(skillName))}</span></span>`,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < value.length) {
    parts.push(escapeHtml(value.slice(lastIndex)).replace(/\n/g, "<br>"));
  }
  return parts.join("");
}

function serializeDom(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent || "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const skill = el.getAttribute("data-skill");
    if (skill) {
      out += skillToken(skill);
      return;
    }
    if (el.tagName === "BR") {
      out += "\n";
      return;
    }
    if (el.tagName === "DIV" || el.tagName === "P") {
      if (out.length > 0 && !out.endsWith("\n")) out += "\n";
    }
    el.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return out.replace(/\u00a0/g, " ");
}

export function getEditorSelection(root: HTMLElement): { start: number; end: number } | undefined {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return;
  const offset = (node: Node, position: number) => {
    const prefix = document.createRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(node, position);
    const container = document.createElement("div");
    container.appendChild(prefix.cloneContents());
    return serializeDom(container).length;
  };
  return {
    start: offset(range.startContainer, range.startOffset),
    end: offset(range.endContainer, range.endOffset),
  };
}

export function skillToken(name: string) {
  return `@[${encodeURIComponent(name)}]`;
}

export function skillTokenPattern() {
  return /@\[((?:[a-zA-Z0-9_.!~*'()-]|%[a-fA-F0-9]{2})+)\]/g;
}

export function decodeSkillTokenName(encoded: string) {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export function focusEditor(root: HTMLDivElement, offset = Infinity) {
  root.focus();
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  for (const node of root.childNodes) {
    if (node instanceof Text) {
      if (offset <= node.length) {
        range.setStart(node, offset);
        break;
      }
      offset -= node.length;
    } else if (node instanceof HTMLElement) {
      const skill = node.dataset.skill;
      const length = skill ? skillToken(skill).length : node.tagName === "BR" ? 1 : serializeDom(node).length;
      if (offset <= length) {
        if (offset === 0) range.setStartBefore(node);
        else range.setStartAfter(node);
        break;
      }
      offset -= length;
    }
  }
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export default function InlineSkillEditor({
  value,
  placeholder,
  disabled,
  minHeight = 44,
  maxHeight = 128,
  onChange,
  onFocus,
  onBlur,
  onPaste,
  onKeyDown,
  editorRef,
}: InlineSkillEditorProps) {
  const internalRef = useRef<HTMLDivElement>(null);
  const ref = editorRef || internalRef;
  const composingRef = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || composingRef.current) return;
    const currentSerialized = serializeDom(el);
    if (currentSerialized !== value) {
      el.innerHTML = buildRichHtml(value);
    }
  }, [value, ref]);

  const emitChange = () => {
    const el = ref.current;
    if (!el) return;
    const next = serializeDom(el);
    const caret = getEditorSelection(el)?.end ?? next.length;
    onChange(next, caret);
  };

  return (
    <Box position="relative" flex="1" minW={0}>
      {!value && placeholder ? (
        <Box
          pointerEvents="none"
          position="absolute"
          top="2px"
          left="0"
          color="#707070"
          fontSize="15px"
          lineHeight="1.5"
          userSelect="none"
        >
          {placeholder}
        </Box>
      ) : null}
      <Box
        ref={ref}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        outline="none"
        color="myGray.700"
        fontSize="15px"
        fontWeight={400}
        lineHeight="1.55"
        minH={`${minHeight}px`}
        maxH={`${maxHeight}px`}
        overflowY="auto"
        whiteSpace="pre-wrap"
        wordBreak="break-word"
        onFocus={onFocus}
        onBlur={onBlur}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          emitChange();
        }}
        onInput={() => {
          if (composingRef.current) return;
          emitChange();
        }}
      />
    </Box>
  );
}
