# 本地材料模块交接

新增文件：`legal-materials.js`、`legal-materials.css`、`tests/materials.cjs`。未修改入口和其他产品源文件。

## 接入

JS 放在 `legal-workspace.js` 之后、启动渲染之前；CSS 在基础样式之后。模块使用现有全局 `state`、`projects`、`v2`、`render` 和 `persistWorkspace`。已包装 `render`，渲染前按当前项目更新旧 `state.attachments` 文件名数组。新建任务仍保留项目共享材料；任务归属与资料范围都按项目 ID 隔离。

- `LegalMaterials.open(id?)`：打开独立材料弹窗，可传材料 ID 直接选中。不会替换场景抽屉；关闭后刷新页面主区与所有材料 panel。
- `LegalMaterials.panel(scenario?)`：返回当前项目材料 HTML；参数预留，目前不按场景限制文件。按钮自行由 `data-material-action` 监听处理。
- `LegalMaterials.taskSnapshot(project?)`：返回深度独立的材料元信息、用途、人工摘录和位置数组；`project` 接受项目索引或 ID，默认当前项目。供任务创建时保存快照。
- `LegalMaterials.syncAttachments(project?)`：同步旧文件名列表；已由 render wrapper 调用。
- `LegalMaterials.remove(id, project?)`、`clear(project?)`：限定项目范围移除材料并撤销图片 URL。
- `LegalMaterials.importFiles(files, projectKey)`：内部导入流程也公开用于回归验证；实际 UI 使用浏览器文件选择器。

首页旧附件标签请改为打开管理弹窗，避免继续使用 `data-action="remove-attach"` 仅删除字符串。项目页面的旧文件选择入口仍需要主模块接线，否则那里仍只是旧的文件名记录。

## 实际能力

TXT / MD / CSV / JSON 可直接本地预览前 128 KB / 80,000 字符，原文本不进入 localStorage。PNG / JPEG / WebP 只使用内存 objectURL 预览，移除或离开页面时撤销；损坏图片显示无法解码说明。PDF / DOCX 仅记录元信息，明确待解析。每项目最多 20 份，文本上限 2 MB、图片 12 MB、文档 50 MB。

用途标签为我方／对方／参考；人工摘录上限 8,000 字符，定位上限 160 字符。持久化数据统一放 `v2.materials`，参与现有工作空间导出与重置，不新增存储键。首次加载时把旧 state.attachments 迁移到当前项目；重新选择同名、同大小、同修改时间的文件恢复预览且保留人工摘录。不同元信息被视为新材料版本。图片与原文刷新后提示重新选择。

未实现 OCR、PDF/DOCX 解析、文本分析或外部上传。原文通过转义放进 pre，JSON 不执行，SVG 不允许导入。

## 验证

执行 `node tests/materials.cjs` 通过。覆盖旧附件迁移、扩展名与大小限制、HTML 转义、原文/图片 URL 不进入持久化、项目隔离、重新选择与版本区分、跨项目删除拒绝、URL 撤销、render 同步、刷新后人工摘录保留、快照拷贝以及每项目数量上限。`node --check legal-materials.js` 通过。

浏览器视觉与真实文件选择器验证仍由主任务完成，需检查：打开场景抽屉再进入材料弹窗、选择文本和图片、编辑摘录、关闭返回原抽屉、切换项目、刷新后重新选择、移动端滚动与下载底稿中的材料快照。
