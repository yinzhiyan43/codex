// Layout adapted from open-codex Sidebar/ProjectsSection/ProjectRow/SessionRow.
// Apache-2.0, Copyright 2025 solrizon-ai; modified for the existing DOM/controller.
// See ../vendor/open-codex/NOTICE.md. No third-party backend actions are imported.
import type { DesktopView } from "../desktop-host/demo-controller.ts";
export function renderSidebar(next: DesktopView, query: string, collapsed: (id: string) => boolean, canUpdate: boolean): void {
  const list = document.getElementById("project-list")!;
  const focus = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset : null;
  const focusKey = focus?.group ?? focus?.thread ?? focus?.project;
  list.replaceChildren();
  query = query.toLocaleLowerCase().trim();
  let count = 0;
  for (const project of next.projects) {
    const matchesGroup = project.name.toLocaleLowerCase().includes(query);
    const visible = matchesGroup ? project.threads : project.threads.filter(t => t.title.toLocaleLowerCase().includes(query));
    if (query && !visible.length && !matchesGroup) continue;
    count += visible.length;
    const group = document.createElement("section"); group.className = "sidebar-group";
    const heading = document.createElement("div"); heading.className = "project-heading";
    const button = document.createElement("button"); button.className = "project-row"; button.type = "button";
    button.title = project.name; button.dataset.group = project.id;
    const expanded = !!query || !collapsed(project.id);
    button.setAttribute("aria-expanded", String(expanded)); button.setAttribute("aria-controls", "threads-" + project.id);
    button.disabled = !!query; button.setAttribute("aria-disabled", String(!canUpdate || !!query));
    const icon = document.createElement("i"); icon.className = "ph ph-folder-open"; icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span"); label.className = "row-title"; label.textContent = project.name;
    const caret = document.createElement("i"); caret.className = "ph " + (expanded ? "ph-caret-down" : "ph-caret-right"); caret.setAttribute("aria-hidden", "true");
    button.append(icon, label, caret); heading.append(button);
    if (next.mode === "synthetic") {
      const open = document.createElement("button"); open.className = "project-open"; open.dataset.project = project.id;
      open.title = "打开项目：" + project.name; open.setAttribute("aria-label", open.title); open.textContent = "↗"; heading.append(open);
    }
    group.append(heading);
    const threads = document.createElement("div"); threads.className = "group-threads"; threads.id = "threads-" + project.id; threads.hidden = !expanded;
    for (const row of visible) {
      const thread = document.createElement("button"); thread.type = "button"; thread.className = "thread-row";
      thread.textContent = row.title; thread.title = row.title; thread.dataset.thread = row.id;
      thread.disabled = !!next.chatStatus?.historyMode && next.connection !== "ready";
      thread.setAttribute("aria-current", String(row.id === next.route.threadId)); threads.append(thread);
    }
    if (!visible.length && !query) { const empty = document.createElement("p"); empty.className = "group-empty"; empty.textContent = "暂无已加载会话"; threads.append(empty); }
    group.append(threads); list.append(group);
  }
  document.getElementById("sidebar-count")!.textContent = query ? `${count} 条匹配的已加载会话` : `${count} 条已加载会话`;
  if (!list.childElementCount) { const empty = document.createElement("p"); empty.className = "search-empty"; empty.textContent = "没有匹配的已加载会话"; list.append(empty); }
  // Keep keyboard focus stable across metadata and preference refreshes.
  if (focusKey) [...list.querySelectorAll<HTMLButtonElement>("button")].find(button => (button.dataset.group ?? button.dataset.thread ?? button.dataset.project) === focusKey)?.focus({ preventScroll: true });
}
