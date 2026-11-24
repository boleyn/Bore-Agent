---
name: plugin-creator
description: Create and scaffold plugin directories for Codex with a required `.codex-plugin/plugin.json`, optional plugin folders/files, and baseline placeholders you can edit before publishing or testing. Use when Codex needs to create a new personal plugin, add optional plugin structure, or generate or update personal or repo-root `.agents/plugins/marketplace.json` entries for plugin ordering and availability metadata.
---

# Plugin Creator

## 伯仁使用方式

本技能的上游是 OpenAI 的 [plugin-creator](https://github.com/openai/plugins/tree/981b02c0c44058b595f3b4180002c3ae3c806d40/.agents/skills/plugin-creator)。以下 Codex 脚手架说明适用于用户明确要求创建 Codex 插件的情形。

在伯仁中，先确认插件的用途、需要的工具和数据来源，以及用户是否已有公开 HTTPS 的 Streamable HTTP MCP 地址。需求不齐时先向用户提问。已有可用服务器时，创建一个 ZIP 插件包，并在根目录放置 `manifest.json`，写入 `name`、`description` 和 `url`。验证 ZIP 中的清单能被解析，再提供文件给用户通过「插件 → 添加 → 导入 MCP 插件」安装。令牌在插件管理页填入，避免打包进文件。还没有服务器时可以编写和验证 MCP 源码；只有得到可用的地址后才生成可安装的包。

生成伯仁 ZIP 时优先使用随技能提供的脚本。从存在该脚本的沙箱路径运行，输出路径使用当前项目可交付的文件位置：

```bash
python3 /skills/plugin-creator/scripts/package_beron_plugin.py \
  --name "<插件名称>" --description "<插件用途>" \
  --url "<真实 MCP HTTPS 地址>" --output "<输出文件>.zip"
```

在沙箱里，上游文件挂载于 `/skills/plugin-creator`。如果文件系统不可用，可以用 `Skill` 工具读取本技能列出的文本参考文件。


## Quick Start

1. Run the scaffold script:

```bash
  # Plugin names are normalized to lower-case hyphen-case and must be <= 64 chars.
  # The generated folder and plugin.json name are always the same.
# Run from repo root (or replace .agents/... with the absolute path to this SKILL).
# By default creates in ~/plugins/<plugin-name>.
python3 .agents/skills/plugin-creator/scripts/create_basic_plugin.py <plugin-name>
```

2. Open `<plugin-path>/.codex-plugin/plugin.json` and replace `[TODO: ...]` placeholders.

3. Generate or update the personal marketplace entry when the plugin should appear in Codex UI ordering:

```bash
# Personal marketplace entries default to ~/.agents/plugins/marketplace.json.
python3 .agents/skills/plugin-creator/scripts/create_basic_plugin.py my-plugin --with-marketplace
```

If the current Git repo already has `.agents/plugins/marketplace.json` and the user has not said
whether the plugin is personal or shared with their team, ask before generating a marketplace entry.
When they choose the repo marketplace, use:

```bash
python3 .agents/skills/plugin-creator/scripts/create_basic_plugin.py my-plugin \
  --path ./plugins \
  --marketplace-path ./.agents/plugins/marketplace.json \
  --with-marketplace
```

4. Generate/adjust optional companion folders as needed:

```bash
python3 .agents/skills/plugin-creator/scripts/create_basic_plugin.py my-plugin \
  --path <parent-plugin-directory> \
  --marketplace-path <marketplace-json-path> \
  --with-skills --with-hooks --with-scripts --with-assets --with-mcp --with-apps --with-marketplace
```

`<parent-plugin-directory>` is the directory where the plugin folder `<plugin-name>` will be created (for example `~/code/plugins`).

## What this skill creates

- Default marketplace-backed scaffolds are personal: `~/plugins/<plugin-name>/` plus
  `~/.agents/plugins/marketplace.json`.
- If the current Git repo already has `.agents/plugins/marketplace.json` and the user has not said
  personal vs team, ask which marketplace to update before generating a marketplace entry.
- Creates plugin root at `/<parent-plugin-directory>/<plugin-name>/`.
- Always creates `/<parent-plugin-directory>/<plugin-name>/.codex-plugin/plugin.json`.
- Fills the manifest with the full schema shape, placeholder values, and the complete `interface` section.
- Creates or updates the selected marketplace when `--with-marketplace` is set.
  - If the marketplace file does not exist yet, seed top-level `name` plus `interface.displayName` placeholders before adding the first plugin entry.
- `<plugin-name>` is normalized using skill-creator naming rules:
  - `My Plugin` → `my-plugin`
  - `My--Plugin` → `my-plugin`
  - underscores, spaces, and punctuation are converted to `-`
  - result is lower-case hyphen-delimited with consecutive hyphens collapsed
- Supports optional creation of:
  - `skills/`
  - `hooks/`
  - `scripts/`
  - `assets/`
  - `.mcp.json`
  - `.app.json`

## Marketplace workflow

- Personal plugins use `~/.agents/plugins/marketplace.json`.
- Repo/team plugins use `<repo-root>/.agents/plugins/marketplace.json`.
- Marketplace root metadata supports top-level `name` plus optional `interface.displayName`.
- Treat plugin order in `plugins[]` as render order in Codex. Append new entries unless a user explicitly asks to reorder the list.
- `displayName` belongs inside the marketplace `interface` object, not individual `plugins[]` entries.
- Each generated marketplace entry must include all of:
  - `policy.installation`
  - `policy.authentication`
  - `category`
- Default new entries to:
  - `policy.installation: "AVAILABLE"`
  - `policy.authentication: "ON_INSTALL"`
- Override defaults only when the user explicitly specifies another allowed value.
- Allowed `policy.installation` values:
  - `NOT_AVAILABLE`
  - `AVAILABLE`
  - `INSTALLED_BY_DEFAULT`
- Allowed `policy.authentication` values:
  - `ON_INSTALL`
  - `ON_USE`
- Treat `policy.products` as an override. Omit it unless the user explicitly requests product gating.
- The generated plugin entry shape is:

```json
{
  "name": "plugin-name",
  "source": {
    "source": "local",
    "path": "./plugins/plugin-name"
  },
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "ON_INSTALL"
  },
  "category": "Productivity"
}
```

- Use `--force` only when intentionally replacing an existing marketplace entry for the same plugin name.
- If the selected marketplace file does not exist yet, create it with top-level `"name"`, an `"interface"` object containing `"displayName"`, and a `plugins` array, then add the new entry.

- For a brand-new marketplace file, the root object should look like:

```json
{
  "name": "[TODO: marketplace-name]",
  "interface": {
    "displayName": "[TODO: Marketplace Display Name]"
  },
  "plugins": [
    {
      "name": "plugin-name",
      "source": {
        "source": "local",
        "path": "./plugins/plugin-name"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

## Required behavior

- Outer folder name and `plugin.json` `"name"` are always the same normalized plugin name.
- Do not remove required structure; keep `.codex-plugin/plugin.json` present.
- Keep manifest values as placeholders until a human or follow-up step explicitly fills them.
- If creating files inside an existing plugin path, use `--force` only when overwrite is intentional.
- Preserve any existing marketplace `interface.displayName`.
- When generating marketplace entries, always write `policy.installation`, `policy.authentication`, and `category` even if their values are defaults.
- Add `policy.products` only when the user explicitly asks for that override.
- Keep marketplace `source.path` relative to the selected marketplace root as `./plugins/<plugin-name>`.
- When the workflow created or updated a marketplace-backed plugin, end the final user-facing
  response with a short Codex app handoff. Say `To view this in the Codex app:` and write
  `View <normalized plugin name>` and `Share <normalized plugin name>` as Markdown links, not raw
  URLs or code spans.
- The View deeplink uses `codex://plugins/<normalized plugin name>?marketplacePath=<absolute marketplace.json path>`.
  The Share deeplink uses the same URL with `&mode=share`.
- Replace the placeholders with the real normalized plugin name and absolute `marketplace.json`
  path from the scaffolded plugin. URL-encode the path segment and query value when needed.
- Do not add `pluginName` or `hostId` query parameters to these deeplinks. Codex derives both after
  the user clicks the link.
- Do not emit the `View <normalized plugin name>` or `Share <normalized plugin name>` links when no marketplace entry was
  created or updated.

## Reference to exact spec sample

For the exact canonical sample JSON for both plugin manifests and marketplace entries, use:

- `references/plugin-json-spec.md`

## Validation

After editing `SKILL.md`, run:

```bash
python3 <path-to-skill-creator>/scripts/quick_validate.py .agents/skills/plugin-creator
```
