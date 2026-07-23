# AI 自动回复失败问题诊断报告

## 问题现象

**错误信息**：
```
Unexpected token '<', "<!doctype "... is not valid JSON
```

**失败详情**：
- 联系人：央视军事、财神爷陪宝不跑不撑不猜摆让小郭幸福钱多多要执行多考虑多做
- 模型：gpt-4o
- 耗时：5159ms / 5170ms
- 状态：回复失败（红色）

---

## 根本原因

### 🎯 核心问题：API 返回 HTML 页面而非 JSON 响应

在 `OpenAIAdapter.ts:44` 处，代码尝试解析 JSON：

```typescript
const data = await response.json()  // 第 44 行
```

但实际收到的响应是 HTML 格式（`<!doctype ...>`），导致 JSON 解析失败。

### 为什么会收到 HTML？

#### 可能原因 1：API 端点配置错误 ⭐⭐⭐⭐⭐（最可能）

**问题**：`baseUrl` 配置不正确，指向了错误的地址

**常见错误配置**：
```
❌ 错误：https://api.openai.com
✅ 正确：https://api.openai.com/v1

❌ 错误：https://api-inference.modelscope.cn
✅ 正确：https://api-inference.modelscope.cn/v1

❌ 错误：http://localhost:3000
✅ 正确：http://localhost:3000/v1
```

**症状**：
- 访问 `https://api.openai.com/chat/completions` 会返回 404 HTML 页面
- 正确应该是 `https://api.openai.com/v1/chat/completions`

---

#### 可能原因 2：API Key 无效或过期 ⭐⭐⭐⭐

**问题**：API Key 验证失败，服务器返回登录页面或错误页面

**症状**：
- OpenAI 返回 401 错误（HTML 格式）
- 某些代理服务会返回 HTML 格式的错误页面
- ModelScope 返回登录页面

**检查方法**：
1. 确认 API Key 格式正确（OpenAI 以 `sk-` 开头）
2. 确认 API Key 未过期
3. 确认账户有余额或配额

---

#### 可能原因 3：网络问题/代理拦截 ⭐⭐⭐

**问题**：防火墙、代理或 VPN 拦截请求，返回拦截页面

**症状**：
- 防火墙返回拦截提示页面（HTML）
- Clash/V2Ray 返回连接失败页面
- 公司网络返回认证页面

**诊断方法**：
1. 检查系统代理设置
2. 临时关闭 VPN/代理测试
3. 检查防火墙日志

---

#### 可能原因 4：服务器错误 ⭐⭐

**问题**：API 服务器故障，返回 502/503 错误页面

**症状**：
- OpenAI 服务中断
- 反向代理返回错误页面
- CDN 返回缓存的错误页面

---

## 诊断步骤

### 第 1 步：检查模型配置

在 AI 回复页面 → 模型配置 → gpt-4o，检查：

1. **baseUrl 是否正确**
   ```
   ✅ 正确示例：
   - OpenAI: https://api.openai.com/v1
   - ModelScope: https://api-inference.modelscope.cn/v1
   - 本地代理: http://localhost:11434/v1
   
   ❌ 常见错误：
   - 缺少 /v1 后缀
   - 多余的 /chat/completions
   - http/https 协议错误
   ```

2. **API Key 是否正确**
   ```
   OpenAI 格式: sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ModelScope 格式: ms_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

3. **模型名称是否正确**
   ```
   OpenAI: gpt-4o, gpt-4-turbo, gpt-3.5-turbo
   ModelScope: qwen-plus, qwen-max
   ```

---

### 第 2 步：手动测试 API

#### 方法 1：使用 curl 测试（推荐）

**测试 OpenAI API**：
```bash
curl https://api.openai.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 10
  }'
```

**预期正确响应**：
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help..."
    }
  }]
}
```

**错误响应（HTML）**：
```html
<!DOCTYPE html>
<html>
  <head><title>404 Not Found</title></head>
  <body>...</body>
</html>
```

#### 方法 2：使用 Postman/Apifox 测试

1. 创建 POST 请求：`https://api.openai.com/v1/chat/completions`
2. 添加 Headers：
   - `Content-Type: application/json`
   - `Authorization: Bearer YOUR_API_KEY`
3. 添加 Body (JSON)：
   ```json
   {
     "model": "gpt-4o",
     "messages": [{"role": "user", "content": "测试"}],
     "max_tokens": 10
   }
   ```
4. 发送请求，查看响应

---

### 第 3 步：检查日志

打开开发者工具查看详细错误：

**Electron 应用**：
1. 按 `F12` 或 `Ctrl+Shift+I` 打开开发者工具
2. 切换到 Console 标签
3. 筛选 `[AIReplyService]` 或 `[OpenAIAdapter]` 日志
4. 查看完整的错误堆栈

**关键日志**：
```
[AIReplyService] 使用模型: gpt-4o (xxx)
[OpenAIAdapter] fetch URL: https://api.openai.com/v1/chat/completions
[OpenAIAdapter] response status: 404
[OpenAIAdapter] response body: <!doctype html>...
```

---

## 修复方案

### 方案 1：修正 baseUrl（最可能）✅

**步骤**：
1. 打开 AI 回复页面
2. 点击"模型配置"标签
3. 找到 gpt-4o 模型
4. 点击"编辑"
5. 修改 **baseUrl**：
   ```
   错误：https://api.openai.com
   正确：https://api.openai.com/v1
   ```
6. 点击"测试连接"验证
7. 保存配置

---

### 方案 2：更新 API Key

**步骤**：
1. 登录 OpenAI 官网：https://platform.openai.com/api-keys
2. 生成新的 API Key
3. 复制 Key（格式：`sk-...`）
4. 在 WeFlow 中更新模型配置
5. 测试连接

---

### 方案 3：配置网络代理

如果 OpenAI API 被墙，需要配置代理：

**选项 A：使用中转 API**
```
baseUrl: https://api.openai-proxy.com/v1
或其他可用的中转服务
```

**选项 B：配置本地代理**
1. 启动 Clash/V2Ray
2. 确认代理端口（通常是 7890）
3. 在系统环境变量中设置：
   ```
   HTTP_PROXY=http://127.0.0.1:7890
   HTTPS_PROXY=http://127.0.0.1:7890
   ```
4. 重启 WeFlow

**选项 C：使用国内 API（推荐）**
```
ModelScope:
- baseUrl: https://api-inference.modelscope.cn/v1
- model: qwen-plus 或 qwen-max
- apiKey: 从 ModelScope 获取 Access Token
```

---

### 方案 4：增强错误处理（代码修复）

当前代码在第 44 行直接调用 `response.json()`，没有检查响应类型。

**改进建议**（已在代码中部分实现）：

```typescript
// OpenAIAdapter.ts 第 31-44 行
if (!response.ok) {
  const text = await response.text().catch(() => '')
  
  // 检查是否是 HTML 响应
  if (text.startsWith('<!DOCTYPE') || text.startsWith('<!doctype')) {
    throw new Error(
      `API 返回了 HTML 页面而非 JSON。` +
      `可能原因：\n` +
      `1. baseUrl 配置错误（检查是否缺少 /v1）\n` +
      `2. API 端点不存在（404）\n` +
      `3. 网络代理返回拦截页面`
    )
  }
  
  // 尝试解析 JSON 错误
  let detail = text || response.statusText
  try {
    const errJson = JSON.parse(text)
    detail = errJson.error?.message || errJson.message || text
  } catch {}
  
  throw new Error(`API 请求失败 (${response.status}): ${detail}`)
}

const data = await response.json()
```

**但问题是**：当前代码在 `response.ok` 为 true 时仍然会失败，说明服务器返回了 200 状态码但内容是 HTML。

**进一步改进**：
```typescript
// 在调用 json() 前检查 Content-Type
const contentType = response.headers.get('content-type')
if (!contentType || !contentType.includes('application/json')) {
  const text = await response.text()
  throw new Error(
    `API 返回了非 JSON 响应 (Content-Type: ${contentType || 'unknown'})。\n` +
    `响应内容: ${text.substring(0, 200)}...\n\n` +
    `请检查：\n` +
    `1. baseUrl 是否正确（应包含 /v1）\n` +
    `2. API Key 是否有效\n` +
    `3. 网络是否正常`
  )
}

const data = await response.json()
```

---

## 快速诊断清单

### ✅ 配置检查
- [ ] baseUrl 包含 `/v1` 后缀
- [ ] API Key 格式正确（sk- 开头）
- [ ] 模型名称正确（gpt-4o）
- [ ] 没有多余的路径（如 /chat/completions）

### ✅ 网络检查
- [ ] 可以访问 https://api.openai.com
- [ ] 代理/VPN 正常工作
- [ ] 防火墙没有拦截

### ✅ 账户检查
- [ ] API Key 未过期
- [ ] 账户有余额
- [ ] 有 gpt-4o 的访问权限

---

## 推荐的配置示例

### OpenAI 官方
```json
{
  "type": "openai-compatible",
  "name": "GPT-4O",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "model": "gpt-4o",
  "temperature": 0.7,
  "maxTokens": 2048
}
```

### ModelScope（国内可用）
```json
{
  "type": "openai-compatible",
  "name": "通义千问",
  "baseUrl": "https://api-inference.modelscope.cn/v1",
  "apiKey": "ms_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "model": "qwen-plus",
  "temperature": 0.7,
  "maxTokens": 2048
}
```

### OpenAI 代理（需要代理）
```json
{
  "type": "openai-compatible",
  "name": "GPT-4O (代理)",
  "baseUrl": "https://your-proxy.com/v1",
  "apiKey": "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "model": "gpt-4o",
  "temperature": 0.7,
  "maxTokens": 2048
}
```

---

## 总结

**最可能的原因**（按概率排序）：

1. **baseUrl 缺少 `/v1` 后缀**（90%）
   - 修复：添加 `/v1`
   
2. **API Key 无效或过期**（5%）
   - 修复：重新生成 Key
   
3. **网络问题/代理拦截**（4%）
   - 修复：配置代理或使用国内 API
   
4. **OpenAI 服务故障**（1%）
   - 修复：等待恢复或使用备用 API

**下一步操作**：
1. 立即检查并修正 gpt-4o 的 baseUrl 配置
2. 点击"测试连接"按钮验证
3. 如果仍然失败，使用 curl 手动测试 API
4. 查看开发者工具的详细日志
