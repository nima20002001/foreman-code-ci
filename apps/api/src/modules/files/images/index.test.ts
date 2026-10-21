import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import sharp from "sharp";
import { IMAGE_LIMITS, ImageHelperError, prepareNativeImage, readImage, resizeImage, type ImageMediaType } from "./index.js";

const fixture = (name: string): Promise<Buffer> => readFile(new URL(`./fixtures/${name}`, import.meta.url));
const imageError = (code: string) => (error: unknown): boolean => error instanceof ImageHelperError && error.code === code;
const examples: readonly [string, ImageMediaType, string][] = [
  ["sample.png", "image/png", "png"], ["sample.jpg", "image/jpeg", "jpeg"],
  ["sample.webp", "image/webp", "webp"], ["sample.gif", "image/gif", "gif"],
];

describe("FIL-07 image helpers", () => {
  for (const [filename, mediaType, format] of examples) {
    it(`decodes real ${format} bytes and dimensions`, async () => {
      const bytes = await fixture(filename);
      assert.deepEqual(await readImage({ bytes, mediaType }), {
        mediaType, width: 8, height: 6, frames: 1, animated: false, byteSize: bytes.length,
      });
    });
    it(`returns a valid same-format ${format} resize without changing the source`, async () => {
      const bytes = await fixture(filename);
      const original = Buffer.from(bytes);
      const edited = await resizeImage({ bytes, mediaType }, { width: 4, height: 3 });
      assert.equal(edited.changed, true);
      assert.equal(edited.mediaType, mediaType);
      assert.deepEqual(bytes, original);
      const decoded = await sharp(edited.bytes, { failOn: "warning" }).raw().toBuffer({ resolveWithObject: true });
      const metadata = await sharp(edited.bytes).metadata();
      assert.equal(metadata.format, format);
      assert.equal(decoded.info.width, 4);
      assert.equal(decoded.info.height, 3);
      assert.equal((await readImage({ bytes: edited.bytes, mediaType })).width, 4);
    });
    it(`keeps ${format} no-op copies byte-identical and independently owned`, async () => {
      const bytes = await fixture(filename);
      for (const edit of [null, { width: 8, height: 6 }]) {
        const result = await resizeImage({ bytes, mediaType }, edit);
        assert.equal(result.changed, false);
        assert.deepEqual(result.bytes, bytes);
        assert.notEqual(result.bytes, bytes);
        result.bytes[0] = 0;
        assert.notEqual(bytes[0], 0);
      }
    });
    it(`rejects ${format} truncation even for a no-op`, async () => {
      const bytes = (await fixture(filename)).subarray(0, -1);
      await assert.rejects(resizeImage({ bytes, mediaType }, null), imageError("corrupt"));
    });
  }
  it("rejects all cross-type declarations", async () => {
    for (const [filename, actual] of examples) {
      for (const [, declared] of examples) {
        if (declared !== actual) await assert.rejects(readImage({ bytes: await fixture(filename), mediaType: declared }), imageError("type_mismatch"));
      }
    }
  });
  it("rejects text or embedded SVG posing as an allowed image", async () => {
    await assert.rejects(readImage({ bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), mediaType: "image/png" }), imageError("type_mismatch"));
  });
  it("does not mistake a header and end marker for decoded pixel data", async () => {
    const bytes = await fixture("sample.png");
    const headersOnly = Buffer.concat([bytes.subarray(0, 33), bytes.subarray(-12)]);
    await assert.rejects(readImage({ bytes: headersOnly, mediaType: "image/png" }), imageError("corrupt"));
  });
  it("rejects empty, oversized, and excessive-pixel images", async () => {
    await assert.rejects(readImage({ bytes: Buffer.alloc(0), mediaType: "image/png" }), imageError("corrupt"));
    await assert.rejects(readImage({ bytes: Buffer.alloc(IMAGE_LIMITS.inputBytes + 1), mediaType: "image/png" }), imageError("limit_exceeded"));
    await assert.rejects(readImage({ bytes: await fixture("pixel-limit.png"), mediaType: "image/png" }), imageError("limit_exceeded"));
  });
  it("rejects invalid or oversized resize requests before allocating the output", async () => {
    const input = { bytes: await fixture("sample.png"), mediaType: "image/png" as const };
    for (const width of [0, -1, 1.5, NaN, Infinity]) await assert.rejects(resizeImage(input, { width, height: 2 }), imageError("invalid_edit"));
    await assert.rejects(resizeImage(input, { width: 8192, height: 8192 }), imageError("limit_exceeded"));
  });
  for (const [name, mediaType] of [["animated.gif", "image/gif"], ["animated.webp", "image/webp"]] as const) {
    it(`preserves frames, timing and loop on ${mediaType} resize`, async () => {
      const bytes = await fixture(name);
      const before = await sharp(bytes, { animated: true }).metadata();
      assert.equal((await readImage({ bytes, mediaType })).frames, 2);
      assert.deepEqual((await resizeImage({ bytes, mediaType }, null)).bytes, bytes);
      const edited = await resizeImage({ bytes, mediaType }, { width: 4, height: 3 });
      const after = await sharp(edited.bytes, { animated: true }).metadata();
      assert.equal(after.pages, 2);
      assert.equal(after.pageHeight, 3);
      assert.deepEqual(after.delay, before.delay);
      assert.equal(after.loop, before.loop);
    });
    it(`makes first-frame-only ${mediaType} native conversion explicit`, async () => {
      const native = await prepareNativeImage({ bytes: await fixture(name), mediaType }, { acceptedMediaTypes: ["image/png"], maxDimension: 4 });
      assert.equal(native.firstFrameOnly, true);
      assert.equal(native.sourceFrames, 2);
      assert.equal(native.frames, 1);
      assert.equal(native.mediaType, "image/png");
      assert.equal(native.width, 4);
      assert.equal(native.height, 3);
      assert.ok(native.byteSize <= IMAGE_LIMITS.nativeBytes);
    });
  }
  it("refuses too many animation frames and APNG rather than flattening silently", async () => {
    await assert.rejects(readImage({ bytes: await fixture("frame-limit.gif"), mediaType: "image/gif" }), imageError("limit_exceeded"));
    await assert.rejects(readImage({ bytes: await fixture("animated.png"), mediaType: "image/png" }), imageError("unsupported_type"));
  });
  it("returns independent native-ready bytes unchanged when no conversion is needed", async () => {
    const bytes = await fixture("sample.png");
    const native = await prepareNativeImage({ bytes, mediaType: "image/png" });
    assert.equal(native.changed, false);
    assert.equal(native.firstFrameOnly, false);
    assert.equal(native.sourceFrames, 1);
    assert.deepEqual(native.bytes, bytes);
    assert.notEqual(native.bytes, bytes);
  });
  it("honors native type, dimension and byte limits and reports impossible limits", async () => {
    const input = { bytes: await fixture("sample.png"), mediaType: "image/png" as const };
    const native = await prepareNativeImage(input, { acceptedMediaTypes: ["image/jpeg"], maxDimension: 2, maxBytes: 1024 });
    assert.equal(native.mediaType, "image/jpeg");
    assert.ok(native.width <= 2 && native.height <= 2 && native.bytes.length <= 1024);
    await assert.rejects(prepareNativeImage(input, { acceptedMediaTypes: [] }), imageError("unsupported_type"));
    await assert.rejects(prepareNativeImage(input, { maxBytes: 0 }), imageError("limit_exceeded"));
    await assert.rejects(prepareNativeImage(input, { maxBytes: 1 }), imageError("limit_exceeded"));
  });
  it("uses EXIF display orientation for dimensions and native copies", async () => {
    const input = { bytes: await fixture("oriented.jpg"), mediaType: "image/jpeg" as const };
    const info = await readImage(input);
    assert.equal(info.width, 6);
    assert.equal(info.height, 8);
    assert.deepEqual((await resizeImage(input, { width: 6, height: 8 })).bytes, input.bytes);
    const native = await prepareNativeImage(input);
    assert.equal(native.changed, true);
    assert.equal(native.width, 6);
    assert.equal(native.height, 8);
    assert.equal((await sharp(native.bytes).metadata()).orientation, undefined);
    assert.equal((await resizeImage(input, { width: 3, height: 4 })).height, 4);
  });
  it("snapshots mutable caller bytes before asynchronous decoding", async () => {
    const bytes = await fixture("sample.png");
    const pending = resizeImage({ bytes, mediaType: "image/png" }, null);
    bytes.fill(0);
    assert.deepEqual((await pending).bytes, await fixture("sample.png"));
  });
});
