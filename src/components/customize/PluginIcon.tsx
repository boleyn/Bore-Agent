import React, { useState } from "react";
import { Globe, LayoutTemplate, Plug, Terminal, Webhook } from "lucide-react";
import type { PluginItem } from "@/types/plugin";

type PluginIconProps = {
  plugin: Pick<PluginItem, "id" | "iconDataUrl" | "iconKey" | "iconBg" | "iconText" | "iconColor" | "name">;
  size?: "sm" | "md" | "lg";
};

export function PluginIcon({ plugin, size = "md" }: PluginIconProps) {
  const [imgError, setImgError] = useState(false);

  const boxClass =
    size === "sm"
      ? "h-5 w-5 rounded-[5px]"
      : size === "lg"
      ? "h-12 w-12 rounded-2xl"
      : "h-9 w-9 rounded-xl";

  const svgSize = size === "sm" ? "h-3.5 w-3.5" : size === "lg" ? "h-7 w-7" : "h-5 w-5";

  const slug = plugin.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const knownRealIcon = slug && !plugin.iconKey.startsWith("builtin") && plugin.iconKey !== "mcp" && plugin.iconKey !== "api";

  if ((plugin.iconDataUrl || knownRealIcon) && !imgError) {
    return (
      <img
        src={plugin.iconDataUrl || `/icons/plugins/${slug}.png`}
        alt={plugin.name}
        onError={() => setImgError(true)}
        className={`shrink-0 object-contain ${boxClass}`}
      />
    );
  }

  const renderFallback = () => {
    switch (plugin.iconKey) {
      case "web":
        return <Globe className={`${svgSize} text-blue-600`} />;
      case "site":
        return <LayoutTemplate className={`${svgSize} text-emerald-600`} />;
      case "mcp":
        return <Plug className={`${svgSize} text-white`} />;
      case "api":
        return <Webhook className={`${svgSize} text-white`} />;
      case "data":
        return <Terminal className={`${svgSize} text-indigo-600`} />;
      default:
        return (
          <span
            className={size === "sm" ? "text-[10px] font-bold" : "text-xs font-bold"}
            style={{ color: plugin.iconColor || "#111827" }}
          >
            {plugin.iconText}
          </span>
        );
    }
  };

  return (
    <div
      className={`flex shrink-0 items-center justify-center border border-neutral-200/70 ${boxClass}`}
      style={{ backgroundColor: plugin.iconBg }}
    >
      {renderFallback()}
    </div>
  );
}
