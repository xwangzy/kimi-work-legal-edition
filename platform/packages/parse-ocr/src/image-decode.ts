/**
 * 图片解码（方案 §8.1：@napi-rs/canvas 图像解码）——JPG/PNG → RGBA 位图，供 OCR 输入。
 * 尺寸防护：单边 > 10000px 拒绝（parse_unsafe，防畸形图拖垮内存）。
 */
import { loadImage } from "@napi-rs/canvas";
import { DomainError } from "@zr-legal/domain";
import type { RgbaBitmap } from "./pdf-render.ts";

const MAX_IMAGE_SIDE = 10_000;

export async function decodeImage(buf: Buffer): Promise<RgbaBitmap> {
  let img;
  try {
    img = await loadImage(buf);
  } catch (e) {
    throw new DomainError("unsupported_file", `图片解码失败（支持 JPG/PNG）：${(e as Error)?.message ?? e}`, 422);
  }
  if (img.width > MAX_IMAGE_SIDE || img.height > MAX_IMAGE_SIDE) {
    throw new DomainError("parse_unsafe", `图片尺寸 ${img.width}×${img.height} 超出安全上限 ${MAX_IMAGE_SIDE}px，已拒绝`, 422);
  }
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height);
  return { width: img.width, height: img.height, data: new Uint8Array(data.data.buffer.slice(0)) };
}

/** RGBA 位图编码为 PNG（OCR 引擎输入与调试用）。 */
export async function rgbaToPng(bitmap: RgbaBitmap): Promise<Buffer> {
  const { createCanvas, ImageData } = await import("@napi-rs/canvas");
  const canvas = createCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(bitmap.data.buffer.slice(0)), bitmap.width, bitmap.height), 0, 0);
  return canvas.toBuffer("image/png");
}
