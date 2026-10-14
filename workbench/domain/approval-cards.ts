import { createHash } from "node:crypto";
import type { ApprovalHandle, ApprovalDecision, ApprovalView } from "../protocol-adapter/session.ts";
import type { WorkbenchClient, HostView } from "../desktop-host/client.ts";
export type ApprovalCard = { key: string; threadId: string; kind: "command" | "file"; title: string; detail: string;
  status: "pending" | "waiting" | "resolved" | "expired" | "disconnected"; decision: ApprovalDecision | null };
type Stored = { card: ApprovalCard; handle: ApprovalHandle };
const keyOf = (view: ApprovalHandle) => "approval-" + createHash("sha256").update(JSON.stringify([view.epoch, typeof view.id, view.id, view.threadId])).digest("hex").slice(0, 24);
/** Renderer gets bounded display cards; canonical handles remain in the main process. */
export class ApprovalCards {
  #cards = new Map<string, Stored>();
  sync(host: HostView): void {
    const accept = (view: ApprovalView, disconnected: boolean) => {
      const key = keyOf(view); let stored = this.#cards.get(key);
      if (!stored) {
        if (this.#cards.size >= 64) {
          const removable = [...this.#cards].find(([, value]) => ["resolved", "expired", "disconnected"].includes(value.card.status));
          if (removable) this.#cards.delete(removable[0]); else throw new Error("approval-display-limit");
        }
        const kind = view.method.includes("commandExecution") ? "command" : "file";
        const detail = typeof view.params.command === "string" ? view.params.command.slice(0, 500) : typeof view.params.reason === "string" ? view.params.reason.slice(0, 500) : "合成文件修改请求";
        stored = { handle: { epoch: view.epoch, id: view.id, threadId: view.threadId }, card: { key, threadId: view.threadId, kind, title: kind === "command" ? "命令审批" : "文件修改审批", detail, status: "pending", decision: null } };
        this.#cards.set(key, stored);
      }
      stored.card.status = disconnected ? "disconnected" : view.status === "pending" ? "pending" : view.status === "responded" ? "waiting" : stored.card.decision ? "resolved" : "expired";
    };
    for (const view of host.approvals) accept(view, host.state !== "ready" || view.epoch !== host.generation);
    for (const view of host.recovery.staleApprovals) accept(view, true);
  }
  snapshot(threadId: string | null): ApprovalCard[] { return structuredClone([...this.#cards.values()].filter(value => value.card.threadId === threadId).map(value => value.card)); }
  respond(key: string, decision: ApprovalDecision, client: WorkbenchClient): void {
    this.sync(client.getView());
    const stored = this.#cards.get(key);
    if (!stored || stored.card.status !== "pending" || client.getView().state !== "ready" || stored.handle.epoch !== client.getView().generation) throw new Error("approval-no-longer-pending");
    client.respondApproval(stored.handle, decision); stored.card.decision = decision;
    this.sync(client.getView());
  }
}
