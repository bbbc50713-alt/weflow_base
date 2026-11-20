import { createHash } from 'crypto'
import { existsSync, readdirSync, realpathSync, watch, type FSWatcher } from 'fs'
import { basename, join, relative, resolve, sep } from 'path'
import { SnapshotStore, quoteIdentifier as qi, type SqlRow } from './SqliteReader'

type MessageTable = { path: string; name: string; columns: string[]; talkerColumn?: string; index: number }
type Position = { time: number; seq: string; id: string; index: number }
type Cursor = { session: string; tables: MessageTable[]; limit: number; ascending: boolean; begin: number; end: number; position?: Position; type?: number; baseTypes?: number[]; keyword?: string }

function field(row: SqlRow, ...names: string[]): any {
  for (const name of names) { const key = Object.keys(row).find(k => k.toLowerCase() === name.toLowerCase()); if (key !== undefined) return row[key] }
  return undefined
}
const cleanOwner = (name: string) => name.startsWith('wxid_') ? name.match(/^wxid_[^_]+/)![0] : name.replace(/_[a-zA-Z0-9]{4}$/, '')
function intString(value: unknown): string { try { return BigInt(String(value ?? 0)).toString() } catch { return '0' } }
function serverId(value: unknown): string { return BigInt.asUintN(64, BigInt(intString(value))).toString() }
function compare(a: SqlRow, b: SqlRow) {
  if (a.create_time !== b.create_time) return a.create_time - b.create_time
  for (const name of ['sort_seq', 'local_id']) {
    const x = BigInt(intString(a[name])), y = BigInt(intString(b[name])); if (x !== y) return x < y ? -1 : 1
  }
  return a._shard_index - b._shard_index
}

/** Independently implemented queries. Never loads wcdb_api.dll or WeLive. */
export class IndependentReader {
  private resources = join(process.cwd(), 'resources')
  private userData = ''
  private root = ''
  private owner = ''
  private openIdentity = ''
  private senderCache = new WeakMap<object, Map<string, string>>()
  private snapshots?: SnapshotStore
  private files: string[] = []
  private lastError: string | null = null
  private cursors = new Map<number, Cursor>()
  private nextCursor = 1
  private monitor?: FSWatcher
  private monitorTimer?: ReturnType<typeof setTimeout>
  constructor(private notify: (type: string, json: string) => void = () => {}) {}

  async dispatch(type: string, p: any = {}): Promise<any> {
    try {
      switch (type) {
        case 'setPaths': this.resources = p.resourcesPath; this.userData = p.userDataPath; return { success: true }
        case 'setLogEnabled': return { success: true }
        case 'getLastInitError': return this.lastError
        case 'testConnection': return this.testConnection(p.accountDir, p.hexKey)
        case 'open': return this.open(p.accountDir, p.hexKey)
        case 'close': this.close(); return { success: true }
        case 'isConnected': return Boolean(this.snapshots)
        case 'setMonitor': return this.startMonitor()
        case 'cloudInit': case 'cloudReport': return { success: false, error: '独立只读读取器不提供云端统计上报' }
        case 'cloudStop': return { success: true }
        case 'getLogs': return { success: true, logs: this.lastError ? [this.lastError] : [] }
      }
      if (!this.snapshots) return { success: false, error: this.lastError || '独立读取器尚未连接，请先在数据库设置中完成连接' }
      switch (type) {
        case 'getSessions': return { success: true, sessions: this.sessions() }
        case 'getSessionListSupplement': return {success:true, contacts:this.sessionListSupplement()}
        case 'getContactsCompact': return { success: true, contacts: this.contacts(p.usernames) }
        case 'getContact': return { success: true, contact: this.contacts([p.username])[0] || null }
        case 'getContactAliasMap': return { success: true, map: Object.fromEntries(this.contacts(p.usernames).map(c => [c.username, c.alias || ''])) }
        case 'getDisplayNames': return { success: true, map: Object.fromEntries(this.contacts(p.usernames).map(c => [c.username, c.remark || c.nick_name || c.username])) }
        case 'getAvatarUrls': return { success: true, map: Object.fromEntries(this.contacts(p.usernames).map(c => [c.username, c.small_head_url || c.big_head_url || ''])) }
        case 'getContactStatus': return { success: false, error: '尚未核验静音/折叠状态，未将其视为关闭' }
        case 'getContactFriendFlags': return { success: false, error: '历史联系人不能证明当前好友关系' }
        case 'getContactTypeCounts': return this.contactCounts()
        case 'getGroupMembers': case 'getGroupNicknames': case 'getGroupMemberCount': case 'getGroupMemberCounts':
          return { success: false, error: '当前适配器尚未验证完整群成员列表；消息发送者仍按原始身份读取' }
        case 'openMessageCursor': return this.openCursor(p.sessionId, p.batchSize, p.ascending, p.beginTimestamp, p.endTimestamp, p.baseTypes)
        case 'fetchMessageBatch': return this.fetch(p.cursor)
        case 'closeMessageCursor': this.cursors.delete(p.cursor); return { success: true }
        case 'getMessages': return this.page(p.sessionId, p.limit, p.offset, false)
        case 'getNewMessages': return this.page(p.sessionId, p.limit, 0, true, p.minTime)
        case 'getMessagesByType': return this.page(p.sessionId, p.limit, p.offset, p.ascending, 0, 0, p.localType)
        case 'getMessageByServerId': return this.findMessage(p.sessionId, 'server_id', p.svrid)
        case 'getMessageById': return this.findMessage(p.sessionId, 'local_id', p.localId)
        case 'getMessageCount': return { success: true, count: this.messageCount(p.sessionId) }
        case 'getMessageCounts': case 'getSessionMessageCounts': return { success: true, counts: Object.fromEntries((p.sessionIds || []).map((id: string) => [id, this.messageCount(id)])) }
        case 'getMessageDates': return { success: true, dates: Object.keys(this.dateCounts(p.sessionId)).sort() }
        case 'getSessionMessageDateCounts': return { success: true, counts: this.dateCounts(p.sessionId) }
        case 'getSessionMessageDateCountsBatch': return { success: true, data: Object.fromEntries((p.sessionIds || []).map((id: string) => [id, this.dateCounts(id)])) }
        case 'getMessageTables': case 'getMessageTableStats': return { success: true, tables: this.messageTables(p.sessionId).map(t => ({ db_path: t.path, table_name: t.name, ...this.tableStats(t) })) }
        case 'getMessageTableTimeRange': return { success: true, ...this.tableStats(this.namedTable(p.dbPath, p.tableName)) }
        case 'getMessageTableColumns': return { success: true, columns: this.columns(p.dbPath, p.tableName) }
        case 'listMessageDbs': return { success: true, dbs: this.files.filter(f => /(?:message|msg)[_\d]*\.db$/i.test(basename(f))) }
        case 'listMediaDbs': return { success: true, dbs: this.files.filter(f => /media|hardlink|resource/i.test(basename(f))) }
        case 'listTables': { const f = this.pickDatabase(p.kind, p.dbPath); return { success: true, tables: this.tables(f) } }
        case 'getTableSchema': { const f = this.pickDatabase(p.kind, p.dbPath); return { success: true, schema: this.db(f).query('SELECT sql FROM sqlite_master WHERE name=?', [p.tableName])[0]?.sql || '' } }
        case 'execQuery': return { success: true, rows: this.db(this.pickDatabase(p.kind, p.path)).query(p.sql, p.params || []) }
        case 'searchMessages': return this.search(p)
        case 'getSessionMessageTypeStats': return { success: true, data: this.typeStats(p.sessionId, p.beginTimestamp, p.endTimestamp) }
        case 'getSessionMessageTypeStatsBatch': return { success: true, data: Object.fromEntries((p.sessionIds || []).map((id: string) => [id, this.typeStats(id, p.options?.beginTimestamp, p.options?.endTimestamp)])) }
        default: return { success: false, error: `独立只读读取器暂不支持 ${type}；未执行任何数据库写入` }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取失败'
      this.lastError = `独立读取器：${message}`
      if (type === 'open') return false
      return { success: false, error: this.lastError }
    }
  }

  private library() {
    const candidates = [join(this.resources, 'independent-reader/win32/x64/sqlite3mc.dll'),
      join(this.resources, 'resources/independent-reader/win32/x64/sqlite3mc.dll'),
      join(process.cwd(), 'resources/independent-reader/win32/x64/sqlite3mc.dll')]
    const found = candidates.find(p => existsSync(p))
    if (!found) throw new Error('缺少独立读取器 sqlite3mc.dll，请重新准备依赖')
    return found
  }

  private discover(directory: string): string[] {
    const files: string[] = []
    const walk = (dir: string, depth: number) => {
      if (depth > 8) return
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        if (item.isSymbolicLink()) continue
        const path = join(dir, item.name)
        if (item.isDirectory()) walk(path, depth + 1)
        else if (/\.db$/i.test(item.name)) files.push(path)
      }
    }
    walk(directory, 0)
    return files.sort()
  }

  private open(accountDir: string, key: string): boolean {
    const identity = createHash('sha256').update(resolve(accountDir) + '\0' + key).digest('hex')
    if (this.snapshots && this.openIdentity === identity) return true
    this.close()
    if (!/^[a-fA-F0-9]{64}$/.test(key || '')) throw new Error('数据库密钥需为 64 位十六进制文本')
    this.root = realpathSync(join(accountDir, 'db_storage'))
    this.owner = cleanOwner(basename(resolve(accountDir)))
    this.files = this.discover(this.root)
    if (!this.files.length) throw new Error('账号目录中没有发现数据库')
    if (!this.userData) throw new Error('独立读取器缓存目录尚未配置')
    this.snapshots = new SnapshotStore(this.library(), this.root, join(this.userData, 'independent-reader/snapshots'), key)
    try {
      this.sessionLayout()
      this.contactLayout()
      this.lastError = null
      this.openIdentity = identity
      return true
    } catch (error) { this.close(); throw error }
  }

  private testConnection(accountDir: string, key: string) {
    // A separate core preserves the active UI connection if this test fails.
    const test = new IndependentReader()
    test.resources = this.resources
    test.userData = join(this.userData, 'connection-test-' + createHash('sha256').update(accountDir).digest('hex').slice(0, 12))
    try { test.open(accountDir, key); return { success: true, sessionCount: Number(test.db(test.pickDatabase('session')).query(`SELECT count(*) AS n FROM ${qi(test.sessionLayout().table)}`)[0].n), reader: 'independent-readonly' } }
    finally { test.close() }
  }

  private close() {
    this.monitor?.close(); this.monitor = undefined
    if (this.monitorTimer) clearTimeout(this.monitorTimer)
    this.snapshots?.close(); this.snapshots = undefined; this.cursors.clear(); this.files = []; this.openIdentity = ''
  }

  private startMonitor() {
    if (!this.snapshots) return { success: false }
    if (!this.monitor) this.monitor = watch(this.root, { recursive: true }, (_event, name) => {
      if (!name || /-shm$/i.test(String(name)) || !/\.db(?:-wal)?$/i.test(String(name))) return
      if (this.monitorTimer) clearTimeout(this.monitorTimer)
      this.monitorTimer = setTimeout(() => { this.files = this.discover(this.root); this.notify('message', JSON.stringify({ table: 'message' })) }, 500)
    })
    return { success: true }
  }

  private db(file: string) { if (!this.snapshots) throw new Error('数据库未连接'); return this.snapshots.database(file) }
  private tables(file: string): string[] { return this.db(file).query("SELECT name FROM sqlite_master WHERE type='table'").map(r => String(r.name)) }
  private columns(file: string, table: string): string[] { return this.db(file).query(`PRAGMA table_info(${qi(table)})`).map(r => String(r.name)) }
  private pickColumn(columns: string[], names: string[]): string | undefined { return names.map(n => columns.find(c => c.toLowerCase() === n.toLowerCase())).find(Boolean) }
  private pickDatabase(kind: string, path?: string): string {
    if (path) { const p = realpathSync(path); if (!p.startsWith(this.root + sep) || !this.files.includes(p)) throw new Error('数据库不属于当前账号'); return p }
    const candidates: Record<string, string[]> = { session: ['session.db'], contact: ['contact.db'], sns: ['sns.db'], emoticon: ['emoticon.db'], hardlink: ['hardlink.db'] }
    const names = candidates[kind] || [kind + '.db']
    const file = this.files.find(f => names.includes(basename(f).toLowerCase()))
    if (!file) throw new Error(`本地没有 ${kind} 数据库`)
    return file
  }

  private sessionLayout() {
    const file = this.pickDatabase('session')
    const table = this.tables(file).find(t => ['sessiontable', 'session'].includes(t.toLowerCase()))
    if (!table) throw new Error('尚不支持该会话库结构，未猜测表或返回空成功')
    const cols = this.columns(file,table)
    if (!this.pickColumn(cols,['username','user_name','talker'])) throw new Error('会话表缺少微信身份字段')
    return {file,table,cols}
  }

  private sessions() {
    const {file,table,cols} = this.sessionLayout()
    // Never transfer packed metadata or other unbounded blobs with the list.
    const wanted = new Set('username user_name talker type local_type localtype wcdb_ct_local_type unread_count unreadcount summary digest last_msg lastmsg sort_timestamp sorttimestamp sort_time sorttime last_timestamp lasttimestamp last_msg_time lastmsgtime last_msg_type lastmsgtype last_msg_sender last_sender_display_name message_count messagecount msg_count msgcount total_count totalcount n_msg nmsg message_num messagenum'.split(' '))
    const fields = cols.filter(c => wanted.has(c.toLowerCase())).map(c =>
      ['summary','digest','last_msg','lastmsg'].includes(c.toLowerCase()) ? `substr(CAST(${qi(c)} AS TEXT),1,512) AS ${qi(c)}` : qi(c))
    return this.db(file).query(`SELECT ${fields.join(',')} FROM ${qi(table)}`, [], Number.MAX_SAFE_INTEGER).map(r => ({ ...r,
      username: String(field(r, 'username', 'user_name', 'talker') || ''),
      last_timestamp: field(r, 'last_timestamp', 'last_msg_time', 'sort_timestamp') || 0,
      sort_timestamp: field(r, 'sort_timestamp', 'sort_time', 'last_timestamp') || 0,
    })).filter(r => r.username)
  }

  private contactLayout() {
    const file = this.pickDatabase('contact')
    const table = this.tables(file).find(t => ['contact', 'contacttable'].includes(t.toLowerCase()))
    if (!table) throw new Error('尚不支持该联系人库结构')
    const column = this.pickColumn(this.columns(file, table), ['username', 'user_name'])
    if (!column) throw new Error('联系人库缺少可核验的微信身份字段')
    return {file,table,column}
  }

  private sessionListSupplement() {
    const {file,table,column} = this.contactLayout()
    const cols = this.columns(file,table).filter(c => ['local_type','localtype','wcdb_ct_local_type','remark','nick_name','alias'].includes(c.toLowerCase()))
    const id = qi(column)
    return this.db(file).query(`SELECT ${[id+' AS username', ...cols.map(qi)].join(',')} FROM ${qi(table)} WHERE ${id} GLOB 'gh_*' OR lower(${id}) LIKE 'weixin%' OR lower(${id}) LIKE '%@openim%'`, [], Number.MAX_SAFE_INTEGER)
  }

  private contacts(usernames: string[] = []): SqlRow[] {
    const {file,table,column} = this.contactLayout()
    let rows: SqlRow[] = []
    if (!usernames?.length) rows = this.db(file).query(`SELECT * FROM ${qi(table)}`)
    else for (let i = 0; i < usernames.length; i += 400) {
      const ids = usernames.slice(i, i + 400)
      rows.push(...this.db(file).query(`SELECT * FROM ${qi(table)} WHERE ${qi(column)} IN (${ids.map(() => '?').join(',')})`, ids))
    }
    return rows.map(r => ({ ...r, username: String(r[column]),
      nick_name: field(r, 'nick_name', 'nickname', 'nickName') || '', remark: field(r, 'remark', 'remark_name') || '',
      alias: field(r, 'alias') || '', small_head_url: field(r, 'small_head_url', 'small_head_img_url', 'smallHeadUrl') || '',
      big_head_url: field(r, 'big_head_url', 'big_head_img_url', 'bigHeadUrl') || '' }))
  }

  private contactCounts() {
    const counts: Record<string, number> = { total: 0, friend: 0, group: 0, official: 0, former_friend: 0, other: 0 }
    for (const c of this.contacts()) { counts.total++; counts[c.username.endsWith('@chatroom') ? 'group' : c.username.startsWith('gh_') ? 'official' : Number(c.local_type) === 1 ? 'friend' : Number(c.local_type) === 0 && c.quan_pin ? 'former_friend' : 'other']++ }
    return { success: true, counts }
  }

  private messageTables(session: string): MessageTable[] {
    const hash = createHash('md5').update(session).digest('hex')
    const found: MessageTable[] = []
    for (const file of this.files.filter(f => /^(?:message|msg)[_\d]*\.db$/i.test(basename(f)))) {
      for (const name of this.tables(file)) {
        if (name.toLowerCase() === `msg_${hash}`) found.push({ path: file, name, columns: this.columns(file, name), index: found.length })
        else if (['msg', 'message'].includes(name.toLowerCase())) {
          const columns = this.columns(file, name)
          const talkerColumn = this.pickColumn(columns, ['strTalker', 'talker', 'username'])
          if (talkerColumn) found.push({ path: file, name, columns, talkerColumn, index: found.length })
        }
      }
    }
    return found
  }

  private namedTable(path: string, name: string): MessageTable {
    const file = this.pickDatabase('message', path)
    if (!this.tables(file).includes(name)) throw new Error('消息表不存在')
    return { path: file, name, columns: this.columns(file, name), index: 0 }
  }

  private layout(t: MessageTable) {
    const time = this.pickColumn(t.columns, ['create_time', 'CreateTime'])
    const id = this.pickColumn(t.columns, ['local_id', 'localId', 'MsgLocalID'])
    const seq = this.pickColumn(t.columns, ['sort_seq', 'Sequence']) || id
    if (!time || !id || !seq) throw new Error('消息表缺少时间或稳定本地编号，无法安全分页')
    return { time, id, seq }
  }

  private senderMap(file: string) {
    const database = this.db(file)
    const cached = this.senderCache.get(database)
    if (cached) return cached
    const table = this.tables(file).find(t => t.toLowerCase() === 'name2id')
    const map = new Map<string, string>()
    if (!table) return map
    for (const row of this.db(file).query(`SELECT rowid AS __rowid, * FROM ${qi(table)}`)) {
      const name = field(row, 'user_name', 'username', 'usrName')
      if (name) map.set(intString(field(row, 'id', 'local_id', '__rowid')), String(name))
    }
    this.senderCache.set(database, map)
    return map
  }

  private normalize(row: SqlRow, t: MessageTable, senders: Map<string, string>) {
    const originalSender = field(row, 'sender_username', 'senderUsername')
    const sender = String(originalSender || senders.get(intString(field(row, 'real_sender_id', 'sender_id'))) || '')
    const explicit = field(row, 'is_send', 'is_sender', 'IsSender')
    const isSend = explicit !== undefined && explicit !== null ? Number(explicit) : sender ? Number(sender === this.owner) : null
    return { ...row, local_id: field(row, 'local_id', 'localId', 'MsgLocalID'), server_id: serverId(field(row, 'server_id', 'MsgSvrID')),
      local_type: Number(field(row, 'local_type', 'Type') || 1), create_time: Number(field(row, 'create_time', 'CreateTime') || 0),
      sort_seq: intString(field(row, 'sort_seq', 'Sequence', 'local_id', 'localId')), is_send: isSend, computed_is_send: isSend,
      sender_username: sender || null, message_content: field(row, 'message_content', 'StrContent') ?? '',
      compress_content: field(row, 'compress_content', 'CompressContent'), _db_path: t.path, db_name: basename(t.path), table_name: t.name, _shard_index: t.index }
  }

  private openCursor(session: string, limit = 200, ascending = false, begin = 0, end = 0, baseTypes?: number[]) {
    if (!session) throw new Error('缺少会话 ID')
    const id = this.nextCursor++
    this.cursors.set(id, { session, tables: this.messageTables(session), limit: Math.max(1, Math.min(500, Number(limit) || 200)), ascending, begin, end, baseTypes })
    return { success: true, cursor: id }
  }

  private fetch(id: number) {
    const c = this.cursors.get(id)
    if (!c) throw new Error('消息游标不存在或已关闭')
    const candidates: SqlRow[] = []
    const op = c.ascending ? '>' : '<', order = c.ascending ? 'ASC' : 'DESC'
    for (const t of c.tables) {
      const f = this.layout(t), terms: string[] = [], params: any[] = []
      if (t.talkerColumn) { terms.push(`${qi(t.talkerColumn)}=?`); params.push(c.session) }
      if (c.begin) { terms.push(`${qi(f.time)}>=?`); params.push(c.begin) }
      if (c.end) { terms.push(`${qi(f.time)}<=?`); params.push(c.end) }
      if (c.baseTypes?.length) {
        const col = this.pickColumn(t.columns, ['local_type', 'Type'])
        if (col) { terms.push(`(${qi(col)} & 4294967295) IN (${c.baseTypes.map(() => '?').join(',')})`); params.push(...c.baseTypes) }
      }
      if (c.type !== undefined) { const typeCol = this.pickColumn(t.columns, ['local_type', 'Type']); if (typeCol) { terms.push(`${qi(typeCol)}=?`); params.push(c.type) } }
      if (c.position) {
        const p = c.position, includeEqual = c.ascending ? t.index > p.index : t.index < p.index
        terms.push(`(${qi(f.time)}${op}? OR (${qi(f.time)}=? AND ${qi(f.seq)}${op}?) OR (${qi(f.time)}=? AND ${qi(f.seq)}=? AND ${qi(f.id)}${op}${includeEqual ? '=' : ''}?))`)
        params.push(p.time, p.time, BigInt(p.seq), p.time, BigInt(p.seq), BigInt(p.id))
      }
      const rows = this.db(t.path).query(`SELECT * FROM ${qi(t.name)} ${terms.length ? 'WHERE ' + terms.join(' AND ') : ''} ORDER BY ${qi(f.time)} ${order}, ${qi(f.seq)} ${order}, ${qi(f.id)} ${order} LIMIT ?`, [...params, c.limit + 1])
      const senders = this.senderMap(t.path)
      candidates.push(...rows.map(r => this.normalize(r, t, senders)))
    }
    candidates.sort((a, b) => (c.ascending ? 1 : -1) * compare(a, b))
    const rows = candidates.slice(0, c.limit), last = rows.at(-1)
    if (last) c.position = { time: last.create_time, seq: intString(last.sort_seq), id: intString(last.local_id), index: last._shard_index }
    return { success: true, rows, hasMore: candidates.length > rows.length }
  }

  private page(session: string, limit = 50, offset = 0, ascending = false, begin = 0, end = 0, type?: number) {
    const opened = this.openCursor(session, Math.min(limit, 500), ascending, begin, end)
    const cursor = this.cursors.get(opened.cursor)!; cursor.type = type
    const messages: SqlRow[] = []; let skipped = 0, hasMore = true
    try {
      while (hasMore && messages.length < Math.min(limit, 10000)) {
        const page = this.fetch(opened.cursor); hasMore = page.hasMore
        for (const row of page.rows) { if (skipped++ < offset) continue; if (messages.length < limit) messages.push(row); else { hasMore = true; break } }
      }
      return { success: true, messages, rows: messages, hasMore }
    } finally { this.cursors.delete(opened.cursor) }
  }

  private findMessage(session: string, name: string, value: string | number) {
    for (const t of this.messageTables(session)) {
      const column = this.pickColumn(t.columns, name === 'server_id' ? ['server_id', 'MsgSvrID'] : ['local_id', 'localId'])
      if (!column) continue
      const lookupId = name === 'server_id' ? BigInt.asIntN(64, BigInt(String(value))) : BigInt(String(value))
      const row = this.db(t.path).query(`SELECT * FROM ${qi(t.name)} WHERE ${qi(column)}=?${t.talkerColumn ? ' AND ' + qi(t.talkerColumn) + '=?' : ''} LIMIT 1`, [lookupId, ...(t.talkerColumn ? [session] : [])])[0]
      if (row) { const normalized = this.normalize(row, t, this.senderMap(t.path)); return { success: true, row: normalized, message: normalized } }
    }
    return { success: true, row: null, message: null }
  }

  private messageCount(session: string) { return this.messageTables(session).reduce((n, t) => n + Number(this.db(t.path).query(`SELECT count(*) AS n FROM ${qi(t.name)}${t.talkerColumn ? ' WHERE ' + qi(t.talkerColumn) + '=?' : ''}`, t.talkerColumn ? [session] : [])[0].n), 0) }
  private tableStats(t: MessageTable) { const f = this.layout(t); return this.db(t.path).query(`SELECT count(*) AS count, min(${qi(f.time)}) AS firstTimestamp, max(${qi(f.time)}) AS lastTimestamp FROM ${qi(t.name)}`)[0] }
  private dateCounts(session: string) {
    const counts: Record<string, number> = {}
    for (const t of this.messageTables(session)) {
      const f = this.layout(t)
      for (const r of this.db(t.path).query(`SELECT strftime('%Y-%m-%d',${qi(f.time)},'unixepoch','localtime') AS day,count(*) AS n FROM ${qi(t.name)}${t.talkerColumn ? ' WHERE ' + qi(t.talkerColumn) + '=?' : ''} GROUP BY day`, t.talkerColumn ? [session] : [])) counts[r.day] = (counts[r.day] || 0) + Number(r.n)
    }
    return counts
  }
  private typeStats(session: string, begin = 0, end = 0) {
    const stats: Record<string, any> = { total_messages: 0, text_messages: 0, image_messages: 0, voice_messages: 0, video_messages: 0, emoji_messages: 0, type_counts: {} }
    for (const t of this.messageTables(session)) {
      const f = this.layout(t), type = this.pickColumn(t.columns, ['local_type', 'Type']); if (!type) continue
      const terms = [`${qi(f.time)}>=?`], params: any[] = [begin]
      if (end) { terms.push(`${qi(f.time)}<=?`); params.push(end) }
      if (t.talkerColumn) { terms.push(`${qi(t.talkerColumn)}=?`); params.push(session) }
      for (const r of this.db(t.path).query(`SELECT ${qi(type)} AS type,count(*) AS n,min(${qi(f.time)}) AS first,max(${qi(f.time)}) AS last FROM ${qi(t.name)} WHERE ${terms.join(' AND ')} GROUP BY ${qi(type)}`, params)) {
        const n = Number(r.n); stats.total_messages += n; stats.type_counts[r.type] = (stats.type_counts[r.type] || 0) + n
        stats.first_timestamp = Math.min(stats.first_timestamp || Infinity, Number(r.first))
        stats.last_timestamp = Math.max(stats.last_timestamp || 0, Number(r.last))
        const field = ({ 1: 'text_messages', 3: 'image_messages', 34: 'voice_messages', 43: 'video_messages', 47: 'emoji_messages' } as Record<string, string>)[r.type]
        if (field) stats[field] += n
      }
    }
    return stats
  }
  private search(p: any) {
    // Decode/search is handled by chatService; native compressed payloads aren't SQL LIKE text.
    return { success: false, error: '压缩消息检索请使用页面的解析后搜索；原始字节不作为可搜索明文' }
  }
}
