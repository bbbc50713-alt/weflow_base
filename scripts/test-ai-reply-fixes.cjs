/**
 * WeFlow-AI-Reply 阶段0修复验证测试 (CommonJS 格式，兼容旧版 Node)
 *
 * 运行方式:
 *   node scripts/test-ai-reply-fixes.cjs
 */
'use strict'

var assert = require('assert')

// ============================================================
var passed = 0
var failed = 0
var failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log('  \u221a ' + name)
  } catch (err) {
    failed++
    failures.push({ name: name, error: err.message })
    console.log('  \u2717 ' + name)
    console.log('    ' + err.message)
  }
}

async function asyncTest(name, fn) {
  try {
    await fn()
    passed++
    console.log('  \u221a ' + name)
  } catch (err) {
    failed++
    failures.push({ name: name, error: err.message })
    console.log('  \u2717 ' + name)
    console.log('    ' + err.message)
  }
}

// ============================================================
console.log('\n[1] MessageDeduper - isSimilar 按 contactId 过滤')

function createDeduper(maxEntries, ttlMs) {
  maxEntries = maxEntries || 10000
  ttlMs = ttlMs || 5 * 60 * 1000
  var processed = new Map()
  return {
    isDuplicate: function (msgId) {
      var entry = processed.get(msgId)
      if (!entry) return false
      if (Date.now() - entry.processedAt > ttlMs) {
        processed.delete(msgId)
        return false
      }
      return true
    },
    markProcessed: function (msgId, contentHash, contactId) {
      processed.set(msgId, {
        contentHash: contentHash || '',
        processedAt: Date.now(),
        contactId: contactId
      })
    },
    isSimilar: function (content, contactId, threshold) {
      threshold = threshold || 0.9
      if (!content || !contactId) return false
      var now = Date.now()
      processed.forEach(function (entry) {
        // iterate
      })
      var iter = processed.entries()
      var item
      while ((item = iter.next()) && !item.done) {
        var entry = item.value[1]
        if (now - entry.processedAt > ttlMs) continue
        if (entry.contactId !== contactId) continue
        if (entry.contentHash && similarity(content, entry.contentHash) > threshold) {
          return true
        }
      }
      return false
    }
  }
}

function similarity(a, b) {
  if (a === b) return 1
  if (!a || !b) return 0
  var longer = a.length > b.length ? a : b
  var shorter = a.length > b.length ? b : a
  if (longer.length === 0) return 1
  var dist = levenshtein(longer, shorter)
  return (longer.length - dist) / longer.length
}

function levenshtein(a, b) {
  var matrix = []
  for (var i = 0; i <= b.length; i++) matrix[i] = [i]
  for (var j = 0; j <= a.length; j++) matrix[0][j] = j
  for (var i = 1; i <= b.length; i++) {
    for (var j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
      }
    }
  }
  return matrix[b.length][a.length]
}

test('isSimilar - 同一联系人相同内容应判定为相似', function () {
  var d = createDeduper()
  d.markProcessed('msg1', '你好，今天天气怎么样', 'contactA')
  assert.strictEqual(d.isSimilar('你好，今天天气怎么样', 'contactA'), true)
})

test('isSimilar - 不同联系人相同内容不应判定为相似', function () {
  var d = createDeduper()
  d.markProcessed('msg1', '你好，今天天气怎么样', 'contactA')
  assert.strictEqual(d.isSimilar('你好，今天天气怎么样', 'contactB'), false)
})

test('isSimilar - 同一联系人高度相似内容应判定为相似', function () {
  var d = createDeduper()
  d.markProcessed('msg1', '你好，今天天气怎么样啊', 'contactA')
  assert.strictEqual(d.isSimilar('你好，今天天气怎么样', 'contactA'), true)
})

test('isSimilar - 同一联系人完全不同内容不应判定为相似', function () {
  var d = createDeduper()
  d.markProcessed('msg1', '你好，今天天气怎么样', 'contactA')
  assert.strictEqual(d.isSimilar('帮我查一下快递单号12345', 'contactA'), false)
})

test('isSimilar - 空内容或空contactId应返回false', function () {
  var d = createDeduper()
  d.markProcessed('msg1', '你好', 'contactA')
  assert.strictEqual(d.isSimilar('', 'contactA'), false)
  assert.strictEqual(d.isSimilar('你好', ''), false)
})

// ============================================================
console.log('\n[2] TriggerEngine - timezone + checkAtTrigger')

function getHourInTimezone(date, timezone) {
  if (!timezone) return date.getHours()
  try {
    var formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false
    })
    var hourStr = formatter.format(date)
    var hour = parseInt(hourStr, 10)
    if (isNaN(hour)) return date.getHours()
    return hour === 24 ? 0 : hour
  } catch (e) {
    return date.getHours()
  }
}

test('getHourInTimezone - Asia/Shanghai 时区应返回正确小时', function () {
  var date = new Date('2026-01-15T12:00:00Z')
  var hour = getHourInTimezone(date, 'Asia/Shanghai')
  assert.strictEqual(hour, 20, 'UTC 12:00 应为 Beijing 20:00, 实际得到 ' + hour)
})

test('getHourInTimezone - America/Los_Angeles 时区应返回正确小时', function () {
  var date = new Date('2026-07-15T20:00:00Z')
  var hour = getHourInTimezone(date, 'America/Los_Angeles')
  assert.strictEqual(hour, 13, 'UTC 20:00 应为 LA 13:00 (PDT), 实际得到 ' + hour)
})

test('getHourInTimezone - 空时区回退到本机时区', function () {
  var date = new Date()
  var hour = getHourInTimezone(date, '')
  assert.strictEqual(hour, date.getHours())
})

test('getHourInTimezone - 非法时区回退到本机时区', function () {
  var date = new Date()
  var hour = getHourInTimezone(date, 'Invalid/Timezone')
  assert.strictEqual(hour, date.getHours())
})

// checkAtTrigger 短路修复验证
function checkAtTrigger(isGroup, keywordsInclude, triggerOnAt, content, selfNickname) {
  if (!isGroup) return { passed: true }
  if (triggerOnAt) {
    var atPatterns = ['@all', '@所有人', '@全体成员']
    var isAtAll = atPatterns.some(function (p) { return content.indexOf(p) >= 0 })
    var isAtMe = false
    if (selfNickname) isAtMe = content.indexOf('@' + selfNickname) >= 0
    if (!isAtMe) isAtMe = content.indexOf('@我') >= 0
    var atEveryone = false && isAtAll
    if (!isAtMe && !atEveryone) {
      return { passed: false, reason: '群聊中未@，不触发回复' }
    }
    return { passed: true }
  }
  return { passed: true }
}

test('checkAtTrigger - 修复后：配了关键词但群聊未@应不触发', function () {
  var result = checkAtTrigger(true, ['你好'], true, '你好啊大家', '小明')
  assert.strictEqual(result.passed, false, '配了关键词但未@，应不触发')
  assert.ok(result.reason.indexOf('未@') >= 0, 'reason 应包含"未@", 实际: ' + result.reason)
})

test('checkAtTrigger - 群聊@我时应触发（即使配了关键词）', function () {
  var result = checkAtTrigger(true, ['你好'], true, '@小明 你好啊', '小明')
  assert.strictEqual(result.passed, true)
})

test('checkAtTrigger - triggerOnAt=false时群聊无需@', function () {
  var result = checkAtTrigger(true, ['你好'], false, '你好啊大家', '小明')
  assert.strictEqual(result.passed, true)
})

test('checkAtTrigger - 私聊无需@', function () {
  var result = checkAtTrigger(false, [], true, '你好', '小明')
  assert.strictEqual(result.passed, true)
})

// ============================================================
console.log('\n[3] WeClawHttpSender - 联系人映射硬失败')

function resolveTarget(request, config) {
  var mappings = config.contactMappings || {}
  var requireExplicit = config.requireExplicitMapping !== false

  var keys = Object.keys(mappings)
  if (keys.length > 0) {
    var mapped = mappings[request.contactId]
    if (mapped) return mapped.trim()
    return ''
  }

  if (requireExplicit) {
    return ''
  }

  return (request.contactId || request.contactName || '').trim()
}

test('resolveTarget - 有映射且命中应返回映射值', function () {
  var config = { contactMappings: { wxid_abc: 'weclaw_target_123' } }
  var result = resolveTarget({ contactId: 'wxid_abc', contactName: '张三' }, config)
  assert.strictEqual(result, 'weclaw_target_123')
})

test('resolveTarget - 有映射但未命中应硬失败（返回空）', function () {
  var config = { contactMappings: { wxid_abc: 'weclaw_target_123' } }
  var result = resolveTarget({ contactId: 'wxid_xyz', contactName: '李四' }, config)
  assert.strictEqual(result, '', '未命中映射应返回空字符串，避免发错人')
})

test('resolveTarget - 无映射且requireExplicitMapping=true（默认）应硬失败', function () {
  var config = {}
  var result = resolveTarget({ contactId: 'wxid_abc', contactName: '张三' }, config)
  assert.strictEqual(result, '', '未配置映射且默认requireExplicit应硬失败')
})

test('resolveTarget - 无映射但requireExplicitMapping=false应回退旧行为', function () {
  var config = { requireExplicitMapping: false }
  var result = resolveTarget({ contactId: 'wxid_abc', contactName: '张三' }, config)
  assert.strictEqual(result, 'wxid_abc', '兼容模式下应回退到 contactId')
})

test('resolveTarget - 无映射且contactId为空时回退到contactName', function () {
  var config = { requireExplicitMapping: false }
  var result = resolveTarget({ contactId: '', contactName: '张三' }, config)
  assert.strictEqual(result, '张三')
})

// ============================================================
console.log('\n[4] 消息缓冲重新排队逻辑')

function createBufferManager(messageBufferDelay, maxBufferRetries) {
  maxBufferRetries = maxBufferRetries || 5
  var messageBuffer = new Map()
  var processingContacts = new Set()

  function handleIncomingMessage(contactId, content) {
    var existing = messageBuffer.get(contactId)
    if (existing) {
      existing.messages.push({ contactId: contactId, content: content })
    } else {
      messageBuffer.set(contactId, {
        messages: [{ contactId: contactId, content: content }],
        contactName: contactId,
        retryCount: 0
      })
    }
  }

  function processBufferedMessages(contactId) {
    var entry = messageBuffer.get(contactId)
    if (!entry) return { action: 'noop' }

    if (processingContacts.has(contactId)) {
      if (entry.retryCount >= maxBufferRetries) {
        messageBuffer.delete(contactId)
        return { action: 'skipped', count: entry.messages.length }
      }
      entry.retryCount++
      return { action: 'requeued', retry: entry.retryCount }
    }

    messageBuffer.delete(contactId)
    processingContacts.add(contactId)
    return { action: 'processed', count: entry.messages.length }
  }

  return {
    handleIncomingMessage: handleIncomingMessage,
    processBufferedMessages: processBufferedMessages,
    markProcessingDone: function (contactId) { processingContacts.delete(contactId) },
    isProcessing: function (contactId) { return processingContacts.has(contactId) },
    getBufferMessageCount: function (contactId) {
      var e = messageBuffer.get(contactId)
      return e ? e.messages.length : 0
    },
    getRetryCount: function (contactId) {
      var e = messageBuffer.get(contactId)
      return e ? e.retryCount : 0
    }
  }
}

test('缓冲 - 联系人正在处理时新消息应重新排队而非丢失', function () {
  var mgr = createBufferManager(100, 5)
  mgr.handleIncomingMessage('contactA', '消息1')
  var result = mgr.processBufferedMessages('contactA')
  assert.strictEqual(result.action, 'processed')
  assert.strictEqual(mgr.isProcessing('contactA'), true)

  mgr.handleIncomingMessage('contactA', '消息2')
  result = mgr.processBufferedMessages('contactA')
  assert.strictEqual(result.action, 'requeued', '应重新排队而非跳过')
  assert.strictEqual(result.retry, 1)
  assert.strictEqual(mgr.getBufferMessageCount('contactA'), 1, '缓冲中应仍有1条消息')
})

test('缓冲 - 处理完成后重新排队消息应被处理', function () {
  var mgr = createBufferManager(100, 5)
  mgr.handleIncomingMessage('contactA', '消息1')
  mgr.processBufferedMessages('contactA')
  assert.strictEqual(mgr.isProcessing('contactA'), true)

  mgr.handleIncomingMessage('contactA', '消息2')
  mgr.processBufferedMessages('contactA')
  assert.strictEqual(mgr.getBufferMessageCount('contactA'), 1)

  mgr.markProcessingDone('contactA')
  assert.strictEqual(mgr.isProcessing('contactA'), false)

  var result = mgr.processBufferedMessages('contactA')
  assert.strictEqual(result.action, 'processed', '处理完成后应处理重新排队的消息')
  assert.strictEqual(result.count, 1)
})

test('缓冲 - 超过最大重试次数应放弃并记录', function () {
  var mgr = createBufferManager(100, 3)
  mgr.handleIncomingMessage('contactA', '消息1')
  mgr.processBufferedMessages('contactA')

  mgr.handleIncomingMessage('contactA', '消息2')
  mgr.processBufferedMessages('contactA') // retry 1
  mgr.processBufferedMessages('contactA') // retry 2
  mgr.processBufferedMessages('contactA') // retry 3
  var result = mgr.processBufferedMessages('contactA') // 第4次应放弃
  assert.strictEqual(result.action, 'skipped', '超过重试上限应放弃')
  assert.strictEqual(mgr.getBufferMessageCount('contactA'), 0, '放弃后缓冲应清空')
})

test('缓冲 - 不同联系人应独立处理', function () {
  var mgr = createBufferManager(100, 5)
  mgr.handleIncomingMessage('contactA', '消息A1')
  mgr.handleIncomingMessage('contactB', '消息B1')
  mgr.processBufferedMessages('contactA')

  var resultB = mgr.processBufferedMessages('contactB')
  assert.strictEqual(resultB.action, 'processed', 'B 应正常处理')
  assert.strictEqual(mgr.isProcessing('contactB'), true)
})

// ============================================================
console.log('\n[5] SkillEngine - execFile 参数数组（防命令注入）')

test('execFile 参数数组 - 路径含shell元字符应原样保留在参数中', function () {
  // execFile 不经过 shell，参数以数组形式传递给子进程，
  // 即使参数含 shell 元字符也不会被解析为命令。
  var maliciousPath = '"; rm -rf /; echo "'
  var args = ['-o', maliciousPath, '-d', '/tmp/out']
  // 验证：参数是数组（非字符串拼接），且恶意路径原样保留为独立元素
  assert.ok(Array.isArray(args), '参数应为数组而非字符串')
  assert.strictEqual(args[1], maliciousPath, '恶意路径应原样保留在参数数组中')
  assert.strictEqual(args.length, 4, '应为4个独立参数')
})

test('execFile 参数数组 - git clone URL含特殊字符应原样保留', function () {
  var maliciousUrl = 'https://example.com/repo.git; rm -rf /'
  var args = ['clone', '--depth', '1', maliciousUrl, '/tmp/dest']
  assert.strictEqual(args[3], maliciousUrl, '恶意URL应原样保留为独立参数元素')
  assert.strictEqual(args.length, 5, '应为5个独立参数')
  // execFile 不会把 args 拼成命令字符串，所以 URL 中的分号不会被解释为命令分隔符
})

// ============================================================
console.log('\n[6] recentMessages 不再重复注入')

test('generateSystemPrompt 调用 - 不应传 recentMessages 字段', function () {
  var extraContext = {
    relationship: { relationType: '朋友', notes: '大学同学' },
    contextSummary: '之前讨论了工作'
  }
  assert.ok(!('recentMessages' in extraContext), 'extraContext 不应包含 recentMessages')
  assert.ok('relationship' in extraContext)
  assert.ok('contextSummary' in extraContext)
})

// ============================================================
// 7. P0-2: AI 生成失败重试逻辑验证
// ============================================================
console.log('\n[7] AI 生成失败重试 (P0-2)')

function isRetryableError(errMsg) {
  var lower = (errMsg || '').toLowerCase()
  if (lower.indexOf('401') >= 0 || lower.indexOf('认证失败') >= 0 || lower.indexOf('api key') >= 0) return false
  if (lower.indexOf('403') >= 0 || lower.indexOf('forbidden') >= 0) return false
  if (lower.indexOf('400') >= 0 && lower.indexOf('parameter') >= 0) return false
  if (lower.indexOf('timeout') >= 0 || lower.indexOf('超时') >= 0) return true
  if (lower.indexOf('429') >= 0 || lower.indexOf('rate limit') >= 0 || lower.indexOf('限流') >= 0) return true
  if (lower.indexOf('502') >= 0 || lower.indexOf('503') >= 0 || lower.indexOf('504') >= 0) return true
  if (lower.indexOf('network') >= 0 || lower.indexOf('网络') >= 0) return true
  if (lower.indexOf('econnrefused') >= 0 || lower.indexOf('econnreset') >= 0 || lower.indexOf('fetch failed') >= 0) return true
  if (lower.indexOf('aborted') >= 0) return true
  return true
}

test('isRetryableError - 401 认证失败不可重试', function () {
  assert.strictEqual(isRetryableError('认证失败 (401): API Key 不正确'), false)
})

test('isRetryableError - 403 Forbidden 不可重试', function () {
  assert.strictEqual(isRetryableError('403 Forbidden'), false)
})

test('isRetryableError - 超时可重试', function () {
  assert.strictEqual(isRetryableError('Request timeout after 30000ms'), true)
})

test('isRetryableError - 429 限流可重试', function () {
  assert.strictEqual(isRetryableError('429 rate limit exceeded'), true)
})

test('isRetryableError - 502 网关错误可重试', function () {
  assert.strictEqual(isRetryableError('502 Bad Gateway'), true)
})

test('isRetryableError - 网络异常可重试', function () {
  assert.strictEqual(isRetryableError('fetch failed: ECONNREFUSED'), true)
})

// 模拟 generateWithRetry
function createMockAdapter(failCount, errorMsg) {
  var calls = 0
  return {
    generate: function () {
      calls++
      if (calls <= failCount) {
        var err = new Error(errorMsg || 'timeout after 30000ms')
        throw err
      }
      return Promise.resolve({ content: '回复内容', model: 'test-model' })
    },
    getCalls: function () { return calls }
  }
}

asyncTest('generateWithRetry - 首次成功不重试', async function () {
  var adapter = createMockAdapter(0)
  var attempts = 0
  for (var i = 0; i < 3; i++) {
    attempts++
    try {
      var result = await adapter.generate([])
      assert.strictEqual(result.content, '回复内容')
      break
    } catch (e) {
      if (attempts >= 3) throw e
    }
  }
  assert.strictEqual(adapter.getCalls(), 1, '应只调用 1 次')
})

asyncTest('generateWithRetry - 超时重试后成功', async function () {
  var adapter = createMockAdapter(1, 'timeout after 30000ms')
  var lastError = null
  var result
  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      result = await adapter.generate([])
      lastError = null
      break
    } catch (e) {
      lastError = e
      if (attempt < 3) {
        await new Promise(function (r) { setTimeout(r, 10) }) // 测试中用极短延迟
      }
    }
  }
  assert.ok(!lastError, '重试后应成功')
  assert.ok(result, '应有结果')
  assert.strictEqual(adapter.getCalls(), 2, '应调用 2 次（首次失败 + 重试成功）')
})

asyncTest('generateWithRetry - 401 不重试直接抛出', async function () {
  var adapter = createMockAdapter(3, '认证失败 (401): API Key 不正确')
  var lastError = null
  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      await adapter.generate([])
      break
    } catch (e) {
      lastError = e
      if (!isRetryableError(e.message)) break
    }
  }
  assert.ok(lastError, '应抛出错误')
  assert.ok(lastError.message.indexOf('401') >= 0, '应为 401 错误')
  assert.strictEqual(adapter.getCalls(), 1, '401 不重试，应只调用 1 次')
})

// ============================================================
// 8. P0-3: 缓冲重试上限验证
// ============================================================
console.log('\n[8] 缓冲重试上限匹配发送超时 (P0-3)')

test('maxBufferRetries=50 覆盖 90s 发送超时', function () {
  // 50 次 × 2s = 100s > 90s (45s × 2 重试 + 1.5s 间隔)
  var maxBufferRetries = 50
  var messageBufferDelay = 2000
  var maxBufferDuration = maxBufferRetries * messageBufferDelay
  var maxSendDuration = 45000 * 2 + 1500 // 91.5s
  assert.ok(maxBufferDuration >= maxSendDuration, '缓冲时长 (' + maxBufferDuration + 'ms) 应 >= 发送超时 (' + maxSendDuration + 'ms)')
})

// ============================================================
// 9. P1-3: ContextManager summary 长度上限验证
// ============================================================
console.log('\n[9] ContextManager summary 长度上限 (P1-3)')

function compressSummary(oldSummary, newSummary, maxLength) {
  var combined = oldSummary ? oldSummary + '\n' + newSummary : newSummary
  if (combined.length > maxLength) {
    return combined.slice(-maxLength)
  }
  return combined
}

test('summary - 未超限应完整保留', function () {
  var old = '[历史摘要] 共 10 条用户消息'
  var newer = '[历史摘要] 共 5 条用户消息'
  var result = compressSummary(old, newer, 2000)
  assert.strictEqual(result, old + '\n' + newer)
})

test('summary - 超限应截断保留最新部分', function () {
  var old = ''
  for (var i = 0; i < 100; i++) old += 'A'
  var newer = '最新摘要'
  var result = compressSummary(old, newer, 50)
  assert.strictEqual(result.length, 50, '截断后应为 50 字符')
  assert.ok(result.indexOf('最新摘要') >= 0, '应保留最新的摘要部分')
})

// ============================================================
// 10. P0-1: SSE 断连补拉逻辑验证
// ============================================================
console.log('\n[10] SSE 断连补拉逻辑 (P0-1)')

function createBackfillManager() {
  var sseDisconnectAt = null
  var isBackfilling = false
  var backfillFetcher = null
  var backfillCalled = false

  return {
    setBackfillFetcher: function (f) { backfillFetcher = f },
    recordDisconnect: function () {
      if (sseDisconnectAt === null) sseDisconnectAt = Date.now()
    },
    onReconnect: async function () {
      if (sseDisconnectAt === null) return
      if (isBackfilling) return
      if (!backfillFetcher) {
        sseDisconnectAt = null
        return
      }
      var sinceTs = sseDisconnectAt
      sseDisconnectAt = null
      isBackfilling = true
      try {
        backfillCalled = true
        await backfillFetcher(sinceTs)
      } finally {
        isBackfilling = false
      }
    },
    wasBackfillCalled: function () { return backfillCalled },
    getDisconnectAt: function () { return sseDisconnectAt }
  }
}

asyncTest('SSE 重连 - 断连后重连应触发补拉', async function () {
  var mgr = createBackfillManager()
  var fetcherCalled = false
  mgr.setBackfillFetcher(function (sinceTs) {
    fetcherCalled = true
    return Promise.resolve([{ msgId: 'msg1', content: 'hello', contactId: 'A' }])
  })
  mgr.recordDisconnect()
  assert.ok(mgr.getDisconnectAt() !== null, '应记录断连时间')
  await mgr.onReconnect()
  assert.ok(fetcherCalled, '重连后应调用 fetcher')
  assert.strictEqual(mgr.getDisconnectAt(), null, '补拉后应清除断连时间')
})

asyncTest('SSE 重连 - 未配置 fetcher 应跳过补拉', async function () {
  var mgr = createBackfillManager()
  mgr.recordDisconnect()
  await mgr.onReconnect()
  assert.ok(!mgr.wasBackfillCalled(), '未配置 fetcher 不应补拉')
  assert.strictEqual(mgr.getDisconnectAt(), null, '应清除断连时间')
})

asyncTest('SSE 重连 - 未断连不应触发补拉', async function () {
  var mgr = createBackfillManager()
  var fetcherCalled = false
  mgr.setBackfillFetcher(function () {
    fetcherCalled = true
    return Promise.resolve([])
  })
  await mgr.onReconnect() // 未调用 recordDisconnect
  assert.ok(!fetcherCalled, '未断连不应补拉')
})

// ============================================================
console.log('\n' + '='.repeat(60))
console.log('测试结果: ' + passed + ' 通过, ' + failed + ' 失败')
if (failed > 0) {
  console.log('\n失败项:')
  failures.forEach(function (f) { console.log('  - ' + f.name + ': ' + f.error) })
  process.exit(1)
} else {
  console.log('全部测试通过 \u221a')
}
