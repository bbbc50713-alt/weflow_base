# API 测试结果报告

## 测试的 API 端点
- **Base URL**: `https://api.cpu.moe`
- **API Key**: `sk-d5cba018eaee9d8a24b00ea69f1603d2bf13f2e7d0b3e145ab2665f2ac1fba35`
- **模型**: `gpt-4o`

---

## 测试结果

### ✅ 测试 1: 带 `/v1` 路径

**请求**:
```bash
POST https://api.cpu.moe/v1/chat/completions
```

**响应**:
```json
{
  "error": {
    "message": "Service temporarily unavailable",
    "type": "api_error"
  }
}
```

**状态**: ⚠️ API 端点正确，但服务暂时不可用

**分析**:
- ✅ API 端点格式正确（返回 JSON 而非 HTML）
- ✅ 请求被正确路由到 API 服务
- ❌ 后端服务暂时不可用（可能是负载过高、维护或其他问题）

---

### ❌ 测试 2: 不带 `/v1` 路径

**请求**:
```bash
POST https://api.cpu.moe/chat/completions
```

**响应**:
```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    ...
```

**状态**: ❌ 返回 HTML 页面（网站首页）

**分析**:
- ❌ 这就是你遇到的错误！
- 访问 `https://api.cpu.moe/chat/completions` 返回了网站的 HTML 首页
- 这正是导致 `Unexpected token '<', "<!doctype "... is not valid JSON` 错误的原因

---

### ✅ 测试 3: 基础 URL 检查

**请求**:
```bash
GET https://api.cpu.moe
```

**响应**:
```
HTTP/2 200
content-type: text/html; charset=utf-8
```

**分析**:
- 这是一个 Web 服务器，根路径返回 HTML 页面
- API 接口需要访问 `/v1/` 路径

---

## 问题确认

### 🎯 根本原因

你的 WeFlow 配置中 **baseUrl 缺少 `/v1` 后缀**，导致：

```
错误配置: https://api.cpu.moe
           ↓
实际请求: https://api.cpu.moe/chat/completions  ❌ 返回 HTML 首页
           ↓
JSON 解析失败: Unexpected token '<', "<!doctype "...
```

**正确配置**:
```
正确配置: https://api.cpu.moe/v1
           ↓
实际请求: https://api.cpu.moe/v1/chat/completions  ✅ 返回 JSON API 响应
```

---

## 修复步骤

### 1️⃣ 更新 WeFlow 配置

1. 打开 WeFlow → **AI 回复** → **模型配置**
2. 找到 `gpt-4o` 模型
3. 编辑 **baseUrl**：
   ```
   从: https://api.cpu.moe
   改为: https://api.cpu.moe/v1
   ```
4. 保存配置

---

### 2️⃣ 等待服务恢复或更换 API

**当前问题**: 即使修正了配置，API 返回了 "Service temporarily unavailable" 错误。

**可能原因**:
- API 服务暂时不可用
- 服务器负载过高
- 正在维护
- API Key 配额用尽或限流

**解决方案**:

#### 选项 A: 等待服务恢复
- 稍后（几分钟到几小时）重试
- 联系 API 提供商确认状态

#### 选项 B: 检查 API Key 状态
- 登录 https://api.cpu.moe 检查：
  - API Key 是否有效
  - 账户余额
  - 使用配额
  - 调用频率限制

#### 选项 C: 使用备用 API（推荐）

**国内可用的替代方案**:

1. **ModelScope（推荐）**
   ```
   baseUrl: https://api-inference.modelscope.cn/v1
   model: qwen-plus 或 qwen-max
   apiKey: 需要在 ModelScope 注册并获取 Access Token
   ```
   - 免费额度
   - 国内访问快
   - 模型性能接近 GPT-4

2. **阿里云通义千问**
   ```
   baseUrl: https://dashscope.aliyuncs.com/compatible-mode/v1
   model: qwen-plus
   apiKey: 需要在阿里云获取 API Key
   ```

3. **智谱 AI (ChatGLM)**
   ```
   baseUrl: https://open.bigmodel.cn/api/paas/v4
   model: glm-4
   apiKey: 需要在智谱 AI 注册
   ```

---

## 测试验证

### 修正后的 curl 测试

```bash
# 正确的测试命令
curl -X POST "https://api.cpu.moe/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-d5cba018eaee9d8a24b00ea69f1603d2bf13f2e7d0b3e145ab2665f2ac1fba35" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 10
  }'
```

**预期响应（服务恢复后）**:
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "model": "gpt-4o",
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help you today?"
    },
    "finish_reason": "length"
  }],
  "usage": {
    "prompt_tokens": 8,
    "completion_tokens": 10,
    "total_tokens": 18
  }
}
```

---

## 总结

### ✅ 问题确认
- **你的错误是由于 baseUrl 缺少 `/v1` 导致的**
- 访问错误的端点返回 HTML 页面，导致 JSON 解析失败

### ⚠️ 当前状态
- 正确的端点 `https://api.cpu.moe/v1/chat/completions` 存在
- 但服务返回 "Service temporarily unavailable"
- 需要等待服务恢复或联系提供商

### 🛠️ 立即行动
1. **修正 baseUrl**: 添加 `/v1` 后缀
2. **测试连接**: 使用 WeFlow 的"测试连接"功能
3. **等待恢复**: 如果仍显示不可用，稍后重试
4. **考虑备用**: 配置 ModelScope 作为备用 API

### 📊 推荐配置

```json
{
  "type": "openai-compatible",
  "name": "GPT-4O (CPU.moe)",
  "baseUrl": "https://api.cpu.moe/v1",
  "apiKey": "sk-d5cba018eaee9d8a24b00ea69f1603d2bf13f2e7d0b3e145ab2665f2ac1fba35",
  "model": "gpt-4o",
  "temperature": 0.7,
  "maxTokens": 2048
}
```

**备用配置（ModelScope）**:
```json
{
  "type": "openai-compatible",
  "name": "通义千问",
  "baseUrl": "https://api-inference.modelscope.cn/v1",
  "apiKey": "YOUR_MODELSCOPE_TOKEN",
  "model": "qwen-plus",
  "temperature": 0.7,
  "maxTokens": 2048
}
```
