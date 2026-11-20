import * as koffi from 'koffi'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, realpathSync, statSync, unlinkSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { createHash } from 'crypto'

export type SqlRow = Record<string, any>
export type KeyProfile = 'raw-v4' | 'binary-v4' | 'raw-v3'
export const quoteIdentifier = (name: string) => '"' + name.replace(/"/g, '""') + '"'

/** Only snapshot files are passed to SQLite. The original DB/WAL/SHM are never opened by SQLite. */
export class SqliteReader {
  private api: Record<string, any> = {}
  private handle: any = null
  readonly libraryVersion: string

  constructor(libraryPath: string, snapshotPath: string, key: string, profile: KeyProfile = 'raw-v4') {
    const lib = koffi.load(libraryPath)
    const definitions: Record<string, string> = {
      version: 'const char* sqlite3_libversion()',
      open: 'int sqlite3_open_v2(const char*, _Out_ void**, int, const char*)',
      close: 'int sqlite3_close_v2(void*)',
      key: 'int sqlite3_key(void*, const void*, int)',
      prepare: 'int sqlite3_prepare_v2(void*, const void*, int, _Out_ void**, _Out_ void**)',
      readonly: 'int sqlite3_stmt_readonly(void*)', step: 'int sqlite3_step(void*)', finalize: 'int sqlite3_finalize(void*)',
      count: 'int sqlite3_column_count(void*)', name: 'const char* sqlite3_column_name(void*, int)',
      type: 'int sqlite3_column_type(void*, int)', integer: 'int64 sqlite3_column_int64(void*, int)',
      real: 'double sqlite3_column_double(void*, int)', blob: 'void* sqlite3_column_blob(void*, int)',
      text: 'void* sqlite3_column_text(void*, int)', bytes: 'int sqlite3_column_bytes(void*, int)',
      bindText: 'int sqlite3_bind_text(void*, int, const void*, int, void*)',
      bindInt: 'int sqlite3_bind_int64(void*, int, int64)', bindNull: 'int sqlite3_bind_null(void*, int)',
      timeout: 'int sqlite3_busy_timeout(void*, int)',
    }
    for (const [name, signature] of Object.entries(definitions)) this.api[name] = lib.func(signature)
    this.libraryVersion = this.api.version()
    const out = [null as any]
    const result = this.api.open(snapshotPath, out, 0x00000001 | 0x00010000, null) // READONLY | FULLMUTEX
    this.handle = out[0]
    if (result !== 0) { this.close(); throw new Error(`只读打开数据库副本失败 (${result})`) }
    try {
      this.api.timeout(this.handle, 2000)
      const header = Buffer.alloc(16)
      // Snapshot already exists; a plain fixture/previous export doesn't require a key.
      const fd = openSync(snapshotPath, 'r')
      try { readSync(fd, header, 0, 16, 0) } finally { closeSync(fd) }
      const plain = header.equals(Buffer.from('SQLite format 3\0'))
      if (!plain) {
        if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Error('需要 64 位十六进制数据库密钥')
        this.execute('PRAGMA cipher = sqlcipher', [], true)
        this.execute(`PRAGMA legacy = ${profile === 'raw-v3' ? 3 : 4}`, [], true)
        this.execute('PRAGMA legacy_page_size = 4096', [], true)
        const material = profile === 'binary-v4' ? Buffer.from(key, 'hex') : Buffer.from(`x'${key}'`, 'utf8')
        try {
          if (this.api.key(this.handle, material, material.length) !== 0) throw new Error('设置数据库密钥失败')
        } finally { material.fill(0) }
      }
      this.execute('PRAGMA query_only = ON', [], true)
      this.query('SELECT count(*) AS n FROM sqlite_master')
    } catch (error) { this.close(); throw error }
  }

  query(sql: string, params: unknown[] = [], maxRows = 100000): SqlRow[] {
    if (!/^\s*(SELECT\b|WITH\b|EXPLAIN\b|PRAGMA\s+(?:table_info|table_xinfo|index_list|index_info|database_list|user_version|schema_version|query_only)\b)/i.test(sql)) {
      throw new Error('独立读取器只允许查询；不支持修改、删除、挂载或恢复数据库')
    }
    return this.execute(sql, params, false, maxRows)
  }

  private execute(sql: string, params: unknown[], configure = false, maxRows = 100000): SqlRow[] {
    if (!this.handle) throw new Error('数据库副本连接已关闭')
    const statement = [null as any], tail = [null as any]
    const sqlBytes = Buffer.from(sql + '\0', 'utf8')
    const result = this.api.prepare(this.handle, sqlBytes, sqlBytes.length, statement, tail)
    if (result !== 0) {
      if (statement[0]) this.api.finalize(statement[0])
      throw new Error(`查询准备失败 (${result})；请核对密钥、数据库格式及副本完整性`)
    }
    const stmt = statement[0]
    if (!stmt) return []
    const retained: Buffer[] = [sqlBytes]
    try {
      if (tail[0] && String(koffi.decode(tail[0], 'char', -1) || '').trim()) throw new Error('只允许单条只读查询')
      if (!configure && !this.api.readonly(stmt)) throw new Error('已阻止数据库写操作')
      params.forEach((value, index) => {
        let rc: number
        if (value === null || value === undefined) rc = this.api.bindNull(stmt, index + 1)
        else if (typeof value === 'number' && Number.isSafeInteger(value)) rc = this.api.bindInt(stmt, index + 1, value)
        else if (typeof value === 'bigint') rc = this.api.bindInt(stmt, index + 1, value)
        else {
          const buffer = Buffer.from(String(value) + '\0', 'utf8'); retained.push(buffer)
          rc = this.api.bindText(stmt, index + 1, buffer, buffer.length - 1, null)
        }
        if (rc !== 0) throw new Error(`查询参数绑定失败 (${rc})`)
      })
      const rows: SqlRow[] = []
      const names = Array.from({length: Number(this.api.count(stmt))}, (_,i) => String(this.api.name(stmt,i)))
      let bytes = 0, rc: number
      while ((rc = this.api.step(stmt)) === 100) {
        const row: SqlRow = {}
        for (let col = 0; col < names.length; col++) {
          const name = names[col]
          const type = this.api.type(stmt, col)
          if (type === 5) row[name] = null
          else if (type === 1) {
            const value = this.api.integer(stmt, col)
            row[name] = typeof value === 'bigint' ? value.toString() : value
          } else if (type === 2) row[name] = this.api.real(stmt, col)
          else {
            const ptr = type === 4 ? this.api.blob(stmt, col) : this.api.text(stmt, col)
            const size = this.api.bytes(stmt, col)
            bytes += size
            if (size > 32 * 1024 * 1024 || bytes > 128 * 1024 * 1024) throw new Error('查询结果过大，请缩小查询范围')
            const data = ptr && size ? Buffer.from(koffi.decode(ptr, 'uint8_t', size)) : Buffer.alloc(0)
            row[name] = type === 4 ? data : data.toString('utf8')
          }
        }
        rows.push(row)
        if (rows.length > maxRows) throw new Error('查询条数超过限制，请使用分页')
      }
      if (rc !== 101) throw new Error(`读取失败 (${rc})；密钥、数据格式或 WAL 副本可能不匹配`)
      return rows
    } finally { this.api.finalize(stmt); retained.length = 0 }
  }

  close() { if (this.handle) { this.api.close(this.handle); this.handle = null } }
}

function stamp(path: string): string {
  if (!existsSync(path)) return 'missing'
  const value = statSync(path, { bigint: true })
  return `${value.size}:${value.mtimeNs}`
}

export class SnapshotStore {
  private opened = new Map<string, { version: string; reader: SqliteReader; path: string }>()
  constructor(private library: string, private sourceRoot: string, private cacheRoot: string, private key: string) {
    this.sourceRoot = realpathSync(sourceRoot)
    this.cacheRoot = resolve(cacheRoot)
    if (this.cacheRoot === this.sourceRoot || this.cacheRoot.startsWith(this.sourceRoot + sep)) throw new Error('快照目录不能放在微信数据库目录内')
    mkdirSync(this.cacheRoot, { recursive: true })
  }

  database(file: string): SqliteReader {
    const source = realpathSync(file)
    if (!source.startsWith(this.sourceRoot + sep)) throw new Error('数据库路径不属于当前微信账号')
    const version = stamp(source) + '|' + stamp(source + '-wal')
    const previous = this.opened.get(source)
    if (previous?.version === version) return previous.reader
    if (previous) { previous.reader.close(); this.opened.delete(source); this.removeCopy(previous.path) }
    const snapshot = join(this.cacheRoot, createHash('sha256').update(source + version).digest('hex') + '.db')
    copyFileSync(source, snapshot)
    if (existsSync(source + '-wal')) copyFileSync(source + '-wal', snapshot + '-wal')
    if (version !== stamp(source) + '|' + stamp(source + '-wal')) {
      this.removeCopy(snapshot)
      throw new Error('数据库正在更新，未使用不一致的副本，请稍后重试')
    }
    for (const profile of ['raw-v4', 'binary-v4', 'raw-v3'] as KeyProfile[]) {
      try {
        const reader = new SqliteReader(this.library, snapshot, this.key, profile)
        this.opened.set(source, { version, reader, path: snapshot })
        return reader
      } catch { /* Try only documented cipher profiles; never disable page integrity checks. */ }
    }
    this.removeCopy(snapshot)
    throw new Error('无法读取加密数据库：请确认当前账号的密钥；该库也可能使用独立密钥或不兼容的加密格式')
  }

  private removeCopy(file: string) {
    if (dirname(resolve(file)) !== this.cacheRoot) throw new Error('无效快照清理路径')
    for (const suffix of ['-shm', '-wal', '']) {
      try { if (existsSync(file + suffix)) unlinkSync(file + suffix) } catch { /* active OS handle; retain encrypted snapshot */ }
    }
  }

  close() {
    for (const value of this.opened.values()) { value.reader.close(); this.removeCopy(value.path) }
    this.opened.clear(); this.key = ''
  }
}
