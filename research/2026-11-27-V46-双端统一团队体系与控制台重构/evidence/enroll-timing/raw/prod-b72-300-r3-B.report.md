
## 第 1 轮（36 条计时事件）

| # | 时刻 | 进程 | 分段 | 毫秒 | 说明 |
|---|---|---|---|---:|---|
| 1 | 04:25:53 | main | 主进程·切换档案 auth（锚点） |  |  |
| 2 | 04:25:53 | kernel | 内核·close() | 13 |  |
| 3 | 04:25:54 | kernel | 内核启动·init_wait（待激活） | 70 |  |
| 4 | 04:25:54 | kernel | 内核启动·db_open_migrate（待激活） | 65 |  |
| 5 | 04:25:54 | kernel | 内核启动·lawdb（待激活） | 11 |  |
| 6 | 04:25:54 | kernel | 内核启动·skills（待激活） | 17 |  |
| 7 | 04:25:54 | kernel | 内核启动·identity_device（待激活） | 3 |  |
| 8 | 04:25:54 | kernel | 内核启动·endpoints（待激活） | 8 |  |
| 9 | 04:25:54 | kernel | 内核启动·ready（待激活） | 1 |  |
| 10 | 04:25:54 | main | 主进程·取库密钥 / fork |  | key=1 fork=0 |
| 11 | 04:25:54 | main | 主进程·整次重启 profile（restarted） | 15 |  |
| 12 | 04:25:54 | main | 主进程·关旧内核（exit） | 14 |  |
| 13 | 04:25:54 | main | 主进程·fork→就绪（待激活） | 227 |  |
| 14 | 04:25:54 | kernel | 闸门·运行时核对（hashed） | 51 |  |
| 15 | 04:25:54 | kernel | 闸门·拉起（含等待核对） | 52 |  |
| 16 | 04:25:54 | kernel | 待激活·withclaim | 724 |  |
| 17 | 04:25:55 | kernel | 待激活·enroll | 330 |  |
| 18 | 04:25:55 | kernel | 待激活·stage_write | 1 |  |
| 19 | 04:25:55 | kernel | 待激活·自动登记完成（锚点） |  |  |
| 20 | 04:25:55 | main | 主进程·收到按身份重启（锚点） |  |  |
| 21 | 04:25:55 | kernel | 内核·close() | 18 |  |
| 22 | 04:25:55 | kernel | 内核启动·init_wait | 69 |  |
| 23 | 04:25:55 | kernel | 内核启动·db_open_migrate | 65 |  |
| 24 | 04:25:55 | kernel | 内核启动·lawdb | 22 |  |
| 25 | 04:25:55 | kernel | 内核启动·skills | 17 |  |
| 26 | 04:25:55 | kernel | 内核启动·identity_device | 2 |  |
| 27 | 04:25:55 | kernel | 内核启动·endpoints | 8 |  |
| 28 | 04:25:55 | kernel | 内核启动·ready | 0 |  |
| 29 | 04:25:55 | main | 主进程·取库密钥 / fork |  | key=1 fork=0 |
| 30 | 04:25:55 | main | 主进程·整次重启 identity（restarted） | 19 |  |
| 31 | 04:25:55 | main | 主进程·关旧内核（exit） | 18 |  |
| 32 | 04:25:55 | main | 主进程·fork→就绪 | 236 |  |
| 33 | 04:25:55 | kernel | 闸门·运行时核对（hashed） | 52 |  |
| 34 | 04:25:55 | kernel | 闸门·拉起（含等待核对） | 52 |  |
| 35 | 04:25:57 | kernel | 同步（首轮）·总计 | 1366 | register=717 docs=649 seat=0（accepted） |
| 36 | 04:25:57 | kernel | AI 可用（内核启动以来） | 1550 |  |

串行分段合计约 2914 ms；整次重启 15 / 19 ms；AI 可用（新内核启动以来）1550 ms
