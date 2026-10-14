import { TextDecoder } from "node:util";

/** Decode transport bytes without losing split UTF-8 characters or partial lines. */
export class JsonlDecoder {
  #decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  #buffer = "";
  #limit: number;
  constructor(maxFrameBytes = 1024 * 1024) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) throw new Error("Invalid frame limit");
    this.#limit = maxFrameBytes;
  }
  push(bytes: Uint8Array): unknown[] {
    this.#buffer += this.#decoder.decode(bytes, { stream: true });
    const messages: unknown[] = [];
    let end: number;
    while ((end = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, end).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(end + 1);
      if (Buffer.byteLength(line) > this.#limit) throw new Error("JSONL frame exceeds limit");
      if (line.trim() !== "") messages.push(JSON.parse(line));
    }
    if (Buffer.byteLength(this.#buffer) > this.#limit) throw new Error("JSONL frame exceeds limit");
    return messages;
  }
  end(): void {
    this.#buffer += this.#decoder.decode();
    if (this.#buffer.trim() !== "") throw new Error("Truncated JSONL frame");
  }
}
