# X Webhook → Telegram

X Activity 的 `post.create` 请求经 Windmill 验签后，直接提交现有
`u/oneke/channels/notification` Flow。消息固定为 `info`，发送到已有 Telegram
Bot 和群，不进入 FlashDuty。没有事件识别、去重、补采或自动重试。

## Windmill 配置

- `x_crc.ts` 与 `x_crc.http_trigger.yaml`：GET CRC 验证。
- `x_to_telegram.ts` 与 `x_to_telegram.http_trigger.yaml`：POST 验签及转发。
- 两条路由的 `route_path` 均为 `x/events`，并启用 workspace 命名空间。
- 两个脚本均开启 `has_preprocessor`；POST 路由开启 `raw_string`，签名针对原始
  请求体计算，不能重新序列化 JSON。
- 路由使用 `sync`，脚本等待 `runFlowAsync` 返回通知 Job ID 后才响应成功。
  Telegram 在独立 Flow Job 中发送，回调不等待投递完成。

在 Windmill 创建 Secret Variable `u/oneke/variables/x_client_secret`，填入 X App
的 **OAuth 2.0 Client Secret**。`u/oneke/resources/x-webhook` Resource 引用它。
不要使用 Bearer Token 代替签名 Secret，不要把实际凭证提交到 Git。

代码和路由通过本仓库已有的 Git push / GitHub Actions 流程部署。
从部署后路由详情复制完整 HTTPS callback URL；GET 与 POST 必须是同一个 URL。
首次注册时 GET CRC 会立即被调用，需先准备 Secret 和部署路由。

## X 配置

下面是外部 API 配置步骤，不会由接收脚本自动执行。注册和订阅需要 X App 的
App-only Bearer Token；它只用于设置，不需要保存在本项目的接收 Resource 中。

1. `POST https://api.x.com/2/webhooks`，使用 Bearer Token，JSON 为
   `{"url":"<Windmill callback URL>"}`。保存响应中的 `data.id` 为 Webhook ID。
2. 用 `GET https://api.x.com/2/users/by/username/<username>` 解析目标账号的 user ID。
3. 为每个账号调用 `POST https://api.x.com/2/activity/subscriptions`，绑定同一个 Webhook：

   ```json
   {
     "event_type": "post.create",
     "filter": { "user_id": "<X account user ID>" },
     "webhook_id": "<registered webhook ID>",
     "tag": "@PeckShieldAlert"
   }
   ```

`tag` 必须填写对应的 `@username`，用于 Telegram 消息标题。不额外查询作者资料。
首批账号：`PeckShieldAlert`、`CyversAlerts`、`CertiKAlert`、`SlowMist_Team`、
`Phalcon_xyz`、`TenArmorAlert`、`blockaid_`、`realScamSniffer`、`DefimonAlerts`。

只订阅 `post.create`。原创、回复、引用和转帖都转发；其他事件类型直接报错。
正文优先使用事件已有的 `note_tweet.text`，否则使用普通帖子的 `text`。
不主动补取正文、图片或视频，通知保留原帖链接。

## 通知与失败行为

消息包含账号、原文、Asia/Shanghai 发布时间和原帖链接。长正文按 1700 个
Unicode 字符分段，每段保留时间与链接，为 Telegram 的 4096 字符限制预留空间。

CRC 参数缺失或 Resource 读取失败时直接抛错，X 因收不到有效 token 而无法完成验证。
POST 处理失败时返回 `wm_status_code: 500` 和字符串 `wm_failure`：前者使 X 收到投递
失败，后者让 Windmill 将 Job 记录为失败。同步路由默认会把抛错结果用 HTTP 200
返回，因此不能仅依靠异常传播。无效签名不会提交任何通知；不做静默降级。
X 请求必须在其 10 秒回调时限内完成入队，仍需在部署后的实例验证排队延迟。

回调成功表示通知 Job 已入队，不表示 Telegram 已送达。Telegram 投递失败会留下
Windmill 失败 Flow Job，可在后台重跑。X 重投、分段入队部分成功后失败、或手动重跑，
都可能产生重复消息。

本地验证：

```bash
node --test test/x-webhook.test.ts
npm test
npm run check
```

测试替换 Windmill Resource 读取和 Job 入队，不会访问 X 或向真实 Telegram 群发消息。

接口依据：[X Webhook 验证与签名](https://docs.x.com/x-api/webhooks/quickstart)、
[X Activity 消息格式](https://docs.x.com/x-api/activity/event-payloads)。
HTTP 失败契约见 [Windmill 同步响应与 wm_failure](https://www.windmill.dev/docs/core_concepts/webhooks#asynchronous-vs-synchronous)。
