
## 第 1 轮（20 条计时事件）

| # | 时刻 | 进程 | 分段 | 毫秒 | 说明 |
|---|---|---|---|---:|---|
| 1 | 05:51:40 | main | 主进程·收到按身份重启（锚点） |  |  |
| 2 | 05:51:40 | kernel | 内核·close() | 11 |  |
| 3 | 05:51:40 | kernel | 内核启动·init_wait | 69 |  |
| 4 | 05:51:40 | kernel | 内核启动·db_open_migrate | 70 |  |
| 5 | 05:51:40 | kernel | 内核启动·lawdb | 20 |  |
| 6 | 05:51:40 | kernel | 内核启动·skills | 17 |  |
| 7 | 05:51:40 | kernel | 内核启动·identity_device | 4 |  |
| 8 | 05:51:40 | kernel | 内核启动·endpoints | 9 |  |
| 9 | 05:51:40 | kernel | 内核启动·ready | 0 |  |
| 10 | 05:51:40 | kernel | 闸门·运行时核对（early） | 1 |  |
| 11 | 05:51:40 | main | 主进程·取库密钥 / fork |  | key=0 fork=1 |
| 12 | 05:51:40 | main | 主进程·整次重启 identity（restarted） | 12 |  |
| 13 | 05:51:40 | main | 主进程·关旧内核（exit） | 11 |  |
| 14 | 05:51:40 | main | 主进程·fork→就绪 | 234 |  |
| 15 | 05:51:40 | kernel | 闸门·拉起（含等待核对） | 71 |  |
| 16 | 05:51:42 | kernel | 同步（首轮）·总计（未全成） | 1683 | register=1037 docs=644 seat=1（error） |
| 17 | 05:51:44 | kernel | 同步（首轮）·总计（未全成） | 649 | register=313 docs=336 seat=0（error） |
| 18 | 05:51:49 | kernel | 同步（首轮）·总计（未全成） | 1251 | register=613 docs=638 seat=0（error） |
| 19 | 05:51:59 | kernel | 同步（首轮）·总计 | 1255 | register=611 docs=643 seat=0（accepted） |
| 20 | 05:51:59 | kernel | AI 可用（内核启动以来） | 19031 |  |

串行分段合计约 5039 ms；整次重启 12 ms；AI 可用（新内核启动以来）19031 ms
