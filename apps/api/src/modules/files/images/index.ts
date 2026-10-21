import { errorMessage } from '../../../shared/errorMessage.js'
import { MAX_FILE_BYTES, type FileMediaType } from "@foreman-code/contracts/files";
import sharp, { type Metadata, type Sharp } from "sharp";

export type ImageMediaType = Extract<FileMediaType,
  "image/png" | "image/jpeg" | "image/webp" | "image/gif">;
export const IMAGE_LIMITS = Object.freeze({
  inputBytes: MAX_FILE_BYTES,
  pixels: 16_777_216, // Sum of all frames, not just the first frame.
  dimension: 8192,
  frames: 64,
  nativeBytes: 4 * 1024 * 1024,
  nativeDimension: 2048,
  operationMs: 10_000,
});
export type ImageErrorCode = "unsupported_type" | "type_mismatch" | "corrupt"
  | "limit_exceeded" | "timeout" | "invalid_edit";
export class ImageHelperError extends Error {
  constructor(readonly code: ImageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImageHelperError";
  }
}
export interface ImageInput { bytes: Uint8Array; mediaType: ImageMediaType }
export interface ImageInfo {
  mediaType: ImageMediaType;
  /** Per-frame dimensions in display orientation (EXIF orientation applied). */
  width: number;
  height: number;
  frames: number;
  animated: boolean;
  byteSize: number;
}
export interface ImageResult extends ImageInfo { bytes: Buffer; changed: boolean }
export interface NativeImageOptions {
  /** The caller supplies the model's actual capabilities; these defaults are not a model claim. */
  acceptedMediaTypes?: readonly ImageMediaType[];
  maxBytes?: number;
  maxDimension?: number;
}
export interface NativeImageResult extends ImageResult {
  sourceFrames: number;
  firstFrameOnly: boolean;
}
const formats = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp", "image/gif": "gif" } as const;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function fail(code: ImageErrorCode, message: string): never { throw new ImageHelperError(code, message); }
function positiveInteger(value: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail("limit_exceeded", `Invalid ${name}`);
  return value;
}
function checkTime(deadline: number): void {
  if (performance.now() >= deadline) fail("timeout", "Image operation exceeded its time budget");
}
function snapshot(input: ImageInput): Buffer {
  if (!Object.hasOwn(formats, input.mediaType)) fail("unsupported_type", "Unsupported image media type");
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) fail("corrupt", "Image is empty");
  if (input.bytes.byteLength > IMAGE_LIMITS.inputBytes) fail("limit_exceeded", "Image exceeds byte limit");
  // Own the bytes across awaits; never share writable backing bytes with a reference/source file.
  return Buffer.from(input.bytes);
}
function sniff(bytes: Buffer, declared: ImageMediaType): void {
  const actual = bytes.subarray(0, 8).equals(pngSignature) ? "image/png"
    : bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg"
    : ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) ? "image/gif"
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp"
    : undefined;
  if (actual !== declared) fail("type_mismatch", "Image bytes do not match the declared media type");
  if (actual === "image/png") {
    let position = 8;
    let chunks = 0;
    while (position + 12 <= bytes.length) {
      if (++chunks > 4096) fail("limit_exceeded", "Too many PNG chunks");
      const size = bytes.readUInt32BE(position);
      const kind = bytes.toString("ascii", position + 4, position + 8);
      if (position + 12 + size > bytes.length) fail("corrupt", "Truncated PNG chunk");
      if (chunks === 1 && (kind !== "IHDR" || size !== 13)) fail("corrupt", "Missing PNG image header");
      // sharp/libvips does not promise APNG frame preservation. Do not silently flatten it.
      if (kind === "acTL") fail("unsupported_type", "Animated PNG is not supported by this helper");
      position += 12 + size;
      if (kind === "IEND") {
        if (size !== 0 || position !== bytes.length) fail("corrupt", "Invalid PNG end marker");
        return;
      }
    }
    fail("corrupt", "Missing PNG end marker");
  }
  if (actual === "image/webp" && (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length)) {
    fail("corrupt", "Invalid WebP container length");
  }
  if (actual === "image/gif" && (bytes.length < 14 || bytes.at(-1) !== 0x3b)) fail("corrupt", "Truncated GIF");
  if (actual === "image/jpeg" && (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9)) fail("corrupt", "Truncated JPEG");
}
function decoder(bytes: Buffer, deadline: number, allFrames = true): Sharp {
  checkTime(deadline);
  return sharp(bytes, { animated: allFrames, failOn: "warning", limitInputPixels: IMAGE_LIMITS.pixels })
    .timeout({ seconds: Math.max(1, Math.ceil((deadline - performance.now()) / 1000)) });
}
async function inspect(bytes: Buffer, mediaType: ImageMediaType, deadline: number): Promise<{ info: ImageInfo; metadata: Metadata }> {
  sniff(bytes, mediaType);
  const metadata = await decoder(bytes, deadline).metadata();
  checkTime(deadline);
  if (metadata.format !== formats[mediaType]) fail("type_mismatch", "Decoded format disagrees with declared type");
  const frames = positiveInteger(metadata.pages ?? 1, IMAGE_LIMITS.frames, "frame count");
  if ((metadata.delay?.length ?? 0) > IMAGE_LIMITS.frames) fail("limit_exceeded", "Too many frame delays");
  const width = positiveInteger(metadata.width ?? 0, IMAGE_LIMITS.dimension, "image width");
  const height = positiveInteger(metadata.pageHeight ?? metadata.height ?? 0, IMAGE_LIMITS.dimension, "image height");
  if (width * height * frames > IMAGE_LIMITS.pixels) fail("limit_exceeded", "Image exceeds decoded pixel limit");
  // Metadata alone is not validation. Decode every frame, including a corrupt later GIF/WebP frame.
  // Force RGBA uchar so the retained validation buffer is bounded by pixels * 4 bytes.
  const raw = await decoder(bytes, deadline).toColourspace("srgb").ensureAlpha().raw({ depth: "uchar" }).toBuffer();
  checkTime(deadline);
  if (raw.byteLength !== width * height * frames * 4) fail("corrupt", "Decoded image dimensions disagree with metadata");
  const swapped = (metadata.orientation ?? 1) >= 5;
  return { metadata, info: { mediaType, width: swapped ? height : width, height: swapped ? width : height,
    frames, animated: frames > 1, byteSize: bytes.length } };
}
async function guard<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof ImageHelperError) throw error;
    const message = errorMessage(error, "Image decoding failed");
    const code = /timeout|time.?out/i.test(message) ? "timeout"
      : /pixel limit|memory|too large/i.test(message) ? "limit_exceeded" : "corrupt";
    throw new ImageHelperError(code, "Image could not be safely processed", { cause: error });
  }
}
function encode(pipeline: Sharp, mediaType: ImageMediaType, metadata: Metadata, animated: boolean): Sharp {
  const animation = animated ? { loop: metadata.loop ?? 0, delay: metadata.delay ?? [] } : {};
  switch (mediaType) {
    case "image/png": return pipeline.png();
    case "image/jpeg": return pipeline.jpeg({ quality: 90 });
    case "image/webp": return pipeline.webp({ quality: 90, ...animation });
    case "image/gif": return pipeline.gif({ ...animation });
  }
}
/** No paths, network requests, storage writes, or embedded-content execution. */
export async function readImage(input: ImageInput): Promise<ImageInfo> {
  return guard(async () => {
    const deadline = performance.now() + IMAGE_LIMITS.operationMs;
    return (await inspect(snapshot(input), input.mediaType, deadline)).info;
  });
}
/** Resize in display orientation. null or the existing dimensions is a byte-identical copy. */
export async function resizeImage(input: ImageInput, edit: { width: number; height: number } | null): Promise<ImageResult> {
  return guard(async () => {
    const deadline = performance.now() + IMAGE_LIMITS.operationMs;
    const bytes = snapshot(input);
    const { info, metadata } = await inspect(bytes, input.mediaType, deadline);
    if (edit === null) return { ...info, bytes, changed: false };
    if (!Number.isSafeInteger(edit.width) || !Number.isSafeInteger(edit.height) || edit.width < 1 || edit.height < 1) {
      fail("invalid_edit", "Resize dimensions must be positive integers");
    }
    if (edit.width > IMAGE_LIMITS.dimension || edit.height > IMAGE_LIMITS.dimension
      || edit.width * edit.height * info.frames > IMAGE_LIMITS.pixels) fail("limit_exceeded", "Resize exceeds pixel limit");
    if (edit.width === info.width && edit.height === info.height) return { ...info, bytes, changed: false };
    const result = await encode(decoder(bytes, deadline).rotate().resize(edit.width, edit.height, { fit: "fill" }),
      input.mediaType, metadata, info.animated).toBuffer();
    if (result.length > MAX_FILE_BYTES) fail("limit_exceeded", "Edited image exceeds byte limit");
    const output = (await inspect(result, input.mediaType, deadline)).info;
    if (output.width !== edit.width || output.height !== edit.height || output.frames !== info.frames) {
      fail("corrupt", "Resize did not preserve the requested dimensions and frame count");
    }
    return { ...output, bytes: result, changed: true };
  });
}
/** Model capability policy belongs to the caller. Animated inputs become an explicitly reported first frame. */
export async function prepareNativeImage(input: ImageInput, options: NativeImageOptions = {}): Promise<NativeImageResult> {
  return guard(async () => {
    const deadline = performance.now() + IMAGE_LIMITS.operationMs;
    const maxBytes = positiveInteger(options.maxBytes ?? IMAGE_LIMITS.nativeBytes, IMAGE_LIMITS.nativeBytes, "native byte limit");
    const maxDimension = positiveInteger(options.maxDimension ?? IMAGE_LIMITS.nativeDimension, IMAGE_LIMITS.nativeDimension, "native dimension limit");
    const accepted = [...(options.acceptedMediaTypes ?? ["image/png", "image/jpeg", "image/webp"])];
    if (accepted.length === 0 || accepted.length > 4 || accepted.some((type) => !Object.hasOwn(formats, type))) {
      fail("unsupported_type", "No supported native image type was supplied");
    }
    const bytes = snapshot(input);
    const { info, metadata } = await inspect(bytes, input.mediaType, deadline);
    const source = { sourceFrames: info.frames, firstFrameOnly: info.animated };
    if (!info.animated && (metadata.orientation ?? 1) === 1 && accepted.includes(input.mediaType)
      && bytes.length <= maxBytes && info.width <= maxDimension && info.height <= maxDimension) {
      return { ...info, ...source, bytes, changed: false };
    }
    const mediaType = accepted.includes(input.mediaType) ? input.mediaType : accepted[0]!;
    let edge = Math.min(maxDimension, Math.max(info.width, info.height));
    for (;;) {
      const result = await encode(decoder(bytes, deadline, false).rotate()
        .resize(edge, edge, { fit: "inside", withoutEnlargement: true }), mediaType, metadata, false).toBuffer();
      checkTime(deadline);
      if (result.length <= maxBytes) {
        const output = (await inspect(result, mediaType, deadline)).info;
        if (output.frames !== 1 || output.width > maxDimension || output.height > maxDimension) {
          fail("corrupt", "Native image preparation did not meet the requested bounds");
        }
        return { ...output, ...source, bytes: result, changed: true };
      }
      if (edge === 1) fail("limit_exceeded", "Cannot encode a native image within the byte limit");
      edge = Math.max(1, Math.floor(edge / 2));
    }
  });
}
