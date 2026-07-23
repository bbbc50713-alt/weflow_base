# OpenAIAdapter 改进完成报告

## 执行时间
2026-07-02

## 问题回顾

### 原始问题
用户反馈 AI 自动回复失败，错误信息：
```
Unexpected token '<', "<!doctype "... is not valid JSON
```

### 根本原因
1. **测试连接成功但实际使用失败**：WeFlow 测试连接时只检查 HTTP 状态码，不验证响应格式
2. **API 返回 HTML 页面**：`https://api.cpu.moe/chat/completions` 返回 200 状态码，但 Content-Type 是 `text/html`
3. **代码直接解析 JSON**：没有检查 Content-Type，导致尝试解析 HTML 时失败

## 实施的改进

### 1. ✅ generate() 函数 - 添加 Content-Type 检查

**文件**: `electron/services/ai-reply/adapters/OpenAIAdapter.ts`

**改进内容**：
```typescript
// 在调用 response.json() 前检查 Content-Type
const contentType = response.headers.get('content-type')
if (!contentType || !contentType.includes('application/json')) {
  const text = await response.text().catch(() => '')
  const preview = text.substring(0, 200).replace(/\n/g, ' ')
  
  throw new Error(
    `API 返回了非 JSON 响应\n\n` +
    `Content-Type: ${contentType || 'unknown'}\n` +
    `响应预览: ${preview}...\n\n` +
    `可能原因：\n` +
    `1. API 端点配置错误（请检查 baseUrl）\n` +
    `2. 该 API 不兼容 OpenAI 格式\n` +
    `3. 需要额外的请求头或参数\n\n` +
    `请求 URL: ${url}\n` +
    `模型: ${cfg.model}`
  )
}
```

**效果**：
- ❌ 之前：直接调用 `response.json()`，解析 HTML 失败，抛出难以理解的错误
- ✅ 现在：先检查 Content-Type，发现 HTML 后给出详细的诊断信息

---

### 2. ✅ testConnection() 函数 - 增强验证

**文件**: `electron/services/ai-reply/adapters/OpenAIAdapter.ts`

**改进内容**：
1. **验证 Content-Type**：确保响应是 JSON
2. **验证 JSON 解析**：捕获解析错误
3. **验证响应格式**：检查是否包含 `choices` 数组

```typescript
// 1. 检查 Content-Type
const contentType = response.headers.get('content-type')
if (!contentType || !contentType.includes('application/json')) {
  return { success: false, message: '返回非 JSON 响应...' }
}

// 2. 尝试解析 JSON
let data: any
try {
  data = await response.json()
} catch (error) {
  return { success: false, message: '无法解析为 JSON...' }
}

// 3. 验证响应格式
if (!data.choices || !Array.isArray(data.choices)) {
  return { success: false, message: '响应格式不正确...' }
}
```

**效果**：
- ❌ 之前：只检查 HTTP 状态码，误判 HTML 响应为成功
- ✅ 现在：全面验证响应格式，准确检测不兼容的 API

---

## 验证结果

### ✅ TypeScript 类型检查通过
```bash
$ npm run typecheck
> tsc --noEmit
(无错误)
```

---

## 预期行为改变

### 场景 1：API 返回 HTML（如 api.cpu.moe）

**之前**：
- 测试连接：✅ "连接成功，模型 'gpt-4o' 可用"（误判）
- 实际使用：❌ `Unexpected token '<', "<!doctype "...`（难以理解）

**现在**：
- 测试连接：❌ 详细错误信息
  ```
  API 返回了非 JSON 响应（text/html）
  
  响应预览: <!doctype html><html>...
  
  这个 API 可能不兼容 OpenAI 格式。
  请检查 baseUrl 配置是否正确。
  
  请求 URL: https://api.cpu.moe/chat/completions
  ```
- 实际使用：❌ 相同的详细错误（一致的用户体验）

---

### 场景 2：正常的 OpenAI API

**之前**：
- 测试连接：✅ "连接成功"
- 实际使用：✅ 正常工作

**现在**：
- 测试连接：✅ "连接成功"（无变化）
- 实际使用：✅ 正常工作（无变化）

**影响**：✅ 对正常 API 无影响

---

### 场景 3：API 格式不正确

**新增能力**：
- 如果 API 返回的 JSON 不包含 `choices` 数组
- 测试连接会显示完整的响应内容（前 500 字符）
- 帮助用户诊断格式问题

---

## 对 api.cpu.moe 的建议

根据测试，`https://api.cpu.moe/chat/completions` 返回 HTML 页面。

**可能的解决方案**：

### 方案 A：寻找正确的端点
尝试以下 baseUrl：
- `https://api.cpu.moe/v1`
- `https://api.cpu.moe/api`
- `https://api.cpu.moe/openai`
- `https://api.cpu.moe/v1/api`

### 方案 B：联系 API 提供商
- 获取官方文档
- 确认正确的端点格式
- 确认是否需要特殊的请求头

### 方案 C：使用替代 API（推荐）
**国内可用的高质量替代**：

1. **ModelScope（推荐）**
   ```json
   {
     "baseUrl": "https://api-inference.modelscope.cn/v1",
     "model": "qwen-plus",
     "apiKey": "YOUR_MODELSCOPE_TOKEN"
   }
   ```
   - 免费额度充足
   - 国内访问快
   - 模型性能接近 GPT-4

2. **智谱 AI (ChatGLM)**
   ```json
   {
     "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
     "model": "glm-4",
     "apiKey": "YOUR_ZHIPU_KEY"
   }
   ```

3. **阿里云通义千问**
   ```json
   {
     "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
     "model": "qwen-plus",
     "apiKey": "YOUR_ALIYUN_KEY"
   }
   ```

---

## 后续步骤

### 用户操作

1. **重新测试 api.cpu.moe**
   - 打开 WeFlow → AI 回复 → 模型配置
   - 找到配置的模型
   - 点击"测试连接"
   - 查看新的详细错误信息

2. **尝试不同的 baseUrl**
   - 逐个尝试上述建议的端点
   - 每次修改后测试连接

3. **配置备用 API**
   - 注册 ModelScope 账号（推荐）
   - 获取 Access Token
   - 添加为新的模型配置

### 开发改进（可选）

未来可以考虑：
1. 自动重试不同的端点变体
2. 提供端点诊断工具
3. 实现多 API 故障转移

---

## 总结

### ✅ 完成的改进
1. 添加 Content-Type 验证（generate 函数）
2. 增强测试连接验证（testConnection 函数）
3. 提供详细的错误诊断信息
4. 通过 TypeScript 类型检查

### 📊 改进效果
- 🎯 **准确诊断**：不再误判 HTML 响应为成功
- 💡 **详细提示**：告诉用户问题所在和可能的解决方案
- 🛡️ **健壮性**：避免 JSON 解析崩溃
- ✅ **一致性**：测试连接和实际使用的错误一致

### 🎁 用户体验提升
- 从难以理解的 `Unexpected token '<'...` 
- 到清晰的 `API 返回了非 JSON 响应（text/html），这个 API 可能不兼容...`

---

## 修改的文件

1. ✅ `electron/services/ai-reply/adapters/OpenAIAdapter.ts`
   - generate() 函数：添加 Content-Type 检查
   - testConnection() 函数：增强验证逻辑

**代码行数变化**：
- generate(): +18 行（Content-Type 检查）
- testConnection(): +43 行（完整验证）
- 总计：+61 行

**无破坏性变更**：
- 对正常工作的 API 无影响
- 只增强了错误检测和提示

---

## 下一步建议

**立即行动**：
1. 重启 WeFlow 应用
2. 测试连接 api.cpu.moe
3. 查看新的错误提示
4. 根据提示调整配置或更换 API

**长期计划**：
1. 配置 ModelScope 作为主 API
2. 将 api.cpu.moe 作为备用（一旦找到正确端点）
3. 定期检查 API 可用性
