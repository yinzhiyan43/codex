// Keep application actions separate from IME commit/cancel keys.
export type KeyState = { key: string; isComposing?: boolean; keyCode?: number; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; repeat?: boolean };
export class CompositionGuard {
  private composing = false;
  private settleUntil = -Infinity;
  private now: () => number;
  constructor(now: () => number = () => performance.now()) { this.now = now; }
  start(): void { this.composing = true; }
  end(): void { this.composing = false; this.settleUntil = this.now() + 50; }
  blocked(event?: KeyState): boolean {
    if (event?.isComposing || event?.keyCode === 229) this.settleUntil = this.now() + 50;
    return this.composing || !!event?.isComposing || event?.keyCode === 229 || this.now() < this.settleUntil;
  }
}
export const plainEnter = (event: KeyState): boolean => event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat && !event.isComposing && event.keyCode !== 229;
export const searchShortcut = (event: KeyState): boolean => !!(event.ctrlKey || event.metaKey) && !!event.shiftKey && !event.altKey && !event.repeat && event.key.toLowerCase() === "f";
export function menuIndex(key: string, current: number, length: number): number | null {
  if (!length) return null;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key === "ArrowDown") return (current + 1 + length) % length;
  if (key === "ArrowUp") return (current - 1 + length) % length;
  return null;
}
