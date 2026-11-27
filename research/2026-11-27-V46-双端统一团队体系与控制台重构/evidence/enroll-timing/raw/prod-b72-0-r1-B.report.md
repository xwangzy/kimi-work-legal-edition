
## 第 1 轮（36 条计时事件）

| # | 时刻 | 进程 | 分段 | 毫秒 | 说明 |
|---|---|---|---|---:|---|
| 1 | 04:27:24 | kernel | 内核启动·init_wait（待激活） | 69 |  |
| 2 | 04:27:24 | main | 主进程·切换档案 auth（锚点） |  |  |
| 3 | 04:27:24 | kernel | 内核·close() | 14 |  |
| 4 | 04:27:24 | kernel | 内核启动·db_open_migrate（待激活） | 68 |  |
| 5 | 04:27:24 | kernel | 内核启动·lawdb（待激活） | 12 |  |
| 6 | 04:27:24 | kernel | 内核启动·skills（待激活） | 17 |  |
| 7 | 04:27:24 | kernel | 内核启动·identity_device（待激活） | 4 |  |
| 8 | 04:27:24 | kernel | 内核启动·endpoints（待激活） | 8 |  |
| 9 | 04:27:24 | kernel | 内核启动·ready（待激活） | 1 |  |
| 10 | 04:27:24 | main | 主进程·取库密钥 / fork |  | key=1 fork=0 |
| 11 | 04:27:24 | main | 主进程·整次重启 profile（restarted） | 15 |  |
| 12 | 04:27:24 | main | 主进程·关旧内核（exit） | 14 |  |
| 13 | 04:27:24 | main | 主进程·fork→就绪（待激活） | 228 |  |
| 14 | 04:27:24 | kernel | 闸门·运行时核对（hashed） | 53 |  |
| 15 | 04:27:24 | kernel | 闸门·拉起（含等待核对） | 53 |  |
| 16 | 04:27:24 | kernel | 待激活·withclaim | 122 |  |
| 17 | 04:27:24 | kernel | 待激活·enroll | 21 |  |
| 18 | 04:27:24 | kernel | 待激活·stage_write | 1 |  |
| 19 | 04:27:24 | kernel | 待激活·自动登记完成（锚点） |  |  |
| 20 | 04:27:24 | main | 主进程·收到按身份重启（锚点） |  |  |
| 21 | 04:27:24 | kernel | 内核·close() | 11 |  |
| 22 | 04:27:24 | kernel | 内核启动·init_wait | 71 |  |
| 23 | 04:27:24 | kernel | 内核启动·db_open_migrate | 69 |  |
| 24 | 04:27:24 | kernel | 内核启动·lawdb | 24 |  |
| 25 | 04:27:25 | kernel | 内核启动·skills | 17 |  |
| 26 | 04:27:25 | kernel | 内核启动·identity_device | 2 |  |
| 27 | 04:27:25 | kernel | 内核启动·endpoints | 9 |  |
| 28 | 04:27:25 | kernel | 内核启动·ready | 1 |  |
| 29 | 04:27:25 | main | 主进程·取库密钥 / fork |  | key=0 fork=1 |
| 30 | 04:27:25 | main | 主进程·整次重启 identity（restarted） | 12 |  |
| 31 | 04:27:25 | main | 主进程·关旧内核（exit） | 11 |  |
| 32 | 04:27:25 | main | 主进程·fork→就绪 | 235 |  |
| 33 | 04:27:25 | kernel | 闸门·运行时核对（hashed） | 53 |  |
| 34 | 04:27:25 | kernel | 闸门·拉起（含等待核对） | 54 |  |
| 35 | 04:27:25 | kernel | 同步（首轮）·总计 | 159 | register=116 docs=42 seat=0（accepted） |
| 36 | 04:27:25 | kernel | AI 可用（内核启动以来） | 352 |  |

串行分段合计约 806 ms；整次重启 15 / 12 ms；AI 可用（新内核启动以来）352 ms
