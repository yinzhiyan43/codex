import test from "node:test";
import assert from "node:assert/strict";
import { JsonlDecoder } from "../protocol-adapter/jsonl.ts";

test("decodes every byte split of UTF-8 JSONL and multiple CRLF frames", () => {
  const bytes = Buffer.from('{"method":"示例😀"}\r\n\n{"id":1,"result":null}\n');
  for (let offset = 0; offset <= bytes.length; offset++) {
    const decoder = new JsonlDecoder();
    assert.deepEqual([...decoder.push(bytes.subarray(0, offset)), ...decoder.push(bytes.subarray(offset))],
      [{ method: "示例😀" }, { id: 1, result: null }]);
    decoder.end();
  }
});
test("bounds each frame rather than the total size of a valid batch", () => {
  const decoder = new JsonlDecoder(3);
  assert.deepEqual(decoder.push(Buffer.from('{}\n{}\n{}\n')), [{}, {}, {}]);
  assert.throws(() => decoder.push(Buffer.from('{"x":1}\n')), /limit/);
});
test("rejects oversized unfinished frames, malformed JSON, and truncated EOF", () => {
  assert.throws(() => new JsonlDecoder(3).push(Buffer.from('xxxx')), /limit/);
  assert.throws(() => new JsonlDecoder().push(Buffer.from('not-json\n')), SyntaxError);
  const decoder = new JsonlDecoder(); decoder.push(Buffer.from('{"id":'));
  assert.throws(() => decoder.end(), /Truncated/);
});
test("invalid UTF-8 and truncated multibyte characters are rejected rather than replaced", () => {
  assert.throws(() => new JsonlDecoder().push(Buffer.from([0xff, 0x0a])), /encoded data/);
  const decoder = new JsonlDecoder(); decoder.push(Buffer.from([0xe4, 0xb8]));
  assert.throws(() => decoder.end(), /encoded data/);
});
