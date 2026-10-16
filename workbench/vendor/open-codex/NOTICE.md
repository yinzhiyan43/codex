# open-codex UI attribution and modifications

Portions of the sidebar and settings layout are adapted from [solrizon-ai/open-codex](https://github.com/solrizon-ai/open-codex/tree/3362b6bb790cb70485c026d39768e41affc2ce9b).

Copyright 2025 solrizon-ai. Licensed under the Apache License, Version 2.0; the unmodified complete license is included in [LICENSE](LICENSE). The pinned source tree contains no NOTICE file. The source copyright notice is retained here and in adapted source comments.

Source reference: `3362b6bb790cb70485c026d39768e41affc2ce9b`, main inspected 2026-10-16. Adapted files: `src/renderer/components/Sidebar.tsx`, `sidebar/SettingsButton.tsx`, `sidebar/ProjectsSection.tsx`, `sidebar/ProjectRow.tsx`, `sidebar/SessionRow.tsx` (all sidebar paths relative to components); `src/renderer-settings/SettingsApp.tsx`, `components/SettingsSidebar.tsx`, `components/SectionShell.tsx` (settings component paths relative to renderer-settings).

**Modifications (2026-10-16):** JSX/Tailwind layout and row styling translated into the existing plain DOM/CSS frontend (`ui/sidebar.ts`, `ui/settings.ts`, `ui/index.html`, `ui/style.css`). Retained the workbench dark palette, Phosphor icons, navigation, controller actions, send confirmations, history pagination and read-only previews. Added native modal navigation, accessible labels/focus handling, loaded-list filtering, stable group keys and host-owned UI preferences. No React/Radix/Lucide dependencies or third-party backend/config/account handlers were copied. Only presentation layout is adapted; no claim of full application or theme parity.

Settings controls are implemented locally for workbench-only sidebar visibility/width, list density, reading size and group expansion. Shared Codex TOML, model/reasoning/speed, authentication, permissions, MCP, hooks, browser and Claude Code controls are not imported. No bundled third-party binary, fonts or logos were copied.
