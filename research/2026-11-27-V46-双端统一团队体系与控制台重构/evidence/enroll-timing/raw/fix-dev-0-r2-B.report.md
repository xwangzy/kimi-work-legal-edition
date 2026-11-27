
## 第 1 轮（36 条计时事件）

| # | 时刻 | 进程 | 分段 | 毫秒 | 说明 |
|---|---|---|---|---:|---|
| 1 | 05:42:25 | main | 主进程·切换档案 auth（锚点） |  |  |
| 2 | 05:42:25 | kernel | 内核·close() | 17 |  |
| 3 | 05:42:25 | kernel | 内核启动·init_wait（待激活） | 70 |  |
| 4 | 05:42:25 | kernel | 内核启动·db_open_migrate（待激活） | 69 |  |
| 5 | 05:42:25 | kernel | 内核启动·lawdb（待激活） | 12 |  |
| 6 | 05:42:25 | kernel | 内核启动·skills（待激活） | 15 |  |
| 7 | 05:42:25 | kernel | 内核启动·identity_device（待激活） | 4 |  |
| 8 | 05:42:25 | kernel | 内核启动·endpoints（待激活） | 8 |  |
| 9 | 05:42:25 | kernel | 内核启动·ready（待激活） | 1 |  |
| 10 | 05:42:25 | kernel | 闸门·运行时核对（early） | 1 |  |
| 11 | 05:42:25 | main | 主进程·取库密钥 / fork |  | key=1 fork=0 |
| 12 | 05:42:25 | main | 主进程·整次重启 profile（restarted） | 19 |  |
| 13 | 05:42:25 | main | 主进程·关旧内核（exit） | 18 |  |
| 14 | 05:42:25 | main | 主进程·fork→就绪（待激活） | 234 |  |
| 15 | 05:42:25 | kernel | 闸门·拉起（含等待核对） | 88 |  |
| 16 | 05:42:25 | kernel | 待激活·withclaim | 109 |  |
| 17 | 05:42:25 | kernel | 待激活·enroll | 22 |  |
| 18 | 05:42:25 | kernel | 待激活·stage_write | 1 |  |
| 19 | 05:42:25 | kernel | 待激活·自动登记完成（锚点） |  |  |
| 20 | 05:42:26 | main | 主进程·收到按身份重启（锚点） |  |  |
| 21 | 05:42:26 | kernel | 内核·close() | 14 |  |
| 22 | 05:42:26 | kernel | 内核启动·init_wait | 69 |  |
| 23 | 05:42:26 | kernel | 内核启动·db_open_migrate | 70 |  |
| 24 | 05:42:26 | kernel | 内核启动·lawdb | 22 |  |
| 25 | 05:42:26 | kernel | 内核启动·skills | 15 |  |
| 26 | 05:42:26 | kernel | 内核启动·identity_device | 2 |  |
| 27 | 05:42:26 | kernel | 内核启动·endpoints | 9 |  |
| 28 | 05:42:26 | kernel | 内核启动·ready | 0 |  |
| 29 | 05:42:26 | kernel | 闸门·运行时核对（early） | 1 |  |
| 30 | 05:42:26 | main | 主进程·取库密钥 / fork |  | key=1 fork=0 |
| 31 | 05:42:26 | main | 主进程·整次重启 identity（restarted） | 16 |  |
| 32 | 05:42:26 | main | 主进程·关旧内核（exit） | 15 |  |
| 33 | 05:42:26 | main | 主进程·fork→就绪 | 232 |  |
| 34 | 05:42:26 | kernel | 闸门·拉起（含等待核对） | 91 |  |
| 35 | 05:42:26 | kernel | 同步（首轮）·总计 | 164 | register=113 docs=48 seat=2（accepted） |
| 36 | 05:42:26 | kernel | AI 可用（内核启动以来） | 351 |  |

串行分段合计约 697 ms；整次重启 19 / 16 ms；AI 可用（新内核启动以来）351 ms
