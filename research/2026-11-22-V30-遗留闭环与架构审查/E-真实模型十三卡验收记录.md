# E · 真实模型十三卡验收记录（2026-11-22）

> 验收工程师：Claude（子会话）。真实界面（无头 Chromium 点真实按钮）＋真实模型（中软 MaaS kimi-k3.1-pro，密钥只从钥匙串读、只给网关进程）。
> 代码：工作树 `kimi-legal-architecture-review-c6783f`（含第 56 批未提交改动），起栈前 `npm run pretest && npm run build:kernel`。
> 运行期目录：`/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal--claude-worktrees-kimi-legal-architecture-review-c6783f/4bc4df13-55b6-4017-804d-110debe7a4da/scratchpad/eval`（下称 `$E`）。两套栈 a（5631/8031/18631/18632）、b（5641/8041/18641/18642）。

（边跑边追加；最终结论在跑完后补到本节之下。）

## 过程日志

- 起栈：两套栈 90 秒内就绪；开发桥令牌两套共用一份文件，两边调用均正常。
- 驱动修复第一轮：新建事项对话框“怎么处理”改成 role=radio 按钮（原 input[type=radio] 不存在，发起即失败）；事项模板带出的“起算日”日期框排在前面，asOf 改取最后一个日期框。
- 驱动修复第二轮：开始前确认里“记录本案的客户授权”（选委托合同中的 AI 条款、出处填“委托代理合同第 9 条”）后，本机第一次用 AI 还会再弹一张“开始用 AI 之前”说明（按钮“我知道了，继续”），旧驱动不认，停在首页。补上后两张试跑卡发起成功；事项 basis_state=valid、basis_ref=“委托代理合同第 9 条”。
