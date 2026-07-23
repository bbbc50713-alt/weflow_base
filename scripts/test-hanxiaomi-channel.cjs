const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const outDir = path.join(root, 'node_modules', '.cache', 'hanxiaomi-channel-tests')

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

esbuild.buildSync({
  entryPoints: [
    'electron/services/ai-reply/hanxiaomi/HanxiaomiContextBuilder.ts',
    'electron/services/ai-reply/hanxiaomi/HanxiaomiDeliveryLedger.ts',
    'electron/services/ai-reply/hanxiaomi/HanxiaomiReplyClient.ts',
    'electron/services/ai-reply/hanxiaomi/HanxiaomiStalenessGuard.ts',
    'electron/services/ai-reply/queue/DeliveryPacer.ts',
    'electron/services/ai-reply/queue/HanxiaomiQueueStore.ts',
    'electron/services/ai-reply/queue/HanxiaomiOutboundQueue.ts',
    'electron/services/ai-reply/queue/HanxiaomiInboundQueue.ts',
    'electron/services/ai-reply/utils/markdownToPlainText.ts'
  ],
  absWorkingDir: root,
  outdir: outDir,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  bundle: false,
  sourcemap: false,
  logLevel: 'silent'
})

esbuild.buildSync({
  entryPoints: [
    'electron/services/messagePushTiming.ts',
    'electron/services/messagePushDelivery.ts'
  ],
  absWorkingDir: root,
  outdir: outDir,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  bundle: false,
  sourcemap: false,
  logLevel: 'silent'
})

const {
  buildHanxiaomiReplyRequest,
  buildHanxiaomiEventKey,
  hashRef
} = require(path.join(outDir, 'hanxiaomi/HanxiaomiContextBuilder.js'))
const { HanxiaomiDeliveryLedger } = require(path.join(outDir, 'hanxiaomi/HanxiaomiDeliveryLedger.js'))
const { HanxiaomiReplyClient } = require(path.join(outDir, 'hanxiaomi/HanxiaomiReplyClient.js'))
const {
  extractHanxiaomiMessageText,
  isRecentHanxiaomiAutoReplyText,
  isOwnPreviousHanxiaomiSplitPart,
  shouldIgnoreOperatorOutboundForHanxiaomiSplitContinuation
} = require(path.join(outDir, 'hanxiaomi/HanxiaomiStalenessGuard.js'))
const { HanxiaomiOutboundQueue } = require(path.join(outDir, 'queue/HanxiaomiOutboundQueue.js'))
const { HanxiaomiInboundQueue } = require(path.join(outDir, 'queue/HanxiaomiInboundQueue.js'))
const { mergeDeliveryPolicy } = require(path.join(outDir, 'queue/DeliveryPacer.js'))
const { selectSameTimestampIncomingMessages } = require(path.join(outDir, 'messagePushTiming.js'))
const { isMessagePushDeliveryCommitted } = require(path.join(outDir, 'messagePushDelivery.js'))

async function waitFor(predicate, timeoutMs = 1500) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert(predicate(), 'waitFor timed out')
}

function message(index, patch = {}) {
  return {
    messageKey: `key-${index}`,
    localId: index,
    serverId: index + 1000,
    localType: patch.localType ?? 1,
    createTime: 1700000000 + index,
    sortSeq: index,
    isSend: patch.isSend ?? (index % 2 === 0 ? 1 : 0),
    senderUsername: patch.senderUsername ?? `sender-${index}`,
    parsedContent: patch.parsedContent ?? `message ${index}`,
    rawContent: patch.rawContent ?? '',
    ...patch
  }
}

async function testContextWindowsAndCurrentDedup() {
  const calls = []
  const provider = {
    getLatestMessages: async (_contactId, limit) => {
      calls.push(limit)
      return { success: true, messages: Array.from({ length: limit }, (_, i) => message(i + 1)) }
    },
    getContact: async () => ({ contact: { displayName: '客户A', labels: ['复购'] } }),
    getLongProfile: async () => '长期画像',
    getAccountId: () => 'local-account'
  }

  const first = await buildHanxiaomiReplyRequest({
    accountId: 'local-account',
    contactId: 'contact-a',
    contactName: '客户A',
    isFirstSuccessfulCall: true,
    currentContent: '最新问题',
    bufferedMessages: [{ msgId: 'buf-1', content: '最新问题', timestamp: Date.now(), type: 1 }],
    mode: 'auto',
    scenario: 'reply',
    identitySalt: 'salt',
    provider
  })
  assert.strictEqual(calls[0], 50)
  assert.strictEqual(first.history.length, 49)
  assert.strictEqual(first.current_message.message_key, 'buf-1')
  assert.strictEqual(first.current_message.content, '最新问题')
  assert(!first.history.some(item => item.message_key === first.current_message.message_key))
  assert.strictEqual(first.request_meta.window_size, 50)
  assert.strictEqual(first.request_meta.identity_version, 2)
  assert.strictEqual(first.request_meta.current_source, 'buffered_fallback')

  const rolling = await buildHanxiaomiReplyRequest({
    accountId: 'local-account',
    contactId: 'contact-a',
    contactName: '客户A',
    isFirstSuccessfulCall: false,
    currentContent: '滚动问题',
    bufferedMessages: [{ msgId: 'buf-2', content: '滚动问题', timestamp: Date.now(), type: 1 }],
    mode: 'auto',
    scenario: 'reply',
    identitySalt: 'salt',
    provider
  })
  assert.strictEqual(calls[1], 30)
  assert.strictEqual(rolling.history.length, 29)
  assert.strictEqual(rolling.request_meta.window_size, 30)
}

async function testCurrentMessageIsBoundToBufferedMessageNotLatestInboundGuess() {
  const provider = {
    getLatestMessages: async () => ({
      success: true,
      messages: [
        message(1, {
          messageKey: 'current-buffered',
          createTime: 1700000100,
          parsedContent: '真正触发的问题',
          isSend: 0
        }),
        message(2, {
          messageKey: 'later-customer',
          createTime: 1700000200,
          parsedContent: '这条更晚但不是本次缓冲触发',
          isSend: 0
        })
      ]
    }),
    getContact: async () => ({ contact: { displayName: '客户A' } }),
    getLongProfile: async () => '',
    getAccountId: () => 'local-account'
  }

  const request = await buildHanxiaomiReplyRequest({
    accountId: 'local-account',
    contactId: 'contact-a',
    contactName: '客户A',
    isFirstSuccessfulCall: false,
    currentContent: '真正触发的问题',
    bufferedMessages: [{
      msgId: 'current-buffered',
      content: '真正触发的问题',
      timestamp: 1700000100 * 1000,
      type: 1
    }],
    mode: 'auto',
    scenario: 'reply',
    identitySalt: 'salt',
    provider
  })

  assert.strictEqual(request.current_message.message_key, 'current-buffered')
  assert.strictEqual(request.request_meta.current_source, 'buffered_match')
  assert(!request.history.some(item => item.message_key === 'later-customer'))
}

async function testDifferentContactsDoNotShareHanxiaomiContextOrSession() {
  const contactMessages = {
    'contact-a': [
      message(1, { messageKey: 'a-old', parsedContent: 'A 的鼻翼泛红问题', isSend: 0 }),
      message(2, { messageKey: 'a-cur', parsedContent: 'A 想约欧笑医生', isSend: 0 })
    ],
    'contact-b': [
      message(3, { messageKey: 'b-old', parsedContent: 'B 问吃饭了吗', isSend: 0 }),
      message(4, { messageKey: 'b-cur', parsedContent: 'B 问刚聊了什么', isSend: 0 })
    ]
  }
  const provider = {
    getLatestMessages: async (contactId) => ({ success: true, messages: contactMessages[contactId] || [] }),
    getContact: async (contactId) => ({ contact: { displayName: contactId } }),
    getLongProfile: async (contactId) => contactId === 'contact-a' ? 'A 的长期画像' : 'B 的长期画像',
    getAccountId: () => 'local-account'
  }

  const requestA = await buildHanxiaomiReplyRequest({
    accountId: 'local-account',
    contactId: 'contact-a',
    contactName: '客户A',
    isFirstSuccessfulCall: false,
    currentContent: 'A 想约欧笑医生',
    bufferedMessages: [{ msgId: 'a-cur', content: 'A 想约欧笑医生', timestamp: 1700000002 * 1000, type: 1 }],
    mode: 'auto',
    scenario: 'reply',
    identitySalt: 'salt',
    provider
  })
  const requestB = await buildHanxiaomiReplyRequest({
    accountId: 'local-account',
    contactId: 'contact-b',
    contactName: '客户B',
    isFirstSuccessfulCall: false,
    currentContent: 'B 问刚聊了什么',
    bufferedMessages: [{ msgId: 'b-cur', content: 'B 问刚聊了什么', timestamp: 1700000004 * 1000, type: 1 }],
    mode: 'auto',
    scenario: 'reply',
    identitySalt: 'salt',
    provider
  })

  assert.notStrictEqual(requestA.subject_ref, requestB.subject_ref)
  assert.notStrictEqual(requestA.external_session_key, requestB.external_session_key)
  assert.notStrictEqual(requestA.request_meta.source_contact_hash, requestB.request_meta.source_contact_hash)
  assert.strictEqual(requestB.current_message.message_key, 'b-cur')
  assert(!requestB.history.some(item => String(item.content).includes('A 的')))
  assert(!String(requestB.long_profile || '').includes('A 的'))
}

async function testMediaFallbackAndPrivateOnly() {
  const provider = {
    getLatestMessages: async () => ({ success: true, messages: [message(1, { localType: 3, parsedContent: '', rawContent: '', isSend: 0 })] }),
    getContact: async () => ({}),
    getLongProfile: async () => '',
    getAccountId: () => 'account'
  }
  const request = await buildHanxiaomiReplyRequest({
    accountId: 'account',
    contactId: 'private-contact',
    contactName: '客户',
    isFirstSuccessfulCall: true,
    currentContent: '',
    bufferedMessages: [{ msgId: 'img-1', content: '', timestamp: Date.now(), type: 3 }],
    mode: 'auto',
    scenario: 'reply',
    identitySalt: 'salt',
    provider
  })
  assert.strictEqual(request.current_message.content, '[图片消息]')
  assert.strictEqual(request.current_message.content_type, 'image')
  await assert.rejects(
    () => buildHanxiaomiReplyRequest({
      accountId: 'account',
      contactId: 'room@chatroom',
      contactName: '群聊',
      isFirstSuccessfulCall: true,
      currentContent: 'hi',
      bufferedMessages: [{ msgId: 'm', content: 'hi', timestamp: Date.now(), type: 1 }],
      mode: 'auto',
      scenario: 'reply',
      identitySalt: 'salt',
      provider
    }),
    /仅支持私聊/
  )
}

function testLedgerSuccessfulContactDefinition() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hanxiaomi-ledger-'))
  const ledger = new HanxiaomiDeliveryLedger(path.join(temp, 'skills'))
  const base = {
    contactId: 'contact-a',
    contactName: '客户A',
    messageKey: 'm1',
    requestHash: 'hash',
    updatedAt: Date.now()
  }
  for (const status of ['draft', 'send_failed', 'skipped']) {
    ledger.upsert({ ...base, eventKey: `${status}:m1`, status })
  }
  assert.strictEqual(ledger.hasSuccessfulContact('contact-a'), false)
  ledger.upsert({ ...base, eventKey: 'sent:m1', status: 'sent' })
  assert.strictEqual(ledger.hasSuccessfulContact('contact-a'), true)
}

async function testReplyClientSignsRequest() {
  let captured = null
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      captured = { method: req.method, url: req.url, headers: req.headers, body }
      const canonical = [
        req.method,
        '/api/v1/channels/weflow/replies',
        req.headers['x-weflow-timestamp'],
        req.headers['x-weflow-nonce'],
        crypto.createHash('sha256').update(body).digest('hex')
      ].join('\n')
      const expected = crypto.createHmac('sha256', 'secret').update(canonical).digest('hex')
      assert.strictEqual(req.headers['x-weflow-body-sha256'], crypto.createHash('sha256').update(body).digest('hex'))
      assert.strictEqual(req.headers['x-weflow-signature'], `sha256=${expected}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        request_id: 'req-1',
        reply_to_message_key: 'm1',
        action: 'send',
        text: '你好，护理上先温和一点',
        segments: ['你好', '护理上先温和一点']
      }))
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = server.address().port
    const client = new HanxiaomiReplyClient({
      enabled: true,
      serviceUrl: `http://127.0.0.1:${port}`,
      keyId: 'kid1',
      signingSecret: 'secret',
      timeoutMs: 3000,
      identitySalt: 'salt'
    })
    const response = await client.createReply({
      account_ref: hashRef('salt', 'account:a'),
      subject_ref: hashRef('salt', 'subject:a:c'),
      external_session_key: hashRef('salt', 'session:a:c'),
      chat_type: 'private',
      mode: 'auto',
      scenario: 'reply',
      current_message: {
        message_key: 'm1',
        role: 'customer',
        timestamp: new Date().toISOString(),
        content: '你好',
        content_type: 'text'
      },
      history: [],
      contact: {},
      request_meta: { window_size: 50 }
    })
    assert.strictEqual(response.text, '你好，护理上先温和一点')
    assert.deepStrictEqual(response.segments, ['你好', '护理上先温和一点'])
    assert.strictEqual(captured.headers['x-weflow-key-id'], 'kid1')
    assert.strictEqual(captured.url, '/api/v1/channels/weflow/replies')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

async function testReplyClientRejectsOverLimitSegmentsToAvoidTruncation() {
  const server = http.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        request_id: 'req-overflow',
        reply_to_message_key: 'm1',
        action: 'send',
        text: 'complete text should be delivered as one message',
        segments: ['one', 'two', 'three', 'four', 'five', 'six']
      }))
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = server.address().port
    const client = new HanxiaomiReplyClient({
      enabled: true,
      serviceUrl: `http://127.0.0.1:${port}`,
      keyId: 'kid1',
      signingSecret: 'secret',
      timeoutMs: 3000,
      identitySalt: 'salt'
    })
    const response = await client.createReply({
      account_ref: hashRef('salt', 'account:a'),
      subject_ref: hashRef('salt', 'subject:a:c'),
      external_session_key: hashRef('salt', 'session:a:c'),
      chat_type: 'private',
      mode: 'auto',
      scenario: 'reply',
      current_message: {
        message_key: 'm1',
        role: 'customer',
        timestamp: new Date().toISOString(),
        content: 'hello',
        content_type: 'text'
      },
      history: [],
      contact: {},
      request_meta: { window_size: 50 }
    })
    assert.strictEqual(response.text, 'complete text should be delivered as one message')
    assert.strictEqual(response.segments, undefined)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

async function testOutboundQueueSerializesDelivery() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hanxiaomi-outbound-'))
  const baseDir = path.join(temp, 'skills')
  const sent = []
  const statuses = []
  const queue = new HanxiaomiOutboundQueue(baseDir, {
    sendText: async job => {
      sent.push(job.eventKey)
      return { success: true, delivered: true, senderId: 'test' }
    },
    onStatus: job => statuses.push(`${job.eventKey}:${job.status}`)
  }, {
    minDelayMs: 0,
    maxDelayMs: 0,
    postSendGapMsMin: 0,
    postSendGapMsMax: 0,
    perContactCooldownMs: 0,
    retryDelayMs: 0,
    staleAfterMs: 10000,
    typingMsPerCharMin: 0,
    typingMsPerCharMax: 0,
    maxTypingDelayMs: 0
  })

  queue.enqueue({
    eventKey: 'event-1',
    contactId: 'contact-a',
    contactName: '客户A',
    text: '第一条',
    action: 'send',
    generatedAt: Date.now(),
    triggerMessageTimestamp: Date.now(),
    receivedMessage: 'hi'
  })
  queue.enqueue({
    eventKey: 'event-2',
    contactId: 'contact-b',
    contactName: '客户B',
    text: '第二条',
    action: 'send',
    generatedAt: Date.now(),
    triggerMessageTimestamp: Date.now(),
    receivedMessage: 'hi'
  })

  await waitFor(() => sent.length === 2)
  assert.deepStrictEqual(sent, ['event-1', 'event-2'])
  assert(statuses.includes('event-1:sent'))
  assert(statuses.includes('event-2:sent'))
}

async function testOutboundQueueUsesBackendSegmentsWithoutLocalSplitting() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hanxiaomi-split-'))
  const baseDir = path.join(temp, 'skills')
  const sent = []
  const queue = new HanxiaomiOutboundQueue(baseDir, {
    sendText: async job => {
      sent.push({
        eventKey: job.eventKey,
        parentEventKey: job.parentEventKey,
        text: job.text,
        fullText: job.fullText,
        partIndex: job.partIndex,
        partTotal: job.partTotal
      })
      return { success: true, delivered: true, senderId: 'test' }
    }
  }, {
    minDelayMs: 0,
    maxDelayMs: 0,
    postSendGapMsMin: 0,
    postSendGapMsMax: 0,
    perContactCooldownMs: 0,
    retryDelayMs: 0,
    staleAfterMs: 10000,
    typingMsPerCharMin: 0,
    typingMsPerCharMax: 0,
    maxTypingDelayMs: 0,
    splitMinGapMs: 0,
    splitMaxGapMs: 0
  })

  const segments = [
    '先别着急',
    '最近长痘可以先把清洁和保湿做简单一点',
    '白天防晒也要跟上',
    '反复红肿的话建议面诊看一下诱因'
  ]
  queue.enqueue({
    eventKey: 'event-human',
    contactId: 'contact-a',
    contactName: '客户A',
    text: '先别着急。最近长痘可以先把清洁和保湿做简单一点。白天防晒也要跟上，反复红肿的话建议面诊看一下诱因。',
    segments,
    action: 'send',
    generatedAt: Date.now(),
    triggerMessageTimestamp: Date.now(),
    receivedMessage: '长痘怎么办'
  })

  await waitFor(() => sent.length === 4)
  assert(sent.every(item => item.parentEventKey === 'event-human'))
  assert.deepStrictEqual(sent.map(item => item.partIndex), sent.map((_, index) => index + 1))
  assert.deepStrictEqual(sent.map(item => item.text), segments)
  assert(sent.every(item => item.fullText.includes('先别着急')))
}

async function testOutboundQueueSendsFullTextAsOneMessageWhenSegmentsMissing() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hanxiaomi-split-overflow-'))
  const baseDir = path.join(temp, 'skills')
  const sent = []
  const queue = new HanxiaomiOutboundQueue(baseDir, {
    sendText: async job => {
      sent.push(job.text)
      return { success: true, delivered: true, senderId: 'test' }
    }
  }, {
    minDelayMs: 0,
    maxDelayMs: 0,
    postSendGapMsMin: 0,
    postSendGapMsMax: 0,
    perContactCooldownMs: 0,
    retryDelayMs: 0,
    staleAfterMs: 10000,
    typingMsPerCharMin: 0,
    typingMsPerCharMax: 0,
    maxTypingDelayMs: 0,
    splitMinGapMs: 0,
    splitMaxGapMs: 0
  })
  const fullText = '第一句很长也不要在 WeFlow 本地硬切。第二句继续保留在同一条完整文本里。第三句也不能因为本地最大分段数被截断。'

  queue.enqueue({
    eventKey: 'event-overflow',
    contactId: 'contact-a',
    contactName: '客户A',
    text: fullText,
    action: 'send',
    generatedAt: Date.now(),
    triggerMessageTimestamp: Date.now(),
    receivedMessage: 'hi'
  })

  await waitFor(() => sent.length === 1)
  assert.deepStrictEqual(sent, [fullText])
}

async function testOutboundQueueFallsBackToFullTextWhenBackendSegmentsOverflow() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hanxiaomi-split-overflow-segments-'))
  const baseDir = path.join(temp, 'skills')
  const sent = []
  const queue = new HanxiaomiOutboundQueue(baseDir, {
    sendText: async job => {
      sent.push({
        eventKey: job.eventKey,
        parentEventKey: job.parentEventKey,
        text: job.text,
        partIndex: job.partIndex,
        partTotal: job.partTotal
      })
      return { success: true, delivered: true, senderId: 'test' }
    }
  }, {
    minDelayMs: 0,
    maxDelayMs: 0,
    postSendGapMsMin: 0,
    postSendGapMsMax: 0,
    perContactCooldownMs: 0,
    retryDelayMs: 0,
    staleAfterMs: 10000,
    typingMsPerCharMin: 0,
    typingMsPerCharMax: 0,
    maxTypingDelayMs: 0,
    splitMinGapMs: 0,
    splitMaxGapMs: 0
  })
  const fullText = 'complete text must not be truncated when backend returns too many segments'

  queue.enqueue({
    eventKey: 'event-overflow-segments',
    contactId: 'contact-a',
    contactName: 'customer-a',
    text: fullText,
    segments: ['one', 'two', 'three', 'four', 'five', 'six'],
    action: 'send',
    generatedAt: Date.now(),
    triggerMessageTimestamp: Date.now(),
    receivedMessage: 'hi'
  })

  await waitFor(() => sent.length === 1)
  assert.deepStrictEqual(sent, [{
    eventKey: 'event-overflow-segments',
    parentEventKey: undefined,
    text: fullText,
    partIndex: undefined,
    partTotal: undefined
  }])
}

function testSplitStalenessAllowsOutboundMessagesAfterSequenceStarts() {
  const now = Date.now()
  const job = {
    contactId: 'contact-a',
    parentEventKey: 'event-split',
    partIndex: 2,
    partTotal: 3
  }
  const latestText = extractHanxiaomiMessageText({
    parsedContent: '之前聊到你鼻翼泛红、出油，'
  })
  const recentSelfSent = new Map([
    ['contact-a:之前聊到你鼻翼泛红、出油，', now - 1000]
  ])
  assert.strictEqual(
    isOwnPreviousHanxiaomiSplitPart(job, latestText, recentSelfSent.entries(), now),
    true
  )

  const manualOperatorSent = new Map()
  assert.strictEqual(
    shouldIgnoreOperatorOutboundForHanxiaomiSplitContinuation(job),
    true
  )
  assert.strictEqual(
    isOwnPreviousHanxiaomiSplitPart(job, '我人工已经回了', manualOperatorSent.entries(), now),
    false
  )

  assert.strictEqual(
    isOwnPreviousHanxiaomiSplitPart({ ...job, partIndex: 1 }, latestText, recentSelfSent.entries(), now),
    false
  )
  assert.strictEqual(
    shouldIgnoreOperatorOutboundForHanxiaomiSplitContinuation({ ...job, partIndex: 1 }),
    false
  )
}

function testRecentAutoReplyDetectionMatchesOwnOutboundText() {
  const now = Date.now()
  const recentSelfSent = new Map([
    ['contact-a:之前聊到鼻翼泛红、出油', now - 1000]
  ])
  assert.strictEqual(
    isRecentHanxiaomiAutoReplyText('contact-a', '之前聊到鼻翼泛红、出油', recentSelfSent.entries(), now),
    true
  )
  assert.strictEqual(
    isRecentHanxiaomiAutoReplyText('contact-a', '完全不同的内容', recentSelfSent.entries(), now),
    false
  )
}

async function testOutboundQueueDoesNotDelayFreshTurnWithFullCooldown() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hanxiaomi-fresh-turn-'))
  const baseDir = path.join(temp, 'skills')
  const sent = []
  const queue = new HanxiaomiOutboundQueue(baseDir, {
    sendText: async job => {
      sent.push({
        eventKey: job.eventKey,
        text: job.text,
        triggerMessageTimestamp: job.triggerMessageTimestamp
      })
      return { success: true, delivered: true, senderId: 'test' }
    }
  }, {
    minDelayMs: 0,
    maxDelayMs: 0,
    postSendGapMsMin: 0,
    postSendGapMsMax: 0,
    perContactCooldownMs: 60000,
    retryDelayMs: 0,
    staleAfterMs: 10000,
    typingMsPerCharMin: 0,
    typingMsPerCharMax: 0,
    maxTypingDelayMs: 0,
    splitMinGapMs: 0,
    splitMaxGapMs: 0
  })

  queue.enqueue({
    eventKey: 'event-turn-1',
    contactId: 'contact-a',
    contactName: '瀹㈡埛A',
    text: '第一条自动回复',
    action: 'send',
    generatedAt: Date.now(),
    triggerMessageTimestamp: Date.now(),
    receivedMessage: 'hi'
  })
  await waitFor(() => sent.length === 1)

  queue.enqueue({
    eventKey: 'event-turn-2',
    contactId: 'contact-a',
    contactName: '瀹㈡埛A',
    text: '第二条自动回复',
    action: 'send',
    generatedAt: Date.now(),
    triggerMessageTimestamp: Date.now() + 5,
    receivedMessage: 'hello again'
  })

  await waitFor(() => sent.length === 2)
  assert.strictEqual(sent[0].eventKey, 'event-turn-1')
  assert.strictEqual(sent[1].eventKey, 'event-turn-2')
}

async function testOutboundQueueNormalizesSecondTimestampsBeforeDelivery() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hanxiaomi-second-ts-'))
  const baseDir = path.join(temp, 'skills')
  const sent = []
  const triggerSeconds = Math.floor(Date.now() / 1000) - 1
  const generatedSeconds = Math.floor(Date.now() / 1000)
  const queue = new HanxiaomiOutboundQueue(baseDir, {
    sendText: async job => {
      sent.push({
        eventKey: job.eventKey,
        generatedAt: job.generatedAt,
        triggerMessageTimestamp: job.triggerMessageTimestamp
      })
      return { success: true, delivered: true, senderId: 'test' }
    }
  }, {
    minDelayMs: 0,
    maxDelayMs: 0,
    postSendGapMsMin: 0,
    postSendGapMsMax: 0,
    perContactCooldownMs: 0,
    retryDelayMs: 0,
    staleAfterMs: 10000,
    typingMsPerCharMin: 0,
    typingMsPerCharMax: 0,
    maxTypingDelayMs: 0,
    splitMinGapMs: 0,
    splitMaxGapMs: 0
  })

  queue.enqueue({
    eventKey: 'event-second-ts',
    contactId: 'contact-a',
    contactName: '瀹㈡埛A',
    text: 'hello',
    action: 'send',
    generatedAt: generatedSeconds,
    triggerMessageTimestamp: triggerSeconds,
    receivedMessage: 'hi'
  })

  await waitFor(() => sent.length === 1)
  assert.strictEqual(sent[0].eventKey, 'event-second-ts')
  assert.strictEqual(sent[0].generatedAt, generatedSeconds * 1000)
  assert.strictEqual(sent[0].triggerMessageTimestamp, triggerSeconds * 1000)
}

async function testOutboundQueueSkipsStaleReply() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hanxiaomi-stale-'))
  const baseDir = path.join(temp, 'skills')
  let sendCount = 0
  const statuses = []
  const queue = new HanxiaomiOutboundQueue(baseDir, {
    sendText: async () => {
      sendCount++
      return { success: true, delivered: true, senderId: 'test' }
    },
    shouldSkip: async () => 'customer sent a newer message before delivery',
    onStatus: job => statuses.push(job.status)
  }, {
    minDelayMs: 0,
    maxDelayMs: 0,
    postSendGapMsMin: 0,
    postSendGapMsMax: 0,
    perContactCooldownMs: 0,
    retryDelayMs: 0,
    staleAfterMs: 10000,
    typingMsPerCharMin: 0,
    typingMsPerCharMax: 0,
    maxTypingDelayMs: 0
  })
  queue.enqueue({
    eventKey: 'event-stale',
    contactId: 'contact-a',
    contactName: '客户A',
    text: '旧回复',
    action: 'send',
    generatedAt: Date.now(),
    triggerMessageTimestamp: Date.now(),
    receivedMessage: 'hi'
  })
  await waitFor(() => statuses.includes('superseded'))
  assert.strictEqual(sendCount, 0)
}

async function testOutboundQueueCancelsRemainingSplitPartsWhenStale() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hanxiaomi-split-stale-'))
  const baseDir = path.join(temp, 'skills')
  let sendCount = 0
  const statuses = []
  const queue = new HanxiaomiOutboundQueue(baseDir, {
    sendText: async () => {
      sendCount++
      return { success: true, delivered: true, senderId: 'test' }
    },
    shouldSkip: async () => 'customer sent a newer message before delivery',
    onStatus: job => statuses.push(`${job.eventKey}:${job.status}`)
  }, {
    minDelayMs: 0,
    maxDelayMs: 0,
    postSendGapMsMin: 0,
    postSendGapMsMax: 0,
    perContactCooldownMs: 0,
    retryDelayMs: 0,
    staleAfterMs: 10000,
    typingMsPerCharMin: 0,
    typingMsPerCharMax: 0,
    maxTypingDelayMs: 0,
    splitMinGapMs: 0,
    splitMaxGapMs: 0
  })

  queue.enqueue({
    eventKey: 'event-split-stale',
    contactId: 'contact-a',
    contactName: '客户A',
    text: '第一段很长需要拆开，客户又发新消息以后就不能继续发。第二段也会被取消，不然看起来像机器人还在自说自话。第三段同样不能继续发送，避免旧回复干扰新的对话节奏。',
    segments: [
      '第一段先说明护理方向',
      '第二段会被取消',
      '第三段也不能继续发送'
    ],
    action: 'send',
    generatedAt: Date.now(),
    triggerMessageTimestamp: Date.now(),
    receivedMessage: 'hi'
  })
  await waitFor(() => statuses.filter(item => item.includes(':superseded')).length >= 2)
  assert.strictEqual(sendCount, 0)
}

async function testOutboundQueueRecoversInterruptedSendingJobs() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hanxiaomi-interrupted-'))
  const baseDir = path.join(temp, 'skills')
  const queueFile = path.join(temp, 'hanxiaomi-queue.json')
  const now = Date.now()
  const parentEventKey = 'event-interrupted'

  fs.writeFileSync(queueFile, JSON.stringify({
    outbound: {
      part1: {
        jobId: 'part1',
        eventKey: `${parentEventKey}:part:1`,
        contactId: 'contact-a',
        contactName: 'customer-a',
        text: 'first part',
        fullText: 'first part second part',
        action: 'send',
        status: 'sending',
        sendAfter: now - 1000,
        attempts: 1,
        createdAt: now - 2000,
        updatedAt: now - 1000,
        generatedAt: now - 2000,
        triggerMessageTimestamp: now - 3000,
        parentEventKey,
        partIndex: 1,
        partTotal: 2
      },
      part2: {
        jobId: 'part2',
        eventKey: `${parentEventKey}:part:2`,
        contactId: 'contact-a',
        contactName: 'customer-a',
        text: 'second part',
        fullText: 'first part second part',
        action: 'send',
        status: 'queued',
        sendAfter: now,
        attempts: 0,
        createdAt: now - 2000,
        updatedAt: now - 1000,
        generatedAt: now - 2000,
        triggerMessageTimestamp: now - 3000,
        parentEventKey,
        partIndex: 2,
        partTotal: 2
      }
    }
  }), 'utf-8')

  let sendCount = 0
  new HanxiaomiOutboundQueue(baseDir, {
    sendText: async () => {
      sendCount++
      return { success: true, delivered: true, senderId: 'test' }
    }
  }, {
    minDelayMs: 0,
    maxDelayMs: 0,
    postSendGapMsMin: 0,
    postSendGapMsMax: 0,
    perContactCooldownMs: 0,
    retryDelayMs: 0,
    staleAfterMs: 10000,
    typingMsPerCharMin: 0,
    typingMsPerCharMax: 0,
    maxTypingDelayMs: 0,
    splitMinGapMs: 0,
    splitMaxGapMs: 0
  })

  await waitFor(() => {
    const parsed = JSON.parse(fs.readFileSync(queueFile, 'utf-8'))
    return parsed.outbound.part1.status === 'failed' &&
      parsed.outbound.part2.status === 'cancelled'
  })

  const parsed = JSON.parse(fs.readFileSync(queueFile, 'utf-8'))
  assert.strictEqual(parsed.outbound.part1.lastError, 'delivery was interrupted before confirmation')
  assert.strictEqual(parsed.outbound.part2.lastError, 'delivery was interrupted before confirmation')
  assert.strictEqual(sendCount, 0)
}

async function testDeliveryLedgerRecoversFromEmptyFile() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hanxiaomi-empty-ledger-'))
  const baseDir = path.join(temp, 'skills')
  const ledgerFile = path.join(temp, 'hanxiaomi-delivery-ledger.json')
  fs.writeFileSync(ledgerFile, '', 'utf-8')

  const ledger = new HanxiaomiDeliveryLedger(baseDir)
  ledger.upsert({
    eventKey: 'event-ledger-recovery',
    contactId: 'contact-a',
    contactName: 'customer-a',
    messageKey: 'message-a',
    requestHash: 'hash-a',
    action: 'send',
    text: 'hello',
    status: 'sent',
    updatedAt: Date.now()
  })

  await waitFor(() => {
    const raw = fs.readFileSync(ledgerFile, 'utf-8')
    if (!raw.trim()) return false
    const parsed = JSON.parse(raw)
    return parsed.entries?.['event-ledger-recovery']?.status === 'sent'
  })
}

async function testInboundQueueSerializesSameContact() {
  const started = []
  const finished = []
  const queue = new HanxiaomiInboundQueue({
    concurrency: 3,
    handler: async job => {
      started.push(job.jobId)
      await new Promise(resolve => setTimeout(resolve, 20))
      finished.push(job.jobId)
    }
  })
  queue.enqueue('contact-a', '客户A', { index: 1 })
  queue.enqueue('contact-a', '客户A', { index: 2 })
  queue.enqueue('contact-b', '客户B', { index: 3 })
  await waitFor(() => finished.length === 3)
  assert.strictEqual(finished[0], started[0])
  assert(started.length === 3)
}

function testDeliveryPolicyNormalizesConfiguredValues() {
  const defaultPolicy = mergeDeliveryPolicy()
  assert.strictEqual(defaultPolicy.splitMinGapMs, 2500)
  assert.strictEqual(defaultPolicy.splitMaxGapMs, 8000)

  const zeroPolicy = mergeDeliveryPolicy({
    minDelayMs: 0,
    maxDelayMs: 0,
    postSendGapMsMin: 0,
    postSendGapMsMax: 0,
    perContactCooldownMs: 0,
    retryDelayMs: 0,
    staleAfterMs: 0,
    typingMsPerCharMin: 0,
    typingMsPerCharMax: 0,
    maxTypingDelayMs: 0
  })
  assert.strictEqual(zeroPolicy.minDelayMs, 0)
  assert.strictEqual(zeroPolicy.maxDelayMs, 0)
  assert.strictEqual(zeroPolicy.postSendGapMsMin, 0)
  assert.strictEqual(zeroPolicy.postSendGapMsMax, 0)
  assert.strictEqual(zeroPolicy.perContactCooldownMs, 0)
  assert.strictEqual(zeroPolicy.retryDelayMs, 0)
  assert.strictEqual(zeroPolicy.staleAfterMs, 1000)

  const invertedPolicy = mergeDeliveryPolicy({
    minDelayMs: 45000,
    maxDelayMs: 8000,
    postSendGapMsMin: 25000,
    postSendGapMsMax: 8000,
    typingMsPerCharMin: 180,
    typingMsPerCharMax: 80
  })
  assert.strictEqual(invertedPolicy.maxDelayMs, 45000)
  assert.strictEqual(invertedPolicy.postSendGapMsMax, 25000)
  assert.strictEqual(invertedPolicy.typingMsPerCharMax, 180)
}

function testMessagePushSameTimestampRecoverySelection() {
  const messages = ['old-same-second', 'new-same-second']
  assert.deepStrictEqual(
    selectSameTimestampIncomingMessages(messages, 0, false),
    []
  )
  assert.deepStrictEqual(
    selectSameTimestampIncomingMessages(messages, 1, false),
    ['new-same-second']
  )
  assert.deepStrictEqual(
    selectSameTimestampIncomingMessages(messages, 0, true),
    messages
  )
}

function testMessagePushRequiresActualSseDeliveryBeforeCommit() {
  assert.strictEqual(
    isMessagePushDeliveryCommitted({ eventId: 1, clientCount: 0, sentCount: 0, failedCount: 0 }),
    false
  )
  assert.strictEqual(
    isMessagePushDeliveryCommitted({ eventId: 2, clientCount: 1, sentCount: 0, failedCount: 1 }),
    false
  )
  assert.strictEqual(
    isMessagePushDeliveryCommitted({ eventId: 3, clientCount: 2, sentCount: 1, failedCount: 1 }),
    true
  )
}

async function main() {
  await testContextWindowsAndCurrentDedup()
  await testCurrentMessageIsBoundToBufferedMessageNotLatestInboundGuess()
  await testDifferentContactsDoNotShareHanxiaomiContextOrSession()
  await testMediaFallbackAndPrivateOnly()
  testLedgerSuccessfulContactDefinition()
  await testReplyClientSignsRequest()
  await testReplyClientRejectsOverLimitSegmentsToAvoidTruncation()
  await testOutboundQueueSerializesDelivery()
  await testOutboundQueueUsesBackendSegmentsWithoutLocalSplitting()
  await testOutboundQueueSendsFullTextAsOneMessageWhenSegmentsMissing()
  await testOutboundQueueFallsBackToFullTextWhenBackendSegmentsOverflow()
  testSplitStalenessAllowsOutboundMessagesAfterSequenceStarts()
  testRecentAutoReplyDetectionMatchesOwnOutboundText()
  await testOutboundQueueDoesNotDelayFreshTurnWithFullCooldown()
  await testOutboundQueueNormalizesSecondTimestampsBeforeDelivery()
  await testOutboundQueueSkipsStaleReply()
  await testOutboundQueueCancelsRemainingSplitPartsWhenStale()
  await testOutboundQueueRecoversInterruptedSendingJobs()
  await testDeliveryLedgerRecoversFromEmptyFile()
  await testInboundQueueSerializesSameContact()
  testDeliveryPolicyNormalizesConfiguredValues()
  testMessagePushSameTimestampRecoverySelection()
  testMessagePushRequiresActualSseDeliveryBeforeCommit()
  console.log('Hanxiaomi channel tests passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
