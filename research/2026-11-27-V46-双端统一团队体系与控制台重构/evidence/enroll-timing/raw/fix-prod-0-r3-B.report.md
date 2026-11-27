
## 第 1 轮（36 条计时事件）

| # | 时刻 | 进程 | 分段 | 毫秒 | 说明 |
|---|---|---|---|---:|---|
| 1 | 05:45:51 | kernel | 内核启动·init_wait（待激活） | 70 |  |
| 2 | 05:45:51 | main | 主进程·切换档案 auth（锚点） |  |  |
| 3 | 05:45:51 | kernel | 内核·close() | 12 |  |
| 4 | 05:45:51 | kernel | 内核启动·db_open_migrate（待激活） | 69 |  |
| 5 | 05:45:51 | kernel | 内核启动·lawdb（待激活） | 11 |  |
| 6 | 05:45:51 | kernel | 内核启动·skills（待激活） | 17 |  |
| 7 | 05:45:51 | kernel | 内核启动·identity_device（待激活） | 3 |  |
| 8 | 05:45:51 | kernel | 内核启动·endpoints（待激活） | 7 |  |
| 9 | 05:45:51 | kernel | 内核启动·ready（待激活） | 1 |  |
| 10 | 05:45:51 | kernel | 闸门·运行时核对（early） | 1 |  |
| 11 | 05:45:51 | main | 主进程·取库密钥 / fork |  | key=0 fork=1 |
| 12 | 05:45:51 | main | 主进程·整次重启 profile（restarted） | 13 |  |
| 13 | 05:45:51 | main | 主进程·关旧内核（exit） | 12 |  |
| 14 | 05:45:51 | main | 主进程·fork→就绪（待激活） | 227 |  |
| 15 | 05:45:51 | kernel | 闸门·拉起（含等待核对） | 67 |  |
| 16 | 05:45:51 | kernel | 待激活·withclaim | 84 |  |
| 17 | 05:45:51 | kernel | 待激活·enroll | 20 |  |
| 18 | 05:45:51 | kernel | 待激活·stage_write | 1 |  |
| 19 | 05:45:51 | kernel | 待激活·自动登记完成（锚点） |  |  |
| 20 | 05:45:51 | main | 主进程·收到按身份重启（锚点） |  |  |
| 21 | 05:45:51 | kernel | 内核·close() | 15 |  |
| 22 | 05:45:52 | kernel | 内核启动·init_wait | 70 |  |
| 23 | 05:45:52 | kernel | 内核启动·db_open_migrate | 71 |  |
| 24 | 05:45:52 | kernel | 内核启动·lawdb | 21 |  |
| 25 | 05:45:52 | kernel | 内核启动·skills | 19 |  |
| 26 | 05:45:52 | kernel | 内核启动·identity_device | 2 |  |
| 27 | 05:45:52 | kernel | 内核启动·endpoints | 9 |  |
| 28 | 05:45:52 | kernel | 内核启动·ready | 0 |  |
| 29 | 05:45:52 | kernel | 闸门·运行时核对（early） | 1 |  |
| 30 | 05:45:52 | main | 主进程·取库密钥 / fork |  | key=0 fork=0 |
| 31 | 05:45:52 | main | 主进程·整次重启 identity（restarted） | 16 |  |
| 32 | 05:45:52 | main | 主进程·关旧内核（exit） | 16 |  |
| 33 | 05:45:52 | main | 主进程·fork→就绪 | 242 |  |
| 34 | 05:45:52 | kernel | 闸门·拉起（含等待核对） | 68 |  |
| 35 | 05:45:52 | kernel | 同步（首轮）·总计 | 131 | register=82 docs=49 seat=0（accepted） |
| 36 | 05:45:52 | kernel | AI 可用（内核启动以来） | 324 |  |

串行分段合计约 636 ms；整次重启 13 / 16 ms；AI 可用（新内核启动以来）324 ms
