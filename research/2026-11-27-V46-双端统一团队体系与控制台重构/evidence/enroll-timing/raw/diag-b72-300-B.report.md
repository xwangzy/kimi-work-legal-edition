
## 第 1 轮（36 条计时事件）

| # | 时刻 | 进程 | 分段 | 毫秒 | 说明 |
|---|---|---|---|---:|---|
| 1 | 04:21:20 | main | 主进程·切换档案 auth（锚点） |  |  |
| 2 | 04:21:20 | kernel | 内核·close() | 11 |  |
| 3 | 04:21:21 | kernel | 内核启动·init_wait（待激活） | 69 |  |
| 4 | 04:21:21 | kernel | 内核启动·db_open_migrate（待激活） | 69 |  |
| 5 | 04:21:21 | kernel | 内核启动·lawdb（待激活） | 13 |  |
| 6 | 04:21:21 | kernel | 内核启动·skills（待激活） | 16 |  |
| 7 | 04:21:21 | kernel | 内核启动·identity_device（待激活） | 3 |  |
| 8 | 04:21:21 | kernel | 内核启动·endpoints（待激活） | 9 |  |
| 9 | 04:21:21 | kernel | 内核启动·ready（待激活） | 1 |  |
| 10 | 04:21:21 | main | 主进程·取库密钥 / fork |  | key=0 fork=1 |
| 11 | 04:21:21 | main | 主进程·整次重启 profile（restarted） | 14 |  |
| 12 | 04:21:21 | main | 主进程·关旧内核（exit） | 13 |  |
| 13 | 04:21:21 | main | 主进程·fork→就绪（待激活） | 223 |  |
| 14 | 04:21:21 | kernel | 闸门·运行时核对（hashed） | 52 |  |
| 15 | 04:21:21 | kernel | 闸门·拉起（含等待核对） | 53 |  |
| 16 | 04:21:21 | kernel | 待激活·withclaim | 727 |  |
| 17 | 04:21:22 | kernel | 待激活·enroll | 324 |  |
| 18 | 04:21:22 | kernel | 待激活·stage_write | 1 |  |
| 19 | 04:21:22 | kernel | 待激活·自动登记完成（锚点） |  |  |
| 20 | 04:21:22 | main | 主进程·收到按身份重启（锚点） |  |  |
| 21 | 04:21:22 | kernel | 内核·close() | 17 |  |
| 22 | 04:21:22 | kernel | 内核启动·init_wait | 69 |  |
| 23 | 04:21:22 | kernel | 内核启动·db_open_migrate | 64 |  |
| 24 | 04:21:22 | kernel | 内核启动·lawdb | 19 |  |
| 25 | 04:21:22 | kernel | 内核启动·skills | 17 |  |
| 26 | 04:21:22 | kernel | 内核启动·identity_device | 2 |  |
| 27 | 04:21:22 | kernel | 内核启动·endpoints | 8 |  |
| 28 | 04:21:22 | kernel | 内核启动·ready | 0 |  |
| 29 | 04:21:22 | main | 主进程·取库密钥 / fork |  | key=0 fork=1 |
| 30 | 04:21:22 | main | 主进程·整次重启 identity（restarted） | 20 |  |
| 31 | 04:21:22 | main | 主进程·关旧内核（exit） | 19 |  |
| 32 | 04:21:22 | main | 主进程·fork→就绪 | 238 |  |
| 33 | 04:21:22 | kernel | 闸门·运行时核对（hashed） | 51 |  |
| 34 | 04:21:22 | kernel | 闸门·拉起（含等待核对） | 57 |  |
| 35 | 04:21:24 | kernel | 同步（首轮）·总计 | 1375 | register=727 docs=646 seat=1（accepted） |
| 36 | 04:21:24 | kernel | AI 可用（内核启动以来） | 1554 |  |

串行分段合计约 2921 ms；整次重启 14 / 20 ms；AI 可用（新内核启动以来）1554 ms
