
## 第 1 轮（36 条计时事件）

| # | 时刻 | 进程 | 分段 | 毫秒 | 说明 |
|---|---|---|---|---:|---|
| 1 | 05:42:54 | main | 主进程·切换档案 auth（锚点） |  |  |
| 2 | 05:42:54 | kernel | 内核·close() | 13 |  |
| 3 | 05:42:54 | kernel | 内核启动·init_wait（待激活） | 71 |  |
| 4 | 05:42:54 | kernel | 内核启动·db_open_migrate（待激活） | 70 |  |
| 5 | 05:42:54 | kernel | 内核启动·lawdb（待激活） | 13 |  |
| 6 | 05:42:54 | kernel | 内核启动·skills（待激活） | 16 |  |
| 7 | 05:42:54 | kernel | 内核启动·identity_device（待激活） | 3 |  |
| 8 | 05:42:54 | kernel | 内核启动·endpoints（待激活） | 8 |  |
| 9 | 05:42:54 | kernel | 内核启动·ready（待激活） | 1 |  |
| 10 | 05:42:54 | kernel | 闸门·运行时核对（early） | 1 |  |
| 11 | 05:42:54 | main | 主进程·取库密钥 / fork |  | key=0 fork=0 |
| 12 | 05:42:54 | main | 主进程·整次重启 profile（restarted） | 15 |  |
| 13 | 05:42:54 | main | 主进程·关旧内核（exit） | 14 |  |
| 14 | 05:42:54 | main | 主进程·fork→就绪（待激活） | 236 |  |
| 15 | 05:42:54 | kernel | 闸门·拉起（含等待核对） | 89 |  |
| 16 | 05:42:54 | kernel | 待激活·withclaim | 114 |  |
| 17 | 05:42:54 | kernel | 待激活·enroll | 22 |  |
| 18 | 05:42:54 | kernel | 待激活·stage_write | 1 |  |
| 19 | 05:42:54 | kernel | 待激活·自动登记完成（锚点） |  |  |
| 20 | 05:42:54 | main | 主进程·收到按身份重启（锚点） |  |  |
| 21 | 05:42:54 | kernel | 内核·close() | 13 |  |
| 22 | 05:42:54 | kernel | 内核启动·init_wait | 70 |  |
| 23 | 05:42:54 | kernel | 内核启动·db_open_migrate | 69 |  |
| 24 | 05:42:55 | kernel | 内核启动·lawdb | 22 |  |
| 25 | 05:42:55 | kernel | 内核启动·skills | 17 |  |
| 26 | 05:42:55 | kernel | 内核启动·identity_device | 2 |  |
| 27 | 05:42:55 | kernel | 内核启动·endpoints | 8 |  |
| 28 | 05:42:55 | kernel | 内核启动·ready | 0 |  |
| 29 | 05:42:55 | kernel | 闸门·运行时核对（early） | 1 |  |
| 30 | 05:42:55 | main | 主进程·取库密钥 / fork |  | key=0 fork=0 |
| 31 | 05:42:55 | main | 主进程·整次重启 identity（restarted） | 14 |  |
| 32 | 05:42:55 | main | 主进程·关旧内核（exit） | 14 |  |
| 33 | 05:42:55 | main | 主进程·fork→就绪 | 239 |  |
| 34 | 05:42:55 | kernel | 闸门·拉起（含等待核对） | 90 |  |
| 35 | 05:42:55 | kernel | 同步（首轮）·总计 | 170 | register=114 docs=56 seat=0（accepted） |
| 36 | 05:42:55 | kernel | AI 可用（内核启动以来） | 362 |  |

串行分段合计约 707 ms；整次重启 15 / 14 ms；AI 可用（新内核启动以来）362 ms
