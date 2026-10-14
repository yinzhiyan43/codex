import { ProtocolSession } from "../protocol-adapter/session.ts";
import { readFileSync } from "node:fs";

export const fixtureBytes = readFileSync(new URL("fixtures/turn.jsonl", import.meta.url));
export const fixtureMessages: Record<string, unknown>[] = fixtureBytes.toString("utf8").trim().split("\n").map(line => JSON.parse(line));
export const syntheticThread = () => structuredClone((fixtureMessages[0]!.params as { thread: Record<string, unknown> }).thread);
export const syntheticTurn = (status = "inProgress", items: unknown[] = []) => ({ id: "turn-demo", items, itemsView: "full", status });
export function feed(session: ProtocolSession, message: unknown, epoch = session.epoch): void {
  session.receive(Buffer.from(JSON.stringify(message) + "\n"), epoch);
}
export function outgoing(session: ProtocolSession): Record<string, unknown>[] { return session.takeOutbound().map(frame => JSON.parse(frame)); }
export async function ready(options: ConstructorParameters<typeof ProtocolSession>[0] = {}): Promise<ProtocolSession> {
  const session = new ProtocolSession(options);
  const connection = session.connect();
  const request = outgoing(session)[0]!;
  feed(session, { id: request.id, result: { userAgent: "synthetic", codexHome: "/synthetic/home", platformFamily: "unix", platformOs: "macos" } });
  await connection.initialized;
  outgoing(session);
  session.takeEvents();
  return session;
}
export function approval(id: string | number = "approval-demo", method = "item/commandExecution/requestApproval", threadId = "thread-demo") {
  return { id, method, params: { threadId, turnId: "turn-demo", itemId: "command-demo", startedAtMs: 1000,
    ...(method === "item/commandExecution/requestApproval" ? { command: "synthetic-only", cwd: "/synthetic/project" } : {}) } };
}
