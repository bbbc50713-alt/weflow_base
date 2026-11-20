const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const Module = require('node:module')

const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weflow-history-test-'))
const state = { owner: 'wxid_owner', rows: [], cursors: new Map(), cursor: 0, session: 'wxid_friend' }
const oldFetch = global.fetch
const oldMock = global.__historyMock
let uploads = 0
let failUpload = false, slow = false, inFlight = 0, peak = 0
const serverRows = new Map()
const receipts = new Map()
let runStatus = 'running'

function row(id, time = 1577836800, self = false) {
  return { local_id: id, server_id: (9223372036854775700n + BigInt(id)).toString(), local_type: 1,
    create_time: time, sort_seq: time * 1000 + id, is_send: self ? 1 : 0,
    sender_username: self ? state.owner : state.session, message_content: '好的', _db_path: 'C:/wechat/message_0.db', table_name: 'Msg_abc' }
}

function map(raw) {
  return { localId: raw.local_id, serverId: Number(raw.server_id), serverIdRaw: raw.server_id, localType: raw.local_type,
    createTime: raw.create_time, sortSeq: raw.sort_seq, isSend: raw.is_send, senderUsername: raw.sender_username,
    rawContent: raw.message_content, parsedContent: raw.message_content, content: raw.message_content, messageKey: `k${raw.local_id}` }
}

global.__historyMock = {
  electron: { app: { getPath: () => dir }, BrowserWindow: { getAllWindows: () => [] },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: data => data.toString() } },
  config: { ConfigService: { getInstance: () => ({ getMyWxidCleaned: () => state.owner }) } },
  chat: { chatService: {
    getSessions: async () => ({ success: true, sessions: [{ username: state.session, displayName: '测试会话' }] }),
    getContact: async () => ({ username: state.session, nickName: '测试会话' }), mapRowsToMessagesForApi: rows => rows.map(map),
  } },
  wcdb: { wcdbService: {
    openMessageCursor: async (session, size, asc, start, end) => {
      const id = ++state.cursor
      state.cursors.set(id, [...state.rows].filter(r => r.create_time >= start && r.create_time <= end).sort((a, b) => a.create_time - b.create_time || a.local_id - b.local_id))
      return { success: true, cursor: id }
    },
    fetchMessageBatch: async id => ({ success: true, rows: state.cursors.get(id).splice(0, 200), hasMore: state.cursors.get(id).length > 0 }),
    closeMessageCursor: async id => { state.cursors.delete(id) }, getGroupMembers: async () => ({ success: true, members: [] }),
  } },
  media: { ExportContext: class { async exportMediaForMessage() { return null } } },
}

global.fetch = async (url, options) => {
  const pathname = new URL(url).pathname
  const body = options.body ? JSON.parse(options.body) : undefined
  let data
  if (pathname.endsWith('/bindings') && options.method === 'POST') {
    data = { id: 1, tenant_id: 11, tenant_name: '测试租户', channel_account_id: 29, account_name: '测试微信', account_wxid: state.owner, account_status: 'unbound', token: 'only-a-test-token' }
  } else if (pathname.endsWith('/bindings/current')) data = { conflicts: [], binding: {} }
  else if (pathname.endsWith('/runs') && options.method === 'POST') { data = { id: 'run-1', status: 'running' }; runStatus = 'running' }
  else if (pathname.endsWith('/batches')) {
    if (slow) { inFlight++; peak = Math.max(peak, inFlight); await new Promise(r => setTimeout(r, 15)); inFlight-- }
    if (failUpload) throw new TypeError('fetch failed')
    if (receipts.has(body.batch_id)) data = receipts.get(body.batch_id)
    else {
      uploads++
      const items = body.messages.map(m => {
        const key = body.session.wxid + ':' + m.source_key
        const outcome = serverRows.has(key) ? 'existing' : 'inserted'
        serverRows.set(key, m)
        return { source_key: m.source_key, message_id: serverRows.size, outcome, media_status: 'none' }
      })
      data = { inserted: items.filter(x => x.outcome === 'inserted').length, existing: items.filter(x => x.outcome === 'existing').length, failed: 0, items }
      receipts.set(body.batch_id, data)
    }
  } else if (pathname.endsWith('/reconcile')) {
    const missing = body.source_keys.filter(k => !serverRows.has(body.session_wxid + ':' + k))
    data = { expected: body.source_keys.length, matched: body.source_keys.length - missing.length, missing }
  } else if (options.method === 'PATCH') {
    runStatus = body.action === 'finish' ? 'completed' : body.action === 'pause' ? 'paused' : 'running'
    data = { status: runStatus }
  } else data = { status: runStatus }
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function load() {
  const result = await esbuild.build({ absWorkingDir: root, entryPoints: ['electron/services/history-sync/HistorySyncService.ts'], bundle: true,
    platform: 'node', format: 'cjs', write: false, plugins: [{ name: 'history-mocks', setup(build) {
      const mapping = { electron: 'electron', '../config': 'config', '../chatService': 'chat', '../wcdbService': 'wcdb', '../export/core/ExportContext': 'media' }
      build.onResolve({ filter: /^(electron|\.\.\/(config|chatService|wcdbService|export\/core\/ExportContext))$/ }, args => ({ path: mapping[args.path], namespace: 'mock' }))
      build.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: `module.exports=global.__historyMock[${JSON.stringify(args.path)}]`, loader: 'js' }))
    } }] })
  const mod = new Module(path.join(root, 'scripts', 'history-test-bundle.cjs'))
  mod.filename = path.join(root, 'scripts', 'history-test-bundle.cjs'); mod.paths = module.paths
  mod._compile(result.outputFiles[0].text, mod.filename)
  return mod.exports
}

async function settle(service) {
  for (let n = 0; n < 500; n++) {
    if (!service.busy && !service.mediaBusy) return
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('background import did not settle')
}

(async () => {
  try {
    const built = await esbuild.build({absWorkingDir:root,entryPoints:['electron/services/history-sync/adaptivePool.ts'],bundle:true,platform:'node',format:'cjs',write:false})
    const poolModule = new Module('adaptive-limit-test',module)
    poolModule._compile(built.outputFiles[0].text,'adaptive-limit-test.cjs')
    const {AdaptiveLimit,runPool} = poolModule.exports
    const regulator = new AdaptiveLimit()
    assert.equal(regulator.limit,9)
    for(let i=0;i<10;i++)regulator.sample('high')
    assert.equal(regulator.limit,6)
    for(let i=0;i<35;i++)regulator.sample('low')
    assert.equal(regulator.limit,16)
    const adaptive=new AdaptiveLimit(), gates=[], seen=new Set(), peakLimits=[]
    const queued=runPool(Array.from({length:32},(_,i)=>i),async i=>{
      seen.add(i); await new Promise(resolve=>gates.push(resolve))
    },()=>true,adaptive,(limit,active)=>peakLimits.push([limit,active]),()=> 'high',2)
    await new Promise(r=>setTimeout(r,40))
    assert.equal(adaptive.limit,6);assert.equal(gates.length,9)
    gates.splice(0,3).forEach(r=>r());await new Promise(r=>setTimeout(r,4))
    assert.equal(seen.size,9,'no replacements while above or at reduced limit')
    while(seen.size<32 || gates.length){ gates.splice(0).forEach(r=>r());await new Promise(r=>setTimeout(r,1)) }
    await queued; assert.equal(seen.size,32)
    const { HistorySyncService } = await load()
    const svc = new HistorySyncService()
    await svc.bind('http://127.0.0.1:8100', 'test-binding-code-long-enough')
    assert.equal(svc.status().binding.channel_account_id, 29)
    assert.equal('encryptedToken' in svc.status(), false)
    state.rows = [row(1), row(2, 1577836800, true)]
    await svc.start({ sessions: [], start: 0, end: 0, media: false, continuous: true }); await settle(svc)
    assert.equal(serverRows.size, 2)
    assert.equal([...serverRows.values()][0].server_id, '9223372036854775701')
    assert.equal([...serverRows.values()][1].direction, 'outbound')
    await svc.tick(); await settle(svc)
    assert.equal(serverRows.size, 2)
    await svc.pause()
    const restored = new HistorySyncService(); assert.equal(restored.status().status, 'paused')
    await restored.tick(); assert.equal(serverRows.size, 2)
    // Changed owner cannot resume a different account's import.
    state.owner = 'wxid_other'
    await assert.rejects(() => restored.resume(), /不同/)
    state.owner = 'wxid_owner'
    state.rows.push(row(3, 1577836801))
    failUpload = true
    await restored.resume(); await settle(restored)
    assert.equal(restored.status().status, 'offline')
    assert.equal(fs.readdirSync(path.join(dir, 'history-sync')).some(f => /^batch.*\.json$/.test(f)), true)
    failUpload = false
    const restarted = new HistorySyncService(); restarted.status(); await restarted.resume(); await settle(restarted)
    assert.equal(serverRows.size, 3)
    assert.equal(fs.readdirSync(path.join(dir, 'history-sync')).some(f => /^batch.*\.json$/.test(f)), false)
    // Old phone history arriving behind the watermark is found by daily reconciliation.
    state.rows.push(row(4, 946684800))
    await assert.rejects(() => restarted.rescan(), /暂停/)
    await restarted.pause()
    await restarted.rescan(); await settle(restarted)
    assert.equal(serverRows.size, 4)
    await restarted.pause()
    const getSessions = global.__historyMock.chat.chatService.getSessions
    global.__historyMock.chat.chatService.getSessions = async () => ({ success: false, error: '错误码: -101' })
    await restarted.resume(); await settle(restarted)
    assert.equal(restarted.status().status, 'paused')
    assert.match(restarted.status().error, /读取组件/)
    assert.equal(serverRows.size, 4)
    global.__historyMock.chat.chatService.getSessions = getSessions
    state.rows = [row(10), {...row(11), local_type:3}, {...row(12), local_type:43}, {...row(13), local_type:47},
      {...row(14), local_type:49, message_content:'<type>6</type>'}, {...row(15), local_type:49, message_content:'<type>33</type>'}]
    const options = { sessions: [], start:0, end:0, media:false, continuous:true }
    await assert.rejects(() => restarted.start({...options,kinds:[]}), /至少选择/)
    for (const [kinds, ids] of [[['text'],['10']], [['image','video'],['11','12']], [['file','other'],['14','15']], [['emoji'],['13']]]) {
      serverRows.clear()
      await restarted.start({...options,kinds}); await settle(restarted)
      assert.deepEqual([...serverRows.values()].map(m=>m.local_id),ids)
      assert.deepEqual(new HistorySyncService().status().options.kinds.sort(),[...kinds].sort())
      await restarted.pause()
    }
    // Four independent session streams: preview must be read-only and count just the selected date/type.
    global.__historyMock.chat.chatService.getSessions = async () => ({success:true,sessions:['p1','p2','p3','g@chatroom'].map(username=>({username,displayName:username}))})
    state.rows = [row(21),{...row(22),local_type:43},row(23,1577836900)]
    const scoped = {...options,start:1577836800,end:1577836810,kinds:['text']}
    const before = uploads
    const preview = await restarted.preview(scoped)
    assert.equal(preview.length,4); assert(preview.every(p => p.total===1)); assert.equal(uploads,before)
    slow=true; failUpload=true
    await restarted.start(scoped); await settle(restarted)
    assert.equal(peak,4)
    assert.equal(fs.readdirSync(path.join(dir,'history-sync')).filter(f=>f.startsWith('batch-')).length,4)
    failUpload=false
    const recovered = new HistorySyncService(); recovered.status(); await recovered.resume(); await settle(recovered)
    assert.equal(recovered.status().progressPhase,'done')
    assert(recovered.status().sessionProgress.every(p => p.total===1 && p.processed===1 && p.phase==='done'))
    assert.equal([...serverRows.values()].filter(m=>m.local_id==='21').length,4)
    assert(!fs.readdirSync(path.join(dir,'history-sync')).some(f=>f.startsWith('batch-')))
    await recovered.pause()
    const wc = global.__historyMock.wcdb.wcdbService
    wc.getSessionMessageTypeStats = async id => ({success:true,data:{type_counts:id === 'p3' ? {1:5} : {1:5,43:1},total_messages:id === 'p3' ? 5 : 6}})
    const open = wc.openMessageCursor, fetch = wc.fetchMessageBatch
    const broken = new Set()
    wc.openMessageCursor = async (...args) => {
      assert.deepEqual(args[5],[43])
      const cursor = await open(...args)
      state.cursors.set(cursor.cursor,state.cursors.get(cursor.cursor).filter(r=>r.local_type===43))
      if (args[0]==='p1') broken.add(cursor.cursor)
      return cursor
    }
    wc.fetchMessageBatch = async c => broken.has(c) ? {success:false,error:'测试分片读取失败'} : fetch(c)
    const readBefore = state.cursor
    const videoOpts = {...scoped,kinds:['video'],continuous:false}
    assert.deepEqual((await recovered.preview(videoOpts)).map(r=>r.total),[1,1,0,1])
    assert.equal(state.cursor,readBefore,'counting video should not open a message-body cursor')
    await recovered.start(videoOpts); await settle(recovered)
    const tasks = recovered.status().sessionProgress
    assert.deepEqual(tasks.map(t=>t.phase),['failed','done','skipped','done'])
    assert.match(tasks[0].issue,/分片/); assert.equal(tasks[1].inserted,1)
    assert.equal(recovered.status().status,'partial')
    global.__historyMock.chat.chatService.getSessions = async () => { throw Error('must not enumerate account for selected IDs') }
    let release
    const gate = new Promise(r=>{release=r}), events=[]
    wc.getSessionMessageTypeStats = async id => {
      if(id==='slow') await gate
      if(id==='broken') throw Error('sample count failure')
      return {success:true,data:{type_counts:{43:1},total_messages:1}}
    }
    let notified
    const first = new Promise(r=>{notified=r})
    const pending = recovered.preview({...videoOpts,sessions:['slow','fast','broken']},(row,total)=>{
      events.push(row);assert.equal(total,3);notified()
    })
    await first; assert(events.some(r=>r.id!=='slow')); release()
    const final = await pending
    assert.equal(final.find(r=>r.id==='broken').phase,'failed')
    assert.equal(final.find(r=>r.id==='slow').total,1)
    // Restart halfway through a peer at a same-second boundary. A finished peer must not reopen.
    const peerA='checkpoint-short',peerB='checkpoint-long',same=1577836800
    let blocked=true, recoveredOpens=[], sent=[]
    wc.getSessionMessageTypeStats=async id=>({success:true,data:{type_counts:{1:id===peerA?1:5},total_messages:id===peerA?1:5}})
    wc.openMessageCursor=async (id,size,asc,start,end)=>{
      const cursor=++state.cursor
      if (!blocked) recoveredOpens.push([id,start])
      state.cursors.set(cursor,{id,rows:(id===peerA?[row(800,same)]:[row(810,same-2),row(811,same),row(812,same),row(813,same),row(814,same+1)]).filter(r=>r.create_time>=start && r.create_time<=end)})
      return {success:true,cursor}
    }
    wc.fetchMessageBatch=async cursor=>{
      const stream=state.cursors.get(cursor), rows=stream.rows.splice(0,2)
      return {success:true,rows,hasMore:!!stream.rows.length}
    }
    const beforeFetch=global.fetch
    global.fetch=async(url,opts)=>{
      if(new URL(url).pathname.endsWith('/batches')){
        const batch=JSON.parse(opts.body)
        if(batch.session.wxid===peerB && blocked && batch.messages[0].local_id==='812')throw Error('interrupted')
        if(!blocked)sent.push(...batch.messages.map(m=>m.local_id))
      }
      return beforeFetch(url,opts)
    }
    slow=false
    await recovered.start({...options,sessions:[peerA,peerB],kinds:['text'],continuous:false}); await settle(recovered)
    assert.equal(recovered.status().status,'offline')
    blocked=false
    const continued=new HistorySyncService(); continued.status(); await continued.resume(); await settle(continued)
    assert.equal(continued.status().status,'completed')
    assert.deepEqual(recoveredOpens,[[peerB,same]])
    assert.deepEqual(sent,['812','813','814'])
    assert.equal(continued.status().completedSessions,2)
    assert.equal(continued.status().sessionProgress.find(p=>p.id===peerB).processed,5)
    const getList = global.__historyMock.chat.chatService
    const names = ['range-a','range-b','range-c']
    getList.getSessions = async () => ({success:true,sessions:names.map(username=>({username,displayName:username}))})
    const initial = await continued.sessions()
    const bIndex = initial.find(s=>s.id==='range-b').ordinal
    names.splice(0,3,'range-new','range-c','range-b')
    const nextApp = new HistorySyncService()
    const refreshed = await nextApp.sessions()
    assert.equal(refreshed.find(s=>s.id==='range-b').ordinal,bIndex)
    assert(refreshed.find(s=>s.id==='range-new').ordinal>bIndex+1)
    const bounded = {...options,ordinalRange:{first:bIndex,last:bIndex+1,owner:state.owner}, sessions:['range-b','range-c']}
    assert.deepEqual((await nextApp.preview(bounded)).map(r=>r.id),bounded.sessions)
    await assert.rejects(()=>nextApp.start({...bounded,sessions:[]}),/范围/)
    await assert.rejects(()=>nextApp.preview({...bounded,ordinalRange:{...bounded.ordinalRange,owner:'wrong'}}),/账号/)
    console.log('History sync tests passed: identity, both directions, replay, pause, account change, crash recovery, old-history reconciliation')
  } finally {
    global.fetch = oldFetch; global.__historyMock = oldMock
    if (dir.startsWith(path.join(os.tmpdir(), 'weflow-history-test-'))) fs.rmSync(dir, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
