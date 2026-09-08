# SparkLend Position Monitor

SparkLend 使用与 Aave V3 兼容的 Pool `getUserAccountData(address)` 只读接口。部署地址和 RPC
不会写死在脚本中，而是由 `spark_lend` Resource 配置。Source 负责 RPC 查询，Adapter 只负责把
协议结果转换为通用 `HealthInputs`，Rule 复用 Chain Sentinel 的阈值、趋势、去重和消息汇总能力。

第一版按 Pool/网络产生一个仓位，支持：

- Health Factor 阈值；
- 指定时间窗口内 HF 下降百分比；
- 指定时间窗口内债务增长百分比；
- 根据 HF 估算的抵押品价格下跌清算缓冲；
- 每次运行的消息上限和汇总策略。

`spark_lend` Resource 中的地址应来自 Spark 官方 address registry。RPC 只执行 `eth_call`，
不需要钱包私钥。
