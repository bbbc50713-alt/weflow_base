# AI 自动回复发送器配置说明

AI 自动回复现在支持发送器抽象层。默认仍使用 Windows UI 自动化发送器，以保证旧行为不变；如果需要更无感的发送体验，可以通过环境变量切换到 WeClaw HTTP 发送器。

## 发送器类型

| 发送器 | ID | 自动投递 | 是否无感 | 状态 |
| --- | --- | --- | --- | --- |
| 手动模式 | `manual` | 否 | 是 | 可用兜底 |
| Windows UI 自动化 | `ui-automation` | 是 | 否，会激活微信窗口 | 默认可用 |
| WeClaw HTTP | `weclaw-http` | 是 | 是 | 可通过外部服务启用 |
| WeChatFerry | `wechatferry` | 是 | 是 | 预留实验入口，暂未内置 |

## 默认行为

不设置任何环境变量时，AI 自动回复仍使用 `ui-automation`：

```text
SSE 收到新消息 -> AI 生成回复 -> SenderManager -> UIAutomationSender -> Windows 微信窗口发送
```

这个路径会保留此前的可用性，但发送时会短暂激活微信窗口。

## 启用 WeClaw HTTP

先启动 WeClaw 外部服务，并确认它提供发送接口：

```text
POST /api/send
```

然后设置环境变量：

```powershell
$env:WEFLOW_AI_REPLY_SENDER = "weclaw-http"
$env:WEFLOW_WECLAW_BASE_URL = "http://127.0.0.1:19888"
$env:WEFLOW_WECLAW_TOKEN = ""
npm run dev
```

发送 payload 格式：

```json
{
  "to": "contactId-or-contactName",
  "text": "AI generated reply",
  "type": "text",
  "isGroup": false
}
```

当前版本会优先使用 WeFlow 的 `contactId` 作为 WeClaw 发送目标，缺失时回退到 `contactName`。如果外部服务需要专有 user id，需要后续在 UI 中补联系人映射。

## 失败降级

默认 fallback sender 是 `manual`。当主发送器失败时，系统不会误判为已发送，而是保留生成结果并记录发送失败原因。

## 后续待接 UI

后续需要在 AI 自动回复设置页补充：

- 当前发送器选择。
- WeClaw base URL / token。
- 健康检查按钮。
- 发送测试消息按钮。
- 联系人映射管理。
- WeChatFerry 风险确认开关。
