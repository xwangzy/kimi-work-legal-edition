
## 第 1 轮（36 条计时事件）

| # | 时刻 | 进程 | 分段 | 毫秒 | 说明 |
|---|---|---|---|---:|---|
| 1 | 04:23:47 | main | 主进程·切换档案 auth（锚点） |  |  |
| 2 | 04:23:47 | kernel | 内核·close() | 19 |  |
| 3 | 04:23:47 | kernel | 内核启动·init_wait（待激活） | 69 |  |
| 4 | 04:23:47 | kernel | 内核启动·db_open_migrate（待激活） | 65 |  |
| 5 | 04:23:47 | kernel | 内核启动·lawdb（待激活） | 12 |  |
| 6 | 04:23:47 | kernel | 内核启动·skills（待激活） | 15 |  |
| 7 | 04:23:47 | kernel | 内核启动·identity_device（待激活） | 3 |  |
| 8 | 04:23:47 | kernel | 内核启动·endpoints（待激活） | 8 |  |
| 9 | 04:23:47 | kernel | 内核启动·ready（待激活） | 1 |  |
| 10 | 04:23:47 | main | 主进程·取库密钥 / fork |  | key=0 fork=1 |
| 11 | 04:23:47 | main | 主进程·整次重启 profile（restarted） | 21 |  |
| 12 | 04:23:47 | main | 主进程·关旧内核（exit） | 20 |  |
| 13 | 04:23:47 | main | 主进程·fork→就绪（待激活） | 226 |  |
| 14 | 04:23:47 | kernel | 闸门·运行时核对（hashed） | 51 |  |
| 15 | 04:23:47 | kernel | 闸门·拉起（含等待核对） | 52 |  |
| 16 | 04:23:48 | kernel | 待激活·withclaim | 722 |  |
| 17 | 04:23:48 | kernel | 待激活·enroll | 323 |  |
| 18 | 04:23:48 | kernel | 待激活·stage_write | 1 |  |
| 19 | 04:23:48 | kernel | 待激活·自动登记完成（锚点） |  |  |
| 20 | 04:23:48 | main | 主进程·收到按身份重启（锚点） |  |  |
| 21 | 04:23:48 | kernel | 内核·close() | 12 |  |
| 22 | 04:23:48 | kernel | 内核启动·init_wait | 69 |  |
| 23 | 04:23:48 | kernel | 内核启动·db_open_migrate | 63 |  |
| 24 | 04:23:48 | kernel | 内核启动·lawdb | 22 |  |
| 25 | 04:23:48 | kernel | 内核启动·skills | 18 |  |
| 26 | 04:23:48 | kernel | 内核启动·identity_device | 2 |  |
| 27 | 04:23:48 | kernel | 内核启动·endpoints | 8 |  |
| 28 | 04:23:48 | kernel | 内核启动·ready | 0 |  |
| 29 | 04:23:48 | main | 主进程·取库密钥 / fork |  | key=0 fork=1 |
| 30 | 04:23:48 | main | 主进程·整次重启 identity（restarted） | 13 |  |
| 31 | 04:23:48 | main | 主进程·关旧内核（exit） | 12 |  |
| 32 | 04:23:48 | main | 主进程·fork→就绪 | 232 |  |
| 33 | 04:23:49 | kernel | 闸门·运行时核对（hashed） | 52 |  |
| 34 | 04:23:49 | kernel | 闸门·拉起（含等待核对） | 52 |  |
| 35 | 04:23:50 | kernel | 同步（首轮）·总计 | 1366 | register=723 docs=642 seat=1（accepted） |
| 36 | 04:23:50 | kernel | AI 可用（内核启动以来） | 1549 |  |

串行分段合计约 2902 ms；整次重启 21 / 13 ms；AI 可用（新内核启动以来）1549 ms
