
## 第 1 轮（36 条计时事件）

| # | 时刻 | 进程 | 分段 | 毫秒 | 说明 |
|---|---|---|---|---:|---|
| 1 | 04:24:50 | main | 主进程·切换档案 auth（锚点） |  |  |
| 2 | 04:24:50 | kernel | 内核·close() | 16 |  |
| 3 | 04:24:50 | kernel | 内核启动·init_wait（待激活） | 71 |  |
| 4 | 04:24:50 | kernel | 内核启动·db_open_migrate（待激活） | 66 |  |
| 5 | 04:24:50 | kernel | 内核启动·lawdb（待激活） | 12 |  |
| 6 | 04:24:50 | kernel | 内核启动·skills（待激活） | 16 |  |
| 7 | 04:24:50 | kernel | 内核启动·identity_device（待激活） | 4 |  |
| 8 | 04:24:50 | kernel | 内核启动·endpoints（待激活） | 7 |  |
| 9 | 04:24:50 | kernel | 内核启动·ready（待激活） | 2 |  |
| 10 | 04:24:50 | main | 主进程·取库密钥 / fork |  | key=0 fork=1 |
| 11 | 04:24:50 | main | 主进程·整次重启 profile（restarted） | 18 |  |
| 12 | 04:24:50 | main | 主进程·关旧内核（exit） | 17 |  |
| 13 | 04:24:50 | main | 主进程·fork→就绪（待激活） | 227 |  |
| 14 | 04:24:50 | kernel | 闸门·运行时核对（hashed） | 52 |  |
| 15 | 04:24:50 | kernel | 闸门·拉起（含等待核对） | 51 |  |
| 16 | 04:24:51 | kernel | 待激活·withclaim | 725 |  |
| 17 | 04:24:51 | kernel | 待激活·enroll | 333 |  |
| 18 | 04:24:51 | kernel | 待激活·stage_write | 2 |  |
| 19 | 04:24:51 | kernel | 待激活·自动登记完成（锚点） |  |  |
| 20 | 04:24:52 | main | 主进程·收到按身份重启（锚点） |  |  |
| 21 | 04:24:52 | kernel | 内核·close() | 12 |  |
| 22 | 04:24:52 | kernel | 内核启动·init_wait | 69 |  |
| 23 | 04:24:52 | kernel | 内核启动·db_open_migrate | 67 |  |
| 24 | 04:24:52 | kernel | 内核启动·lawdb | 21 |  |
| 25 | 04:24:52 | kernel | 内核启动·skills | 16 |  |
| 26 | 04:24:52 | kernel | 内核启动·identity_device | 2 |  |
| 27 | 04:24:52 | kernel | 内核启动·endpoints | 9 |  |
| 28 | 04:24:52 | kernel | 内核启动·ready | 0 |  |
| 29 | 04:24:52 | main | 主进程·取库密钥 / fork |  | key=0 fork=1 |
| 30 | 04:24:52 | main | 主进程·整次重启 identity（restarted） | 14 |  |
| 31 | 04:24:52 | main | 主进程·关旧内核（exit） | 13 |  |
| 32 | 04:24:52 | main | 主进程·fork→就绪 | 234 |  |
| 33 | 04:24:52 | kernel | 闸门·运行时核对（hashed） | 51 |  |
| 34 | 04:24:52 | kernel | 闸门·拉起（含等待核对） | 52 |  |
| 35 | 04:24:53 | kernel | 同步（首轮）·总计 | 1364 | register=716 docs=645 seat=2（accepted） |
| 36 | 04:24:53 | kernel | AI 可用（内核启动以来） | 1548 |  |

串行分段合计约 2919 ms；整次重启 18 / 14 ms；AI 可用（新内核启动以来）1548 ms
