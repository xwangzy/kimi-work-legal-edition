/**
 * OCR 引擎接口与实现（方案 §8.1：RapidOCR 转换的 PaddleOCR ONNX，全链 Apache-2.0；
 * 运行时 onnxruntime-node；Node 封装以 ppu-paddle-ocr 为起点——选型实证可用，见 README）。
 *
 * - PpuOcrEngine：ppu-paddle-ocr + 显式本地模型路径（det/rec + ppocrv5_dict）。
 *   **离线红线**：构造只接受本机文件路径；ppu-paddle-ocr 默认会联网拉模型，本实现
 *   强制传入本地路径（ModelPathOptions），不做任何下载（注释锚定，改动须复核）。
 *   cls（方向分类）模型暂未接入：正立扫描件为主，ppu-paddle-ocr 无 cls 配置面；如需
 *   旋转页支持在 G1 评估（模型已随包分发 ch_ppocr_mobile_v2.0_cls_mobile.onnx）。
 * - MockOcrEngine：测试用（不依赖模型文件）。
 */
import { PaddleOcrService } from "ppu-paddle-ocr";
import type { OcrModelPaths } from "./models.ts";
import type { RgbaBitmap } from "./pdf-render.ts";
import { rgbaToPng } from "./image-decode.ts";

export interface OcrLine {
  text: string;
  score: number;
  box: number[][];
}

export interface OcrPageResult {
  text: string;
  lines: OcrLine[];
  /** 行置信度均值（无行时为 0）。 */
  meanScore: number;
}

export interface OcrEngine {
  recognize(bitmap: RgbaBitmap): Promise<OcrPageResult>;
  close?(): Promise<void> | void;
}

export { ocrModelsAvailable, type OcrModelPaths } from "./models.ts";

export class PpuOcrEngine implements OcrEngine {
  private service: PaddleOcrService | null = null;
  private readonly paths: OcrModelPaths;
  private readonly engine: "opencv" | "canvas-native";

  constructor(paths: OcrModelPaths, opts: { engine?: "opencv" | "canvas-native" } = {}) {
    this.paths = paths;
    // 处理引擎：默认 opencv（库推荐、复杂版面更稳）；canvas-native 可省 OpenCV WASM，
    // 但实证（6 页扫描批）对基线与每页递增无显著改善——内存瓶颈在 pdfium 位图与 onnxruntime
    // 会话（见 bench 与 README），故维持默认，G1 同台评测再复核
    this.engine = opts.engine ?? "opencv";
  }

  private async ensureService(): Promise<PaddleOcrService> {
    if (this.service) return this.service;
    // 显式本地模型路径（红线：OCR 不联网——不触发 ppu-paddle-ocr 的默认模型下载逻辑）
    const service = new PaddleOcrService({
      model: {
        detection: this.paths.det,
        recognition: this.paths.rec,
        charactersDictionary: this.paths.dict,
      },
      processing: { engine: this.engine },
      // 关掉 onnxruntime 的 CPU 内存池与内存模式（v9.3 性能项实测，20 页扫描件：峰值 1623 → 1247 MB，耗时 +7%）；
      // 限线程数省得不多、慢六成，不改
      session: { enableCpuMemArena: false, enableMemPattern: false },
    });
    await service.initialize();
    this.service = service;
    return service;
  }

  async recognize(bitmap: RgbaBitmap): Promise<OcrPageResult> {
    const service = await this.ensureService();
    const png = await rgbaToPng(bitmap);
    const buf = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
    const r = await service.recognize(buf, { flatten: true });
    const lines: OcrLine[] = (r.results ?? []).map((it) => ({
      text: it.text,
      score: it.confidence,
      box: (it.box as unknown as number[][]) ?? [],
    }));
    const text = lines.map((l) => l.text).join("\n");
    const meanScore = lines.length > 0 ? lines.reduce((n, l) => n + l.score, 0) / lines.length : 0;
    return { text, lines, meanScore };
  }
}

/** 测试用 Mock：返回构造时注入的固定结果（可按调用序轮换）。 */
export class MockOcrEngine implements OcrEngine {
  calls = 0;
  private readonly results: OcrPageResult[];

  constructor(results: OcrPageResult[]) {
    this.results = results;
  }

  async recognize(_bitmap: RgbaBitmap): Promise<OcrPageResult> {
    const r = this.results[Math.min(this.calls, this.results.length - 1)]!;
    this.calls += 1;
    return r;
  }
}
