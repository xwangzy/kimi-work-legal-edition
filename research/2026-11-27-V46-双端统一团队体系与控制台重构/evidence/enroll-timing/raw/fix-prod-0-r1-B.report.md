
## 第 1 轮（36 条计时事件）

| # | 时刻 | 进程 | 分段 | 毫秒 | 说明 |
|---|---|---|---|---:|---|
| 1 | 05:44:54 | kernel | 内核启动·init_wait（待激活） | 67 |  |
| 2 | 05:44:54 | main | 主进程·切换档案 auth（锚点） |  |  |
| 3 | 05:44:54 | kernel | 内核·close() | 11 |  |
| 4 | 05:44:55 | kernel | 内核启动·db_open_migrate（待激活） | 70 |  |
| 5 | 05:44:55 | kernel | 内核启动·lawdb（待激活） | 12 |  |
| 6 | 05:44:55 | kernel | 内核启动·skills（待激活） | 15 |  |
| 7 | 05:44:55 | kernel | 内核启动·identity_device（待激活） | 4 |  |
| 8 | 05:44:55 | kernel | 内核启动·endpoints（待激活） | 8 |  |
| 9 | 05:44:55 | kernel | 内核启动·ready（待激活） | 1 |  |
| 10 | 05:44:55 | kernel | 闸门·运行时核对（early） | 1 |  |
| 11 | 05:44:55 | main | 主进程·取库密钥 / fork |  | key=1 fork=0 |
| 12 | 05:44:55 | main | 主进程·整次重启 profile（restarted） | 12 |  |
| 13 | 05:44:55 | main | 主进程·关旧内核（exit） | 11 |  |
| 14 | 05:44:55 | main | 主进程·fork→就绪（待激活） | 218 |  |
| 15 | 05:44:55 | kernel | 闸门·拉起（含等待核对） | 64 |  |
| 16 | 05:44:55 | kernel | 待激活·withclaim | 84 |  |
| 17 | 05:44:55 | kernel | 待激活·enroll | 22 |  |
| 18 | 05:44:55 | kernel | 待激活·stage_write | 1 |  |
| 19 | 05:44:55 | kernel | 待激活·自动登记完成（锚点） |  |  |
| 20 | 05:44:55 | main | 主进程·收到按身份重启（锚点） |  |  |
| 21 | 05:44:55 | kernel | 内核·close() | 14 |  |
| 22 | 05:44:55 | kernel | 内核启动·init_wait | 69 |  |
| 23 | 05:44:55 | kernel | 内核启动·db_open_migrate | 71 |  |
| 24 | 05:44:55 | kernel | 内核启动·lawdb | 21 |  |
| 25 | 05:44:55 | kernel | 内核启动·skills | 17 |  |
| 26 | 05:44:55 | kernel | 内核启动·identity_device | 2 |  |
| 27 | 05:44:55 | kernel | 内核启动·endpoints | 8 |  |
| 28 | 05:44:55 | kernel | 内核启动·ready | 1 |  |
| 29 | 05:44:55 | kernel | 闸门·运行时核对（early） | 1 |  |
| 30 | 05:44:55 | main | 主进程·取库密钥 / fork |  | key=0 fork=1 |
| 31 | 05:44:55 | main | 主进程·整次重启 identity（restarted） | 15 |  |
| 32 | 05:44:55 | main | 主进程·关旧内核（exit） | 14 |  |
| 33 | 05:44:55 | main | 主进程·fork→就绪 | 236 |  |
| 34 | 05:44:55 | kernel | 闸门·拉起（含等待核对） | 68 |  |
| 35 | 05:44:55 | kernel | 同步（首轮）·总计 | 137 | register=83 docs=52 seat=1（accepted） |
| 36 | 05:44:55 | kernel | AI 可用（内核启动以来） | 326 |  |

串行分段合计约 637 ms；整次重启 12 / 15 ms；AI 可用（新内核启动以来）326 ms
