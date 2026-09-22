# 2026-09-21 代码与状态审查

## 验证范围

读取 app.js、legal-workspace.js、legal-skills.js、legal-launcher.js、legal-workpapers.js、legal-connections-plus.js 及相关 CSS。现有状态测试初始为 21/21 通过；补充修复后为 24/24 通过。测试是 Node VM 的 DOM/状态模拟，不验证浏览器布局、真实服务或文件解析。

运行命令：

```sh
/Users/wangzeyu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node tests/state-regression.cjs
```

## 本次已经修复

1. **MCP 导入接受大写标识但刷新丢失**。`legal-connections-plus.js` 原来校验使用大小写不敏感正则，`legal-workspace.js` 恢复只保留 `custom-` 小写前缀。已统一导入只接受小写；非法批次保持不落盘。
2. **新底稿遗漏附件和工具授权快照**。`legal-workspace.js` 创建底稿现在复制附件文件名、工具 ID、授权清单、传输方式和输入 Schema，后续任务/连接修改不会改变历史底稿。
3. **配置页面不能完整维护 MCP 合约**。`legal-connections-plus.js` 增加连接名称、用途编辑，工具 JSON 清单与输入 Schema 编辑。更新清单后新工具保持未选中，必须手动勾选；所有字段纳入检查指纹，变化后拒绝直接启用。内置 15 个工具分别有具体输入字段和必需参数，均明确是演示合约。
4. **Schema 最小结构校验缺失**。增加 `properties` 对象、`required` 不重复且引用已声明属性、`additionalProperties` 类型检查；没有宣称完整 JSON Schema 元规范验证。

## 已复现并交给主代理的关联问题

- **高优先级：场景旧参数混入新任务**。先为刑事会见场景填写样例，再以自由文本开始新客户工作，通过 `use-current` 选同一场景，新底稿 `prompt` 是新任务，但 `scenarioValues` 仍是旧样例。定位：`legal-launcher.js` 的 `use-current` 和 `create-custom-draft` 监听器。建议为自由文本分派清空参数/示例标记，或绑定独立任务草稿，而不是复用场景长期输入缓存。
- **高优先级：Skill 输出配置与成果结构不一致**。编辑 `scene-criminal-interview.outputs` 为“自定义会见摘要”，提示词与快照都显示新输出，但成果仍为“首次会见提纲 / 会见记录模板 / 会见后核查清单”。定位：`legal-launcher.js` 的 `s.outputs` 展示、`legal-workpapers.js` 的 `ensure` 直接使用 `s.outputs`。建议创建成果时使用配置快照；历史成果不追溯改写。

## 产品功能缺口与排版观察

- 当前上传入口只保存文件名；未做读取、OCR 或图片预览，场景表单没有与字段关联的上传要求。应该至少将“待上传材料清单、文件类型、已附文件、解析状态”放入场景中。
- Skills 已有复制、编辑、启停、导出，但没有导入、删除自定义、配置包批量迁移；全量选择器是 45 项平铺，需要搜索和业务筛选。
- 场景与 Skills 是两个入口，同一信息重复出现在首页、任务弹窗、Skill 详情与底稿侧栏，应以“业务入口 → 事项输入 → 预设指令 → 可复核成果”为主线，配置详情按需展开。
- 首页场景快捷卡、输入框、继续工作、完整流程案例并列。建议保持输入框为视觉中心，把重复的固定演示入口合并为较轻的示例区。
- 仅 2 个结构化场景有完整虚构成果样例。其余场景虽然可以建立工作表/文书，但成果大多为空，演示的业务闭环不完整。
- 工作台底稿局部每次输入即持久化全量状态，若大量保存表格/长文本，可能出现容量和性能问题；目前为本地演示可接受，不宜暗示生产级持久化。
- 本次没有执行浏览器视觉审查；响应式宽度、对话框滚动、焦点与按钮密度须主代理用真实浏览器验收。
