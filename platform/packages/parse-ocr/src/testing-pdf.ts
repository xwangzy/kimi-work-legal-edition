/**
 * 最小 PDF 生成器（测试与 bench 共用；零依赖、离线）：
 * - makeTextPdf：每页一段 ASCII 文本（Type1 Helvetica；仅 ASCII——中文文本层测试
 *   以结构断言为主，中文识别走 OCR 图片路径）；
 * - makeImagePdf：每页一幅 RGB 位图（FlateDecode），模拟扫描件（无文本层）。
 * 生成的 PDF 带正确 xref，pdfjs 可直接解析。
 */
import { deflateSync } from "node:zlib";

function assemblePdf(objects: Buffer[]): Buffer {
  const header = Buffer.from("%PDF-1.4\n");
  const parts: Buffer[] = [header];
  const offsets: number[] = [];
  let pos = header.length;
  for (let i = 0; i < objects.length; i++) {
    const head = Buffer.from(`${i + 1} 0 obj\n`);
    const tail = Buffer.from("\nendobj\n");
    offsets.push(pos);
    parts.push(head, objects[i]!, tail);
    pos += head.length + objects[i]!.length + tail.length;
  }
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  parts.push(Buffer.from(xref + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return Buffer.concat(parts);
}

function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** 每页一行 ASCII 文本的 PDF（texts[i] = 第 i+1 页文本）。 */
export function makeTextPdf(texts: string[]): Buffer {
  const n = texts.length;
  // 对象布局：1 catalog, 2 pages, 3..3+n-1 page, 3+n font, 3+n+1.. contents
  const fontObj = 3 + n;
  const objects: Buffer[] = [];
  const kids = texts.map((_, i) => `${3 + i} 0 R`).join(" ");
  objects.push(Buffer.from(`<< /Type /Catalog /Pages 2 0 R >>`));
  objects.push(Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`));
  for (let i = 0; i < n; i++) {
    const contentRef = fontObj + 1 + i;
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentRef} 0 R >>`));
  }
  objects.push(Buffer.from(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`));
  for (const t of texts) {
    const stream = `BT /F1 18 Tf 72 720 Td (${pdfEscape(t)}) Tj ET`;
    objects.push(Buffer.from(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`));
  }
  return assemblePdf(objects);
}

export interface RawImage {
  width: number;
  height: number;
  /** RGB，3 字节/像素。 */
  rgb: Buffer;
}

/** 每页一幅位图的扫描件 PDF（无文本层）。 */
export function makeImagePdf(images: RawImage[]): Buffer {
  const n = images.length;
  // 对象布局：1 catalog, 2 pages, 3..3+n-1 page, 3+n.. contents, 之后每页一个 image XObject
  const contentBase = 3 + n;
  const imageBase = contentBase + n;
  const objects: Buffer[] = [];
  const kids = images.map((_, i) => `${3 + i} 0 R`).join(" ");
  objects.push(Buffer.from(`<< /Type /Catalog /Pages 2 0 R >>`));
  objects.push(Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`));
  for (let i = 0; i < n; i++) {
    const img = images[i]!;
    objects.push(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${img.width} ${img.height}] /Resources << /XObject << /Im1 ${imageBase + i} 0 R >> >> /Contents ${contentBase + i} 0 R >>`,
      ),
    );
  }
  for (let i = 0; i < n; i++) {
    const img = images[i]!;
    const stream = `q ${img.width} 0 0 ${img.height} 0 0 cm /Im1 Do Q`;
    objects.push(Buffer.from(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`));
  }
  for (const img of images) {
    const data = deflateSync(img.rgb);
    objects.push(
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`,
        ),
        data,
        Buffer.from("\nendstream"),
      ]),
    );
  }
  return assemblePdf(objects);
}
