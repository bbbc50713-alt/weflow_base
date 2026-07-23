# AI 自动回复无感发送能力开发计划书

## 1. 背景

当前项目基于 WeFlow 二次开发，新增了 AI 自动回复和聊天记录蒸馏 Skill 两条能力。原 WeFlow 的核心能力偏向微信聊天记录读取、分析、导出和本地 HTTP/SSE 消息推送，不提供稳定的个人微信消息发送 API。因此，AI 自动回复链路在“生成回复”之后，需要独立补齐真实发送能力。

当前已补入的 Windows UI 自动化发送器可以作为第一版可用方案，但它需要激活微信窗口，会打断用户当前操作，不属于完全无感发送。为提升产品体验，后续需要抽象发送器架构，并逐步接入无感或低打扰发送后端。

参考项目：

- WeFlow: https://github.com/hicccc77/WeFlow
- wx-automatic-reply: https://github.com/hdjshebhdhvfb/wx-automatic-reply
- WeChatFerry: https://github.com/lich0821/WeChatFerry
- wechatferry: https://github.com/wechatferry/wechatferry
- WeClaw: https://github.com/fastclaw-ai/weclaw
- yourself-skill: https://github.com/notdog1998/yourself-skill

## 2. 项目目标

本计划的目标是把 AI 自动回复发送链路从单一实现升级为多发送器架构，使项目可以根据用户环境选择不同发送方式。

核心目标：

- 保留并稳定当前 Windows UI 自动化发送器，作为默认兜底方案。
- 增加发送器抽象层，让 AIReplyService 不直接依赖某一种发送实现。
- 优先支持 `weclaw-http` 外部服务路线，实现低侵入的无感发送。
- 评估并预留 `wechatferry` Hook 路线，实现更贴近 PC 微信客户端的无感发送。
- 增加发送前检测、失败原因日志、手动降级和安全提示。
- 不修改原 WeFlow 的读取、分析、导出、数据库解密等稳定功能。

非目标：

- 不实现微信协议破解或自研 Hook。
- 不绕过微信安全机制。
- 不默认启用高风险 Hook 发送能力。
- 不把企业微信 webhook 当作个人微信聊天发送方案。

## 3. 总体方案

新增 `SenderProvider` / `SenderManager` 抽象层，AI 自动回复服务只负责生成回复和选择发送器，不直接关心底层是窗口自动化、外部 HTTP 服务还是 Hook SDK。

推荐发送器优先级：

1. `manual`：只生成回复，不自动发送，作为安全兜底。
2. `ui-automation`：当前 Windows 桌面自动化路线，默认可用。
3. `weclaw-http`：外部后台服务路线，优先开发为无感发送方案。
4. `wechatferry`：PC 微信 Hook 路线，作为高级实验/可选能力。

建议架构：

```text
SSE 新消息
  -> AIReplyService
  -> TriggerEngine
  -> ContextManager
  -> SkillEngine
  -> ModelAdapter
  -> markdownToPlainText
  -> SenderManager
  -> selected MessageSender
  -> ReplyLog / MessageFlowUpdate
```

## 4. 发送器接口设计

新增核心接口，建议放在 `electron/services/ai-reply/senders/types.ts`。

```ts
export type SenderId = 'manual' | 'ui-automation' | 'weclaw-http' | 'wechatferry'

export interface SendTextRequest {
  contactId: string
  contactName: string
  text: string
  isGroup?: boolean
  rawMessage?: unknown
  traceId?: string
}

export interface SendTextResult {
  success: boolean
  senderId: SenderId
  error?: string
  detail?: string
  steps?: Array<{
    name: string
    status: 'ok' | 'warning' | 'error'
    detail?: string
  }>
}

export interface SenderHealth {
  available: boolean
  reason?: string
  version?: string
  capabilities: {
    text: boolean
    image: boolean
    file: boolean
    groupMention: boolean
    silent: boolean
  }
}

export interface MessageSender {
  id: SenderId
  displayName: string
  riskLevel: 'low' | 'medium' | 'high'
  getHealth(): Promise<SenderHealth>
  sendText(request: SendTextRequest): Promise<SendTextResult>
}
```

## 5. 模块拆分

建议新增目录：

```text
electron/services/ai-reply/senders/
  types.ts
  SenderManager.ts
  ManualSender.ts
  UIAutomationSender.ts
  WeClawHttpSender.ts
  WeChatFerrySender.ts
  contactResolver.ts
```

现有 `core/WeChatSender.ts` 后续可迁移为：

```text
electron/services/ai-reply/senders/UIAutomationSender.ts
```

短期可以先保留现有路径，新增 `SenderManager` 适配它，降低改动风险。

## 6. 分阶段开发计划

### 阶段 0：基线梳理与风险隔离

目标：

- 梳理当前 AI 自动回复链路中所有发送调用点。
- 确认 `AIReplyService` 是否只通过 `WeChatSender.sendTextMessage` 发送。
- 确认 UI 配置中“启用自动发送”和“启用 AI 自动回复”是否区分清楚。

任务：

- 阅读 `electron/services/ai-reply/AIReplyService.ts`。
- 阅读 `electron/services/ai-reply/core/WeChatSender.ts`。
- 阅读 `src/pages/AIReplyPage.tsx` 和 `src/stores/aiReplyStore.ts`。
- 记录当前回复生成成功但发送失败时的日志流。

验收标准：

- 输出一份调用链说明。
- 明确发送失败日志会显示在哪个 UI 区域。
- 明确是否有“只生成不发送”的开关。

### 阶段 1：发送器抽象层

目标：

- 引入 `MessageSender` 接口和 `SenderManager`。
- 让 `AIReplyService` 从直接调用 `WeChatSender` 改为调用 `SenderManager.sendText`。
- 保持当前 Windows UI 自动化发送行为不变。

任务：

- 新增 `senders/types.ts`。
- 新增 `senders/SenderManager.ts`。
- 用适配器包装现有 `WeChatSender`。
- 增加 `manual` 发送器：记录“已生成，未发送”，不触碰微信。

验收标准：

- 现有自动回复仍能走 UI 自动化发送。
- 选择 `manual` 时不会发送到微信，但日志记录生成结果。
- 发送失败时日志包含 `senderId`、错误信息和步骤详情。

### 阶段 2：UI 自动化发送器增强

目标：

- 稳定当前 Windows 发送器，作为默认兜底。
- 降低因窗口焦点、剪贴板、联系人搜索失败导致的误判。

任务：

- 增加微信进程探测：`WeChat`、`Weixin`、窗口标题包含 `微信`。
- 增加发送前健康检查：微信是否已登录、是否有主窗口、PowerShell 是否可用。
- 增加消息发送 dry-run 测试入口。
- 增加发送步骤日志展示。

验收标准：

- 微信未启动时返回明确错误。
- 微信最小化或在后台时能尝试恢复窗口。
- 失败日志能定位到激活窗口、搜索联系人、聚焦输入框、粘贴、发送中的具体一步。

### 阶段 3：接入 WeClaw HTTP 发送器

目标：

- 支持外部 `weclaw` 后台服务作为无感发送后端。
- Electron 只调用本地 HTTP API，不直接操作微信窗口。

任务：

- 新增 `WeClawHttpSender`。
- 增加配置项：`baseUrl`、`token`、`timeoutMs`、联系人映射策略。
- 实现健康检查：请求 `/health` 或等效接口。
- 实现文本发送：调用 `POST /api/send` 或项目实际暴露的发送接口。
- 实现联系人映射：WeFlow 的 `contactId/contactName` 到 WeClaw 的 `to/user_id`。
- UI 增加发送器配置卡片。

关键风险：

- WeFlow 读取到的联系人 ID 未必等于 WeClaw 发送 API 需要的 ID。
- 可能需要用户先在 WeClaw 中扫码登录，且保持会话在线。

验收标准：

- 用户启动 WeClaw 服务后，可在设置页检测连接。
- 能向指定联系人发送测试文本。
- AI 自动回复可通过 WeClaw 发送，不抢占微信窗口。
- 联系人映射失败时能提示用户手动绑定。

### 阶段 4：接入 WeChatFerry 可选发送器

目标：

- 支持 WeChatFerry 作为高级无感发送后端。
- 明确标记为高风险、实验性、用户主动启用。

任务：

- 新增 `WeChatFerrySender`。
- 支持配置本地服务地址或 SDK 路径。
- 实现健康检查：服务是否运行、微信版本是否兼容、是否已登录。
- 实现 `sendText`，优先通过本地 RPC/HTTP 服务调用，不在 Electron 内直接注入 DLL。
- 增加风险提示和启用确认。

关键风险：

- Hook 类方案依赖微信版本，更新后可能失效。
- 可能触发微信风控。
- 打包分发时不建议默认内置 Hook 组件。

验收标准：

- 未启用时不会加载或调用 WeChatFerry。
- 启用前必须展示风险提示。
- 健康检查失败时不会影响其他发送器。
- 发送失败可自动降级到 `manual` 或 `ui-automation`。

### 阶段 5：联系人映射与群聊支持

目标：

- 解决不同发送后端联系人 ID 不一致的问题。
- 支持好友、群聊和手动绑定。

任务：

- 新增 `contactResolver.ts`。
- 维护映射表：`weflowContactId -> senderSpecificId`。
- UI 中增加“发送目标绑定”能力。
- 群聊发送不默认 `@群名`。
- 如需群内 @ 某人，后续单独支持 sender/member 映射。

验收标准：

- 同一个联系人可分别绑定 WeClaw / WeChatFerry 发送 ID。
- 映射缺失时不会误发给搜索结果第一项。
- 群聊自动回复能发送纯文本。

### 阶段 6：观测、测试与降级

目标：

- 让自动回复链路可诊断、可回滚、可降级。

任务：

- ReplyLog 增加 `senderId`、`sendStatus`、`sendSteps`、`sendLatencyMs`。
- MessageFlowUpdate 增加 `senderId`。
- 增加“发送器测试”按钮。
- 增加“失败后降级策略”：不降级、降级 manual、降级 ui-automation。
- 增加模拟发送器用于测试。

验收标准：

- 能在 UI 看到每条回复使用了哪个发送器。
- 能区分“AI 生成失败”和“微信发送失败”。
- 自动发送失败不会导致 SSE 监听中断。

### 阶段 7：文档、打包与用户指引

目标：

- 让用户知道不同发送器的能力、风险和配置方式。

任务：

- 编写 `docs/ai-reply-senders.md`。
- 编写 WeClaw 接入说明。
- 编写 WeChatFerry 风险说明。
- 编写常见故障排查：微信未登录、联系人搜不到、剪贴板被占用、外部服务离线。

验收标准：

- 用户能按文档完成至少一种自动发送配置。
- 高风险方案有显式提示。
- 默认安装不会启用 Hook 类能力。

## 7. 推荐实施顺序

第一优先级：

- `SenderManager` 抽象。
- `manual` 发送器。
- 现有 UI 自动化发送器适配。
- 发送日志增强。

第二优先级：

- `weclaw-http` 发送器。
- 联系人映射 UI。
- 外部服务健康检查。

第三优先级：

- `wechatferry` 实验发送器。
- 版本兼容检测。
- 风险提示和降级策略。

## 8. 配置设计

建议新增 AI 回复发送配置：

```ts
export interface AIReplySenderConfig {
  activeSenderId: SenderId
  fallbackSenderId?: SenderId
  manualConfirmBeforeSend: boolean
  uiAutomation: {
    enabled: boolean
    restoreClipboard: boolean
    sendHotkey: 'enter' | 'ctrl-enter'
  }
  weclawHttp: {
    enabled: boolean
    baseUrl: string
    token?: string
    timeoutMs: number
  }
  wechatferry: {
    enabled: boolean
    endpoint?: string
    warningAcceptedAt?: number
  }
}
```

## 9. 测试计划

单元测试：

- `SenderManager` 选择发送器。
- fallback 策略。
- 发送结果日志格式。
- 联系人映射解析。

集成测试：

- `manual` 发送器不触碰微信。
- UI 自动化发送器在微信未启动时返回明确错误。
- WeClaw 服务不可用时返回明确错误。
- WeClaw 服务可用时能发送测试消息。

人工验收：

- 私聊自动回复。
- 群聊自动回复。
- AI 生成成功但发送失败。
- 发送器切换。
- 外部服务断线重连。

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 微信没有官方个人号发送 API | 无法完全稳定无感发送 | 多发送器架构，默认低风险方案 |
| UI 自动化抢窗口 | 用户体验差 | 作为兜底，不作为唯一方案 |
| WeClaw 联系人 ID 不匹配 | 可能发错人或发不出 | 增加手动绑定和发送前确认 |
| WeChatFerry Hook 风险 | 账号/兼容/合规风险 | 默认禁用，风险提示，外部服务化 |
| 微信版本升级 | Hook 或 UI 定位失效 | 健康检查、版本提示、fallback |
| 自动回复误触发 | 误发消息 | 触发规则、联系人白名单、手动确认模式 |

## 11. 里程碑

| 里程碑 | 内容 | 预估 |
| --- | --- | --- |
| M1 | SenderManager + manual + UI 自动化适配 | 1-2 天 |
| M2 | 发送日志和 UI 配置 | 1-2 天 |
| M3 | WeClaw HTTP 发送器 | 2-4 天 |
| M4 | 联系人映射与群聊测试 | 2-3 天 |
| M5 | WeChatFerry 实验适配 | 3-5 天 |
| M6 | 文档、降级策略、稳定性测试 | 2-3 天 |

## 12. 最小可交付版本

最小可交付版本不追求一次性支持所有无感发送路线，建议范围如下：

- `SenderManager` 抽象完成。
- `manual` 和 `ui-automation` 两个发送器可切换。
- AI 自动回复日志能显示发送器、状态和错误。
- 配置页能选择发送器。
- WeClaw HTTP 发送器完成健康检查和测试发送。

达到这个版本后，项目就具备继续接入 WeChatFerry 或其他发送后端的基础，不需要再次改动 AI 回复主链路。
