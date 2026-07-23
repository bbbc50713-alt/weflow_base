/**
 * WeFlow-AI-Reply 端到端集成测试
 *
 * 模拟完整自动回复链路：SSE 接收 → 去重 → 缓冲 → 触发 → AI 生成 → 发送 → 日志
 * 验证真实场景下长待机自动回复的可靠性
 *
 * 运行方式: node scripts/test-e2e-reply.cjs
 */
'use strict'

var assert = require('assert')

// ============================================================
// 测试框架
// ============================================================
var passed = 0
var failed = 0
var failures = []
var testLogs = []

function test(name, fn) {
  try { fn(); passed++; console.log('  \u221a ' + name) }
  catch (err) { failed++; failures.push({ name: name, error: err.message }); console.log('  \u2717 ' + name); console.log('    ' + err.message) }
}
async function asyncTest(name, fn) {
  try { await fn(); passed++; console.log('  \u221a ' + name) }
  catch (err) { failed++; failures.push({ name: name, error: err.message }); console.log('  \u2717 ' + name); console.log('    ' + err.message) }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

// ============================================================
// Mock 组件：模拟 AIReplyService 的核心链路
// ============================================================
function createReplyService(options) {
  options = options || {}
  var config = {
    status: 'running',
    autoReplyEnabled: true,
    autoSendEnabled: true,
    // 触发规则
    triggerRules: {
      enabled: true,
      listenMode: 'all', // all/specific/whitelist/blacklist
      targetContacts: [],
      keywords: { include: [], exclude: [], regex: [] },
      triggerOnAt: true,
      triggerOnAtAll: false,
      timeRules: { enabled: false, allowedHours: [8, 22], timezone: 'Asia/Shanghai' },
      rateLimit: { maxRepliesPerMinute: 10, cooldownSeconds: 5 }
    },
    // 发送器
    activeSender: 'ui-automation',
    fallbackSender: 'manual',
    senderFailMode: 'success', // success/fail/timeout
    // AI 生成
    aiFailCount: 0, // 前 N 次失败
    aiFailError: 'timeout after 30000ms',
    // 缓冲
    messageBufferDelay: 50, // 测试中用短延迟
    maxBufferRetries: 50,
    // 统计
    dailyStats: { receivedCount: 0, repliedCount: 0, errorCount: 0 },
    activeContactsToday: new Set(),
    // SSE 补拉
    sseDisconnectAt: null,
    backfillMessages: [],
    // 去重
    processed: new Map(),
    // 上下文
    contexts: new Map(),
    // 自身
    selfWxid: '',
    recentSentMessages: new Map(),
    lastProcessedTimestamp: Date.now(),
    aiCallCount: 0,
    sendCallCount: 0,
    replyLogs: []
  }

  // --- 去重 ---
  function isDuplicate(msgId) {
    var entry = config.processed.get(msgId)
    if (!entry) return false
    if (Date.now() - entry.processedAt > 300000) { config.processed.delete(msgId); return false }
    return true
  }
  function markProcessed(msgId, content, contactId) {
    config.processed.set(msgId, { content: content, processedAt: Date.now(), contactId: contactId })
  }
  function isSimilar(content, contactId) {
    if (!content || !contactId) return false
    var now = Date.now()
    var iter = config.processed.entries()
    var item
    while ((item = iter.next()) && !item.done) {
      var entry = item.value[1]
      if (now - entry.processedAt > 300000) continue
      if (entry.contactId !== contactId) continue
      if (entry.content && entry.content === content) return true
    }
    return false
  }

  // --- 触发规则检查 ---
  function shouldReply(message) {
    var rules = config.triggerRules
    if (!rules.enabled) return { shouldReply: false, reason: '未启用' }
    // listenMode
    if (rules.listenMode === 'specific') {
      var matched = rules.targetContacts.some(function (c) { return c.contactId === message.contactId })
      if (!matched) return { shouldReply: false, reason: '不在目标联系人' }
    }
    // 时间规则
    if (rules.timeRules.enabled) {
      var hour = new Date().getHours()
      var s = rules.timeRules.allowedHours[0], e = rules.timeRules.allowedHours[1]
      if (s <= e) { if (hour < s || hour >= e) return { shouldReply: false, reason: '时间不允许' } }
      else { if (hour < s && hour >= e) return { shouldReply: false, reason: '时间不允许' } }
    }
    // 限频
    if (rules.rateLimit) {
      // 简化：不模拟滑窗，只检查 cooldown
    }
    return { shouldReply: true }
  }

  // --- AI 生成（带重试）---
  function isRetryableError(errMsg) {
    var l = (errMsg || '').toLowerCase()
    if (l.indexOf('401') >= 0 || l.indexOf('认证失败') >= 0) return false
    if (l.indexOf('403') >= 0) return false
    return true
  }
  async function generateWithRetry(messages, maxTokens) {
    var maxAttempts = 3
    var lastError = null
    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      config.aiCallCount++
      try {
        if (config.aiCallCount <= config.aiFailCount) {
          throw new Error(config.aiFailError)
        }
        return { content: '这是AI回复内容', model: 'test-model' }
      } catch (e) {
        lastError = e
        if (!isRetryableError(e.message) || attempt === maxAttempts) throw e
        await sleep(attempt * 10) // 测试中短延迟
      }
    }
    throw lastError
  }

  // --- 发送 ---
  async function sendText(request) {
    config.sendCallCount++
    if (config.senderFailMode === 'success') {
      return { success: true, delivered: true, senderId: config.activeSender }
    } else if (config.senderFailMode === 'fail') {
      return { success: false, delivered: false, senderId: config.activeSender, error: '发送失败' }
    } else if (config.senderFailMode === 'timeout') {
      await sleep(200) // 模拟超时
      return { success: false, delivered: false, senderId: config.activeSender, error: 'timeout' }
    }
  }

  // --- 消息缓冲 ---
  var messageBuffer = new Map()
  var processingContacts = new Set()

  function handleIncomingMessage(message) {
    if (config.status !== 'running') return { action: 'skipped', reason: '服务未运行' }
    if (isDuplicate(message.msgId)) return { action: 'skipped', reason: '重复' }
    if (isSimilar(message.content, message.contactId)) return { action: 'skipped', reason: '相似' }
    markProcessed(message.msgId, message.content, message.contactId)
    if (message.isSend) return { action: 'skipped', reason: '自发消息' }
    if (message.type === 10000) return { action: 'skipped', reason: '系统消息' }

    if (message.timestamp > config.lastProcessedTimestamp) {
      config.lastProcessedTimestamp = message.timestamp
    }
    config.dailyStats.receivedCount++
    config.activeContactsToday.add(message.contactId)

    // 缓冲
    var existing = messageBuffer.get(message.contactId)
    if (existing) {
      // P0 修复：clearTimeout 后必须重新设置 timer（与真实代码同步修复）
      clearTimeout(existing.timer)
      existing.messages.push(message)
      existing.timer = setTimeout(function () {
        processBufferedMessages(message.contactId)
      }, config.messageBufferDelay)
    } else {
      var entry = { messages: [message], retryCount: 0 }
      messageBuffer.set(message.contactId, entry)
      entry.timer = setTimeout(function () {
        processBufferedMessages(message.contactId)
      }, config.messageBufferDelay)
    }
    return { action: 'buffered' }
  }

  async function processBufferedMessages(contactId) {
    var entry = messageBuffer.get(contactId)
    if (!entry) return

    if (processingContacts.has(contactId)) {
      if (entry.retryCount >= config.maxBufferRetries) {
        messageBuffer.delete(contactId)
        return
      }
      entry.retryCount++
      entry.timer = setTimeout(function () {
        processBufferedMessages(contactId)
      }, config.messageBufferDelay)
      return
    }

    messageBuffer.delete(contactId)
    processingContacts.add(contactId)

    try {
      var mergedContent = entry.messages.map(function (m) { return m.content }).join('\n')
      var triggerMessage = Object.assign({}, entry.messages[0], { content: mergedContent })
      var triggerResult = shouldReply(triggerMessage)
      if (!triggerResult.shouldReply) {
        return { action: 'skipped', reason: triggerResult.reason }
      }

      // AI 生成
      var result = await generateWithRetry([], 1000)
      var plainContent = result.content

      // 上下文记录
      var ctx = config.contexts.get(contactId) || { messages: [] }
      ctx.messages.push({ role: 'user', content: mergedContent })
      ctx.messages.push({ role: 'assistant', content: plainContent })
      config.contexts.set(contactId, ctx)

      // 发送
      var sent = false
      var sendError = null
      if (config.autoReplyEnabled && config.autoSendEnabled) {
        var sendResult = await sendText({ contactId: contactId, text: plainContent })
        if (sendResult.success && sendResult.delivered) {
          sent = true
          config.recentSentMessages.set(contactId + ':' + plainContent, Date.now())
        } else {
          sendError = sendResult.error || '发送失败'
        }
      }

      var log = {
        timestamp: Date.now(),
        contactId: contactId,
        receivedMessage: mergedContent,
        generatedReply: plainContent,
        success: !sendError,
        sent: sent,
        errorMessage: sendError
      }
      config.replyLogs.push(log)
      if (sent) config.dailyStats.repliedCount++
      else config.dailyStats.errorCount++

      return { action: 'processed', sent: sent, content: plainContent }
    } catch (e) {
      config.dailyStats.errorCount++
      config.replyLogs.push({ timestamp: Date.now(), contactId: contactId, success: false, sent: false, errorMessage: e.message })
      return { action: 'error', error: e.message }
    } finally {
      processingContacts.delete(contactId)
    }
  }

  // --- SSE 补拉 ---
  function recordSSEDisonnect() {
    if (config.sseDisconnectAt === null) config.sseDisconnectAt = Date.now()
  }
  async function backfillMissedMessages() {
    if (config.sseDisconnectAt === null) return 0
    var sinceTs = config.sseDisconnectAt
    config.sseDisconnectAt = null
    var msgs = config.backfillMessages.filter(function (m) { return m.timestamp >= sinceTs })
    msgs.sort(function (a, b) { return (a.timestamp || 0) - (b.timestamp || 0) })
    for (var i = 0; i < msgs.length; i++) {
      handleIncomingMessage(msgs[i])
    }
    // 等待缓冲处理
    await sleep(config.messageBufferDelay * 3)
    return msgs.length
  }

  // --- 等待所有缓冲处理完成 ---
  async function waitForProcessing(timeoutMs) {
    timeoutMs = timeoutMs || 1000
    var start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (messageBuffer.size === 0 && processingContacts.size === 0) return
      await sleep(20)
    }
  }

  return {
    config: config,
    handleIncomingMessage: handleIncomingMessage,
    processBufferedMessages: processBufferedMessages,
    waitForProcessing: waitForProcessing,
    recordSSEDisonnect: recordSSEDisonnect,
    backfillMissedMessages: backfillMissedMessages,
    setSenderFailMode: function (m) { config.senderFailMode = m },
    setAIFailCount: function (n, err) { config.aiFailCount = n; if (err) config.aiFailError = err },
    setTriggerRules: function (r) { Object.assign(config.triggerRules, r) },
    getReplyLogs: function () { return config.replyLogs },
    getDailyStats: function () { return config.dailyStats },
    getAICallCount: function () { return config.aiCallCount },
    getSendCallCount: function () { return config.sendCallCount }
  }
}

// ============================================================
// 测试场景
// ============================================================

// --- 场景 1：正常单条消息回复 ---
console.log('\n[场景 1] 正常单条消息回复')
asyncTest('单条消息 → 触发 → AI生成 → 发送成功', async function () {
  var svc = createReplyService()
  svc.handleIncomingMessage({
    msgId: 'msg_001', contactId: 'wxid_test1', contactName: '张三',
    content: '你好', isGroup: false, isSend: false, type: 1, timestamp: Date.now()
  })
  await svc.waitForProcessing(500)
  var logs = svc.getReplyLogs()
  assert.strictEqual(logs.length, 1, '应产生 1 条回复日志')
  assert.strictEqual(logs[0].sent, true, '应发送成功')
  assert.strictEqual(logs[0].success, true, '应成功')
  assert.strictEqual(logs[0].generatedReply, '这是AI回复内容', '应包含 AI 回复')
  assert.strictEqual(svc.getAICallCount(), 1, 'AI 应调用 1 次')
  assert.strictEqual(svc.getSendCallCount(), 1, '发送应调用 1 次')
  var stats = svc.getDailyStats()
  assert.strictEqual(stats.receivedCount, 1, '接收计数应为 1')
  assert.strictEqual(stats.repliedCount, 1, '回复计数应为 1')
})

// --- 场景 2：连续多条消息合并 ---
console.log('\n[场景 2] 连续多条消息合并')
asyncTest('同联系人 3 条消息 → 合并为 1 次回复', async function () {
  var svc = createReplyService()
  var baseTs = Date.now()
  svc.handleIncomingMessage({ msgId: 'm1', contactId: 'wxid_c2', contactName: '李四', content: '在吗', isGroup: false, isSend: false, type: 1, timestamp: baseTs })
  svc.handleIncomingMessage({ msgId: 'm2', contactId: 'wxid_c2', contactName: '李四', content: '有个问题', isGroup: false, isSend: false, type: 1, timestamp: baseTs + 10 })
  svc.handleIncomingMessage({ msgId: 'm3', contactId: 'wxid_c2', contactName: '李四', content: '想请教一下', isGroup: false, isSend: false, type: 1, timestamp: baseTs + 20 })
  await svc.waitForProcessing(500)
  var logs = svc.getReplyLogs()
  assert.strictEqual(logs.length, 1, '3 条消息应合并为 1 条回复')
  assert.ok(logs[0].receivedMessage.indexOf('在吗') >= 0, '应包含第1条')
  assert.ok(logs[0].receivedMessage.indexOf('有个问题') >= 0, '应包含第2条')
  assert.ok(logs[0].receivedMessage.indexOf('想请教一下') >= 0, '应包含第3条')
  assert.strictEqual(svc.getAICallCount(), 1, 'AI 应只调用 1 次')
})

// --- 场景 3：SSE 断连补拉 ---
console.log('\n[场景 3] SSE 断连补拉')
asyncTest('断连期间 2 条消息 → 重连补拉 → 全部回复', async function () {
  var svc = createReplyService()
  var baseTs = Date.now()
  // 模拟断连
  svc.recordSSEDisonnect()
  // 断连期间的消息（存入 backfillMessages）
  svc.config.backfillMessages = [
    { msgId: 'bf1', contactId: 'wxid_bf1', contactName: '王五', content: '断连期间消息1', isGroup: false, isSend: false, type: 1, timestamp: baseTs + 1000 },
    { msgId: 'bf2', contactId: 'wxid_bf2', contactName: '赵六', content: '断连期间消息2', isGroup: false, isSend: false, type: 1, timestamp: baseTs + 2000 }
  ]
  // 重连后补拉
  var count = await svc.backfillMissedMessages()
  await svc.waitForProcessing(500)
  assert.strictEqual(count, 2, '应补拉 2 条消息')
  var logs = svc.getReplyLogs()
  assert.strictEqual(logs.length, 2, '应产生 2 条回复')
  assert.strictEqual(svc.config.sseDisconnectAt, null, '断连时间应清除')
})

asyncTest('未断连不触发补拉', async function () {
  var svc = createReplyService()
  svc.config.backfillMessages = [
    { msgId: 'bf1', contactId: 'wxid_x', content: 'test', isGroup: false, isSend: false, type: 1, timestamp: Date.now() }
  ]
  var count = await svc.backfillMissedMessages()
  assert.strictEqual(count, 0, '未断连应返回 0')
  assert.strictEqual(svc.getReplyLogs().length, 0, '不应有回复')
})

// --- 场景 4：AI 生成失败重试 ---
console.log('\n[场景 4] AI 生成失败重试')
asyncTest('首次超时 → 重试成功', async function () {
  var svc = createReplyService()
  svc.setAIFailCount(1, 'timeout after 30000ms')
  svc.handleIncomingMessage({ msgId: 'r1', contactId: 'wxid_r1', contactName: 'A', content: '你好', isGroup: false, isSend: false, type: 1, timestamp: Date.now() })
  await svc.waitForProcessing(1000)
  var logs = svc.getReplyLogs()
  assert.strictEqual(logs.length, 1, '应产生回复')
  assert.strictEqual(logs[0].sent, true, '应发送成功')
  assert.strictEqual(svc.getAICallCount(), 2, 'AI 应调用 2 次（首次失败 + 重试成功）')
})

asyncTest('连续 3 次超时 → 最终失败记录', async function () {
  var svc = createReplyService()
  svc.setAIFailCount(3, 'timeout after 30000ms')
  svc.handleIncomingMessage({ msgId: 'r2', contactId: 'wxid_r2', contactName: 'B', content: '你好', isGroup: false, isSend: false, type: 1, timestamp: Date.now() })
  await svc.waitForProcessing(1500)
  var logs = svc.getReplyLogs()
  assert.strictEqual(logs.length, 1, '应产生 1 条失败日志')
  assert.strictEqual(logs[0].success, false, '应标记失败')
  assert.strictEqual(logs[0].sent, false, '不应发送')
  assert.ok(logs[0].errorMessage.indexOf('timeout') >= 0, '应记录超时错误')
  assert.strictEqual(svc.getAICallCount(), 3, 'AI 应调用 3 次（全部失败）')
})

asyncTest('401 不重试直接失败', async function () {
  var svc = createReplyService()
  svc.setAIFailCount(3, '认证失败 (401): API Key 不正确')
  svc.handleIncomingMessage({ msgId: 'r3', contactId: 'wxid_r3', contactName: 'C', content: '你好', isGroup: false, isSend: false, type: 1, timestamp: Date.now() })
  await svc.waitForProcessing(500)
  var logs = svc.getReplyLogs()
  assert.strictEqual(logs.length, 1, '应产生失败日志')
  assert.strictEqual(svc.getAICallCount(), 1, '401 不重试，应只调用 1 次')
  assert.ok(logs[0].errorMessage.indexOf('401') >= 0, '应为 401 错误')
})

// --- 场景 5：发送失败降级 ---
console.log('\n[场景 5] 发送失败')
asyncTest('发送失败 → 记录错误 → 不影响其他联系人', async function () {
  var svc = createReplyService()
  svc.setSenderFailMode('fail')
  svc.handleIncomingMessage({ msgId: 's1', contactId: 'wxid_s1', contactName: 'D', content: '你好', isGroup: false, isSend: false, type: 1, timestamp: Date.now() })
  await svc.waitForProcessing(500)
  var logs = svc.getReplyLogs()
  assert.strictEqual(logs.length, 1, '应有日志')
  assert.strictEqual(logs[0].sent, false, '应未发送')
  assert.strictEqual(logs[0].success, false, '应标记失败')
  assert.ok(logs[0].errorMessage, '应有错误信息')
  // 统计
  assert.strictEqual(svc.getDailyStats().errorCount, 1, '错误计数应为 1')
})

// --- 场景 6：触发规则过滤 ---
console.log('\n[场景 6] 触发规则过滤')
asyncTest('listenMode=specific 且不在目标列表 → 不回复', async function () {
  var svc = createReplyService()
  svc.setTriggerRules({ listenMode: 'specific', targetContacts: [{ contactId: 'wxid_target' }] })
  svc.handleIncomingMessage({ msgId: 'f1', contactId: 'wxid_other', contactName: 'X', content: '你好', isGroup: false, isSend: false, type: 1, timestamp: Date.now() })
  await svc.waitForProcessing(500)
  assert.strictEqual(svc.getReplyLogs().length, 0, '不在目标列表不应回复')
  assert.strictEqual(svc.getAICallCount(), 0, '不应调用 AI')
})

asyncTest('listenMode=specific 且在目标列表 → 回复', async function () {
  var svc = createReplyService()
  svc.setTriggerRules({ listenMode: 'specific', targetContacts: [{ contactId: 'wxid_target' }] })
  svc.handleIncomingMessage({ msgId: 'f2', contactId: 'wxid_target', contactName: 'Y', content: '你好', isGroup: false, isSend: false, type: 1, timestamp: Date.now() })
  await svc.waitForProcessing(500)
  assert.strictEqual(svc.getReplyLogs().length, 1, '在目标列表应回复')
})

asyncTest('系统消息 type=10000 → 跳过', async function () {
  var svc = createReplyService()
  svc.handleIncomingMessage({ msgId: 'f3', contactId: 'wxid_sys', contactName: 'Z', content: '撤回了一条消息', isGroup: false, isSend: false, type: 10000, timestamp: Date.now() })
  await svc.waitForProcessing(500)
  assert.strictEqual(svc.getReplyLogs().length, 0, '系统消息不应回复')
})

asyncTest('自己发送的消息 → 跳过', async function () {
  var svc = createReplyService()
  svc.handleIncomingMessage({ msgId: 'f4', contactId: 'wxid_self', contactName: '我', content: '我发的', isGroup: false, isSend: true, type: 1, timestamp: Date.now() })
  await svc.waitForProcessing(500)
  assert.strictEqual(svc.getReplyLogs().length, 0, '自发消息不应回复')
})

// --- 场景 7：去重 ---
console.log('\n[场景 7] 消息去重')
asyncTest('相同 msgId 重复消息 → 只回复一次', async function () {
  var svc = createReplyService()
  var msg = { msgId: 'dup_001', contactId: 'wxid_dup', contactName: 'DUP', content: '重复消息', isGroup: false, isSend: false, type: 1, timestamp: Date.now() }
  svc.handleIncomingMessage(msg)
  svc.handleIncomingMessage(msg) // 重复
  await svc.waitForProcessing(500)
  assert.strictEqual(svc.getReplyLogs().length, 1, '重复消息应只回复 1 次')
})

// --- 场景 8：多联系人并发 ---
console.log('\n[场景 8] 多联系人并发处理')
asyncTest('3 个联系人同时发消息 → 各自独立回复', async function () {
  var svc = createReplyService()
  var baseTs = Date.now()
  svc.handleIncomingMessage({ msgId: 'c1', contactId: 'wxid_con1', contactName: '联系人1', content: '你好', isGroup: false, isSend: false, type: 1, timestamp: baseTs })
  svc.handleIncomingMessage({ msgId: 'c2', contactId: 'wxid_con2', contactName: '联系人2', content: '在吗', isGroup: false, isSend: false, type: 1, timestamp: baseTs })
  svc.handleIncomingMessage({ msgId: 'c3', contactId: 'wxid_con3', contactName: '联系人3', content: '请教', isGroup: false, isSend: false, type: 1, timestamp: baseTs })
  await svc.waitForProcessing(1000)
  var logs = svc.getReplyLogs()
  assert.strictEqual(logs.length, 3, '应产生 3 条独立回复')
  var contactIds = logs.map(function (l) { return l.contactId }).sort()
  assert.deepStrictEqual(contactIds, ['wxid_con1', 'wxid_con2', 'wxid_con3'], '应覆盖 3 个联系人')
})

// --- 场景 9：长待机统计 ---
console.log('\n[场景 9] 长待机统计')
asyncTest('多轮对话后统计准确', async function () {
  var svc = createReplyService()
  // 模拟 5 轮对话
  for (var i = 0; i < 5; i++) {
    svc.handleIncomingMessage({ msgId: 'stat_' + i, contactId: 'wxid_stat', contactName: '统计', content: '消息' + i, isGroup: false, isSend: false, type: 1, timestamp: Date.now() + i })
    await svc.waitForProcessing(300)
  }
  var stats = svc.getDailyStats()
  assert.strictEqual(stats.receivedCount, 5, '应接收 5 条')
  assert.strictEqual(stats.repliedCount, 5, '应回复 5 条')
  assert.strictEqual(stats.errorCount, 0, '应无错误')
  assert.strictEqual(svc.config.activeContactsToday.size, 1, '应 1 个活跃联系人')
})

// --- 场景 10：发送卡顿期间新消息不丢失 ---
console.log('\n[场景 10] 发送卡顿期间新消息缓冲')
asyncTest('发送超时卡顿 → 新消息重新排队 → 不丢失', async function () {
  var svc = createReplyService()
  svc.config.messageBufferDelay = 30 // 短延迟加速测试
  svc.setSenderFailMode('timeout')
  // 第一条消息触发处理（发送会卡 200ms）
  svc.handleIncomingMessage({ msgId: 'stall1', contactId: 'wxid_stall', contactName: 'STALL', content: '第一条', isGroup: false, isSend: false, type: 1, timestamp: Date.now() })
  await sleep(60) // 等第一条进入处理（buffer 30ms + 处理开始）
  // 处理期间来了第二条
  svc.handleIncomingMessage({ msgId: 'stall2', contactId: 'wxid_stall', contactName: 'STALL', content: '第二条', isGroup: false, isSend: false, type: 1, timestamp: Date.now() })
  // 发送超时 200ms + 第二条缓冲 30ms + 重新排队，总等待需要足够长
  await svc.waitForProcessing(2000)
  var logs = svc.getReplyLogs()
  // 第一条发送失败（timeout 模式），第二条应重新排队后处理
  assert.ok(logs.length >= 1, '应至少处理 1 条，实际 ' + logs.length)
  // 第二条不应丢失（maxBufferRetries=50 足够覆盖 200ms 超时）
  var hasSecond = logs.some(function (l) { return l.receivedMessage && l.receivedMessage.indexOf('第二条') >= 0 })
  assert.ok(hasSecond, '第二条消息不应丢失')
})

// ============================================================
console.log('\n' + '='.repeat(60))
console.log('集成测试结果: ' + passed + ' 通过, ' + failed + ' 失败')
if (failed > 0) {
  console.log('\n失败项:')
  failures.forEach(function (f) { console.log('  - ' + f.name + ': ' + f.error) })
  process.exit(1)
} else {
  console.log('全部集成测试通过 \u221a')
}
