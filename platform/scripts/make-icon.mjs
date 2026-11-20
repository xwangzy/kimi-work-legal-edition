/**
 * 旧入口（第 49 批起改为转发）：应用图标改用 Kimi 官方 Logomark，由 apps/desktop/scripts/build-icons.mjs 从仓库内的
 * apps/desktop/build/brand/Logomark_Light.svg 按各尺寸矢量渲染，生成 build/icon.ico（16～256 共 10 帧）与 build/icon.png（1024）。
 * 原来这里画的是自绘的蓝底“K + 法”，直接运行会把新图标覆盖成旧图——所以只转发，不再自己画。
 * 用法：node scripts/make-icon.mjs（等同于 node apps/desktop/scripts/build-icons.mjs）
 */
await import(new URL("../apps/desktop/scripts/build-icons.mjs", import.meta.url).href);
