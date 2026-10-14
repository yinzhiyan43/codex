import type { GetAccountParams, GetAccountResponse, ModelListParams, ModelListResponse } from "../protocol-adapter/contracts.ts";
import type { InitializeResponse, ThreadReadParams, ThreadReadResponse, ThreadTurnsListParams, ThreadTurnsListResponse, ThreadItemsListParams, ThreadItemsListResponse } from "../protocol-adapter/contracts.ts";
import type { ApprovalHandle, ApprovalDecision, ApprovalView, ConnectionState, ProtocolSession } from "../protocol-adapter/session.ts";
import type { ThreadView } from "../protocol-adapter/projection.ts";

export type HostState = "stopped" | "starting" | "initializing" | "ready" | "draining" | "stopping" | "disconnected" | "failed" | "disposed";
export type HostView = {
  serverInfo?: InitializeResponse | null; state: HostState; generation: number; processActive: boolean; protocolState: ConnectionState;
  threads: ThreadView[]; approvals: ApprovalView[]; recovery: ReturnType<ProtocolSession["recoveryPlan"]>;
};
export type HostDiagnostic = { code: string; stderrBytes?: number; exitCode?: number | null; signal?: string | null };
export class HostOperationError extends Error {
  readonly code: string;
  readonly outcome: "not-sent" | "unknown";
  constructor(code: string, outcome: "not-sent" | "unknown" = "not-sent") {
    super(code); this.name = "HostOperationError"; this.code = code; this.outcome = outcome;
  }
}
/** Renderer-facing surface: no launch arguments, arbitrary RPC, raw streams or credentials. */
export interface WorkbenchClient {
  start(): Promise<void>;
  reconnect(): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  getView(): HostView;
  takeDiagnostics(): HostDiagnostic[];
  subscribe(listener: () => void): () => void;
  checkOfficialRoute(): Promise<void>;
  getAccount(params: GetAccountParams): Promise<GetAccountResponse>;
  listModels(params: ModelListParams): Promise<ModelListResponse>;
  readThread(params: ThreadReadParams): Promise<ThreadReadResponse>;
  listTurns(params: ThreadTurnsListParams): Promise<ThreadTurnsListResponse>;
  listItems(params: ThreadItemsListParams): Promise<ThreadItemsListResponse>;
  respondApproval(handle: ApprovalHandle, decision: ApprovalDecision): void;
  acknowledgeRecovery(): void;
}
