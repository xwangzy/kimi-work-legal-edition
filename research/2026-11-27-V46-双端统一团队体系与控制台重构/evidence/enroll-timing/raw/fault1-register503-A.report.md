
## 第 1 轮（20 条计时事件）

| # | 时刻 | 进程 | 分段 | 毫秒 | 说明 |
|---|---|---|---|---:|---|
| 1 | 05:47:45 | main | 主进程·收到按身份重启（锚点） |  |  |
| 2 | 05:47:45 | kernel | 内核·close() | 15 |  |
| 3 | 05:47:45 | kernel | 内核启动·init_wait | 70 |  |
| 4 | 05:47:45 | kernel | 内核启动·db_open_migrate | 73 |  |
| 5 | 05:47:45 | kernel | 内核启动·lawdb | 22 |  |
| 6 | 05:47:45 | kernel | 内核启动·skills | 17 |  |
| 7 | 05:47:45 | kernel | 内核启动·identity_device | 3 |  |
| 8 | 05:47:45 | kernel | 内核启动·endpoints | 8 |  |
| 9 | 05:47:45 | kernel | 内核启动·ready | 1 |  |
| 10 | 05:47:45 | kernel | 闸门·运行时核对（early） | 1 |  |
| 11 | 05:47:45 | main | 主进程·取库密钥 / fork |  | key=0 fork=1 |
| 12 | 05:47:45 | main | 主进程·整次重启 identity（restarted） | 17 |  |
| 13 | 05:47:45 | main | 主进程·关旧内核（exit） | 15 |  |
| 14 | 05:47:45 | main | 主进程·fork→就绪 | 256 |  |
| 15 | 05:47:45 | kernel | 闸门·拉起（含等待核对） | 79 |  |
| 16 | 05:47:46 | kernel | 同步（首轮）·总计（未全成） | 1024 | register=1024 docs=- seat=-（none） |
| 17 | 05:47:49 | kernel | 同步（首轮）·总计（未全成） | 605 | register=605 docs=- seat=-（none） |
| 18 | 05:47:53 | kernel | 同步（首轮）·总计（未全成） | 606 | register=606 docs=- seat=-（none） |
| 19 | 05:48:02 | kernel | 同步（首轮）·总计 | 1265 | register=630 docs=633 seat=0（accepted） |
| 20 | 05:48:02 | kernel | AI 可用（内核启动以来） | 17700 |  |

串行分段合计约 3710 ms；整次重启 17 ms；AI 可用（新内核启动以来）17700 ms
