
## 第 1 轮（35 条计时事件）

| # | 时刻 | 进程 | 分段 | 毫秒 | 说明 |
|---|---|---|---|---:|---|
| 1 | 05:41:56 | main | 主进程·切换档案 auth（锚点） |  |  |
| 2 | 05:41:56 | kernel | 内核·close() | 11 |  |
| 3 | 05:41:56 | kernel | 内核启动·init_wait（待激活） | 74 |  |
| 4 | 05:41:56 | kernel | 内核启动·db_open_migrate（待激活） | 89 |  |
| 5 | 05:41:56 | kernel | 内核启动·lawdb（待激活） | 13 |  |
| 6 | 05:41:57 | kernel | 内核启动·skills（待激活） | 24 |  |
| 7 | 05:41:57 | kernel | 内核启动·identity_device（待激活） | 3 |  |
| 8 | 05:41:57 | kernel | 内核启动·endpoints（待激活） | 9 |  |
| 9 | 05:41:57 | kernel | 内核启动·ready（待激活） | 1 |  |
| 10 | 05:41:57 | kernel | 闸门·运行时核对（early） | 1 |  |
| 11 | 05:41:57 | main | 主进程·取库密钥 / fork |  | key=0 fork=1 |
| 12 | 05:41:57 | main | 主进程·整次重启 profile（restarted） | 13 |  |
| 13 | 05:41:57 | main | 主进程·关旧内核（exit） | 12 |  |
| 14 | 05:41:57 | main | 主进程·fork→就绪（待激活） | 270 |  |
| 15 | 05:41:57 | kernel | 闸门·拉起（含等待核对） | 101 |  |
| 16 | 05:41:57 | kernel | 待激活·withclaim | 125 |  |
| 17 | 05:41:57 | kernel | 待激活·enroll | 23 |  |
| 18 | 05:41:57 | kernel | 待激活·stage_write | 1 |  |
| 19 | 05:41:57 | kernel | 待激活·自动登记完成（锚点） |  |  |
| 20 | 05:41:57 | main | 主进程·收到按身份重启（锚点） |  |  |
| 21 | 05:41:57 | kernel | 内核启动·init_wait | 68 |  |
| 22 | 05:41:57 | kernel | 内核启动·db_open_migrate | 70 |  |
| 23 | 05:41:57 | kernel | 内核启动·lawdb | 21 |  |
| 24 | 05:41:57 | kernel | 内核启动·skills | 16 |  |
| 25 | 05:41:57 | kernel | 内核启动·identity_device | 3 |  |
| 26 | 05:41:57 | kernel | 内核启动·endpoints | 8 |  |
| 27 | 05:41:57 | kernel | 内核启动·ready | 0 |  |
| 28 | 05:41:57 | kernel | 闸门·运行时核对（early） | 1 |  |
| 29 | 05:41:57 | main | 主进程·取库密钥 / fork |  | key=0 fork=1 |
| 30 | 05:41:57 | main | 主进程·整次重启 identity（restarted） | 19 |  |
| 31 | 05:41:57 | main | 主进程·关旧内核（exit） | 18 |  |
| 32 | 05:41:57 | main | 主进程·fork→就绪 | 234 |  |
| 33 | 05:41:57 | kernel | 闸门·拉起（含等待核对） | 92 |  |
| 34 | 05:41:57 | kernel | 同步（首轮）·总计 | 165 | register=109 docs=55 seat=0（accepted） |
| 35 | 05:41:57 | kernel | AI 可用（内核启动以来） | 351 |  |

串行分段合计约 745 ms；整次重启 13 / 19 ms；AI 可用（新内核启动以来）351 ms
