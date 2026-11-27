
## 第 1 轮（36 条计时事件）

| # | 时刻 | 进程 | 分段 | 毫秒 | 说明 |
|---|---|---|---|---:|---|
| 1 | 05:45:23 | main | 主进程·切换档案 auth（锚点） |  |  |
| 2 | 05:45:23 | kernel | 内核·close() | 15 |  |
| 3 | 05:45:23 | kernel | 内核启动·init_wait（待激活） | 69 |  |
| 4 | 05:45:23 | kernel | 内核启动·db_open_migrate（待激活） | 70 |  |
| 5 | 05:45:23 | kernel | 内核启动·lawdb（待激活） | 11 |  |
| 6 | 05:45:23 | kernel | 内核启动·skills（待激活） | 17 |  |
| 7 | 05:45:23 | kernel | 内核启动·identity_device（待激活） | 3 |  |
| 8 | 05:45:23 | kernel | 内核启动·endpoints（待激活） | 8 |  |
| 9 | 05:45:23 | kernel | 内核启动·ready（待激活） | 1 |  |
| 10 | 05:45:23 | kernel | 闸门·运行时核对（early） | 1 |  |
| 11 | 05:45:23 | main | 主进程·取库密钥 / fork |  | key=1 fork=0 |
| 12 | 05:45:23 | main | 主进程·整次重启 profile（restarted） | 17 |  |
| 13 | 05:45:23 | main | 主进程·关旧内核（exit） | 16 |  |
| 14 | 05:45:23 | main | 主进程·fork→就绪（待激活） | 237 |  |
| 15 | 05:45:23 | kernel | 闸门·拉起（含等待核对） | 66 |  |
| 16 | 05:45:23 | kernel | 待激活·withclaim | 82 |  |
| 17 | 05:45:23 | kernel | 待激活·enroll | 25 |  |
| 18 | 05:45:23 | kernel | 待激活·stage_write | 1 |  |
| 19 | 05:45:23 | kernel | 待激活·自动登记完成（锚点） |  |  |
| 20 | 05:45:23 | main | 主进程·收到按身份重启（锚点） |  |  |
| 21 | 05:45:23 | kernel | 内核·close() | 18 |  |
| 22 | 05:45:23 | kernel | 内核启动·init_wait | 71 |  |
| 23 | 05:45:23 | kernel | 内核启动·db_open_migrate | 69 |  |
| 24 | 05:45:23 | kernel | 内核启动·lawdb | 22 |  |
| 25 | 05:45:24 | kernel | 内核启动·skills | 18 |  |
| 26 | 05:45:24 | kernel | 内核启动·identity_device | 2 |  |
| 27 | 05:45:24 | kernel | 内核启动·endpoints | 8 |  |
| 28 | 05:45:24 | kernel | 内核启动·ready | 0 |  |
| 29 | 05:45:24 | kernel | 闸门·运行时核对（early） | 1 |  |
| 30 | 05:45:24 | main | 主进程·取库密钥 / fork |  | key=0 fork=1 |
| 31 | 05:45:24 | main | 主进程·整次重启 identity（restarted） | 20 |  |
| 32 | 05:45:24 | main | 主进程·关旧内核（exit） | 19 |  |
| 33 | 05:45:24 | main | 主进程·fork→就绪 | 240 |  |
| 34 | 05:45:24 | kernel | 闸门·拉起（含等待核对） | 67 |  |
| 35 | 05:45:24 | kernel | 同步（首轮）·总计 | 131 | register=81 docs=50 seat=0（accepted） |
| 36 | 05:45:24 | kernel | AI 可用（内核启动以来） | 321 |  |

串行分段合计约 645 ms；整次重启 17 / 20 ms；AI 可用（新内核启动以来）321 ms
