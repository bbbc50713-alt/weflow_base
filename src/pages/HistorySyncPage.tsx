import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { CloudUpload, Pause, Play, RefreshCw, Link2 } from 'lucide-react'
import type { HistoryOptions, HistoryStatus, SessionProgress } from '../../shared/wechatHistory'
import ToastProvider, { useToast } from '../components/AIReply/Toast'
import './HistorySyncPage.scss'
import { allHistoryKinds, historyKinds } from '../../shared/historyKinds'
import { useAppStore } from '../stores/appStore'

const labels: Record<HistoryStatus['status'], string> = {
  unbound: '尚未绑定', idle: '已绑定', running: '正在同步', paused: '已暂停', offline: '等待自动重试', partial: '部分完成', completed: '同步完成',
}

function duration(ms:number) {
  const seconds=Math.max(0,Math.floor(ms/1000))
  return [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(n=>String(n).padStart(2,'0')).join(':')
}

function RunClock({status}:{status: HistoryStatus}) {
  const [now,setNow]=useState(Date.now)
  const samples=useRef<Array<{at:number;n:number}>>([])
  const finished=status.finishedAt
  const ended=!!finished || status.status==='completed' || status.status==='partial'
  const running=status.status==='running' && !status.initialScanComplete && !status.legacyRecovery?.checkingReport
  const total=status.sessionProgress?.length || status.totalSessions
  const completed=status.completedSessions
  useEffect(()=>{
    samples.current=[]
    setNow(Date.now())
    if (ended) return
    const timer=setInterval(()=>setNow(Date.now()),1000)
    return ()=>clearInterval(timer)
  },[status.runId,status.status,finished,ended,running])
  useEffect(()=>{
    if(!running || !total)return
    const list=samples.current
    if(list.length && completed<list[list.length-1].n) list.length=0
    list.push({at:now,n:completed})
    while(list.length>1 && list[0].at<now-300000)list.shift()
  },[now,running,total,completed])
  const first=samples.current[0], dt=first?now-first.at:0
  const eta=running && first && dt>=30000 && completed-first.n>=2 && total>completed ?
    duration(dt*(total-completed)/(completed-first.n)):null
  const estimate=ended?'已结束':status.status==='paused'?'已暂停':status.status==='offline'?'等待自动重试':
    status.initialScanComplete?(status.mediaPending?'消息扫描完成，附件处理中':'本轮扫描完成'):eta?'约 '+eta:'采样中'
  return <div className="sync-clock" aria-label="任务用时">
    <span>开始时间{status.startEstimated?'（按旧版本地扫描时间估算）':''} <strong>{status.startedAt?new Date(status.startedAt).toLocaleString():'旧任务起点待中台确认'}</strong></span>
    <span>已用时间（含暂停） <strong>{status.startedAt && (!ended || finished)?duration((finished||now)-status.startedAt):'—'}</strong></span>
    <span>预计剩余（本轮会话） <strong>{estimate}</strong></span>
    {status.status==='offline' && <small>下次重试约 {Math.max(0,Math.ceil(((status.retryAfter||now)-now)/1000))} 秒后</small>}
  </div>
}

function ScopeProgress({ rows, counting, limitTarget, activeSessions, preview = false }: { rows: SessionProgress[]; counting?: boolean; limitTarget?:number; activeSessions?:number; preview?: boolean }) {
  const [limit, setLimit] = useState(100)
  const visible = rows.filter(r => r.total > 0)
  const total = visible.reduce((n, r) => n + r.total, 0)
  const done = visible.reduce((n, r) => n + r.processed, 0)
  const failed = visible.reduce((n, r) => n + r.failed, 0)
  const isArchived = (r: SessionProgress) => r.phase==='done' && r.failed===0 && r.total>0 && r.processed===r.total
  const empty = rows.filter(r=>r.phase==='skipped').length
  const archived = rows.filter(isArchived).length
  const accounted = archived + empty
  const boundary = rows.findIndex(r=>!isArchived(r) && r.phase!=='skipped')
  const prefix = boundary<0 ? rows.length : boundary
  const counted = rows.filter(r => r.phase !== 'counting' && r.phase !== 'waiting').length
  const countingNow = counting && counted < rows.length
  const queueLabel = {waiting:'排队中',counting:'正在统计',queued:'等待提交',syncing:'读取 / 提交中',done:'已处理',failed:'失败 / 待处理',skipped:'没有符合条件的消息'}
  const barValue = countingNow ? counted : done
  const barMax = Math.max(1, countingNow ? rows.length : total)
  const groups = visible.filter(r => r.group).length
  return <section className="sync-range-progress" aria-label={preview ? '范围预览' : '历史消息进度'}>
    <strong>{preview ? '范围预览（尚未上传）' : countingNow ? '会话任务队列 · 正在统计' : '会话任务队列 · 消息处理进度'}</strong>
    {!preview && <div aria-label="按会话计算的归档进度">
      <p><strong>已核实完成 {accounted.toLocaleString()} / {rows.length.toLocaleString()} 个会话（{rows.length ? (100*accounted/rows.length).toFixed(1) : '0.0'}%）</strong></p>
      <progress aria-label="已核实会话占比" max={rows.length || 1} value={accounted}/>
      <small>有消息且全部确认 {archived} / {rows.length}（{rows.length ? (100*archived/rows.length).toFixed(1) : '0.0'}%），范围内无消息 {empty} 个。按本任务名单，从头连续完成 {prefix} 个。待核对和部分完成的会话另计。</small>
    </div>}
    {!preview && <span className="sync-percent">{Math.min(100, Math.floor(100 * barValue / barMax))}%</span>}
    {countingNow ? <p>已开始处理 {counted} / {rows.length} 个会话</p> :
      <p>{visible.length - groups} 位联系人、{groups} 个群聊，共 {total} 条符合条件的消息。</p>}
    {!preview && <><progress aria-label={countingNow ? '会话统计进度' : '总消息处理进度'} max={barMax} value={barValue}/>
      {!countingNow && <small>已处理 {done} / {total} 条，其中待核对 {failed} 条。附件单独统计。</small>}</>}
    {!preview && <p className="sync-note">自适应并发：当前处理 {activeSessions ?? 0} 个会话，上限 {limitTarget ?? 16} 个（6～120）。进度自动保存；断线后按原范围继续，同一轮已完成的会话不会重扫。附件另计。</p>}
    <div className="sync-contact-progress" tabIndex={0} aria-label="各会话消息数和处理进度">
      {rows.slice(0,limit).map(r => <div key={r.id}><span>{r.name} <small>{r.group ? '群聊' : '私聊'}</small></span>
        {!preview && !r.singlePass && r.total > 0 && <progress aria-label={r.name + '处理进度'} max={Math.max(1,r.total)} value={r.processed}/>}
        <span>{r.singlePass ? '边读边传 · 已处理 '+r.processed+' 条' : preview || countingNow ? r.total + ' 条' : r.processed + ' / ' + r.total}
          {!preview && ' · ' + (r.phase === 'done' && !r.failed && r.processed > 0 ? '消息处理成功' : queueLabel[r.phase])}
          {!preview && r.processed > 0 && (' · 已确认 ' + Math.max(0, r.processed - r.failed))}
          {r.issue && <small className="queue-error"> · {r.issue}</small>}
          {r.failed > 0 && ' · 待核对 ' + r.failed}</span></div>)}
    </div>
    {rows.length > limit && <button onClick={() => setLimit(limit + 100)}>显示更多会话（已显示 {limit} / {rows.length}）</button>}
  </section>
}

export default function HistorySyncPage() {
  const location = useLocation()
  const isDbConnected = useAppStore(state => state.isDbConnected)
  const dbConnectionError = useAppStore(state => state.dbConnectionError)
  const selected = new URLSearchParams(location.search).get('session')
  const [status, setStatus] = useState<HistoryStatus | null>(null)
  const [origin, setOrigin] = useState('https://zt.hmed1991.com')
  const [code, setCode] = useState('')
  const [sessions, setSessions] = useState<Array<{ id: string; name: string; group: boolean; ordinal?:number }>>([])
  const [options, setOptions] = useState<HistoryOptions>({ sessions: selected ? [selected] : [], start: 0, end: 0, media: true, continuous: true })
  const kinds = options.kinds ?? allHistoryKinds
  const [range, setRange] = useState({ start: '', end: '' })
  const [choose, setChoose] = useState(Boolean(selected))
  const [byNumber, setByNumber] = useState(false)
  const [first, setFirst] = useState('1')
  const [last, setLast] = useState('')
  const maxOrdinal = sessions.reduce((n,s)=>Math.max(n,s.ordinal || 0),0)
  const bounds = { first:Number(first), last:Number(last || maxOrdinal), owner:status?.accountWxid || '' }
  const numbered = byNumber ? sessions.filter(s=>s.ordinal && s.ordinal >= bounds.first && s.ordinal <= bounds.last) : []
  const invalidNumber = byNumber && (!Number.isSafeInteger(bounds.first) || !Number.isSafeInteger(bounds.last) ||
    bounds.first < 1 || bounds.last > maxOrdinal || bounds.first > bounds.last || !numbered.length)
  const [search, setSearch] = useState('')
  const [review, setReview] = useState<Awaited<ReturnType<typeof window.electronAPI.historySync.review>> | null>(null)
  const [busy, setBusy] = useState(false)
  const [transfer,setTransfer] = useState<Awaited<ReturnType<typeof window.electronAPI.historySync.metrics>>|null>(null)
  const currentRun = status?.runId
  const syncState = status?.status
  useEffect(() => {
    setTransfer(null)
    if (!currentRun || !window.electronAPI.historySync.metrics) return
    let cancelled=false
    let timer:ReturnType<typeof setTimeout>|undefined
    async function refresh() {
      try {
        const sample=await window.electronAPI.historySync.metrics()
        if (!cancelled && sample.runId===currentRun) setTransfer(sample)
      } catch { if (!cancelled) setTransfer(null) }
      if (!cancelled && (syncState==='running' || syncState==='offline')) timer=setTimeout(refresh,10000)
    }
    void refresh()
    return ()=>{cancelled=true;clearTimeout(timer)}
  },[currentRun,syncState,status?.accountWxid])
  const [error, setError] = useState('')

  const account = status?.accountWxid
  const bindingId = status?.binding?.id
  const statusRef = useRef(status)
  statusRef.current = status

  useEffect(() => {
    let active = true
    let received = false
    const off = window.electronAPI.historySync.onStatus(value => {
      received = true
      setStatus(value)
    })
    void window.electronAPI.historySync.status().then(value => {
      if (active && !received) setStatus(value)
    }).catch(e => { if (active && !received) setError(String(e)) })
    return () => { active = false; off() }
  }, [])

  useEffect(() => {
    const value = statusRef.current
    if (!value) return
    const restored = value.options.ordinalRange
    const dateLabel = (time: number) => {
      if (!time) return ''
      const date = new Date(time * 1000)
      return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,10)
    }
    const shortcut = selected && !value.runId && !value.detachReason ? [selected] : undefined
    setOptions(shortcut ? { ...value.options, sessions: shortcut } : value.options)
    setChoose(Boolean(shortcut || value.options.sessions.length))
    setByNumber(Boolean(restored))
    setFirst(String(restored?.first ?? 1))
    setLast(restored ? String(restored.last) : '')
    setRange({ start: dateLabel(value.options.start), end: dateLabel(value.options.end) })
    setOrigin(value.origin)
    setCode('')
    setSearch('')
    setReview(null)
    setError('')
  }, [account, bindingId, selected])

  useEffect(() => {
    setSessions([])
    if (!isDbConnected || !account) return
    let cancelled = false
    void window.electronAPI.historySync.sessions().then(value => {
      if (!cancelled) setSessions(value)
    }).catch(e => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [isDbConnected, account])

  const { toasts, add, remove } = useToast()
  const scopeHeading = useRef<HTMLHeadingElement>(null)
  const progressHeading = useRef<HTMLHeadingElement>(null)
  const jump = (heading: HTMLHeadingElement | null) => {
    heading?.focus({ preventScroll: true })
    heading?.scrollIntoView({ block: 'start' })
  }
  const announced = useRef('')
  const following = status?.status === 'running' && status.options.continuous && status.initialScanComplete
  const milestone = following ? 'following' : status?.status === 'completed' || status?.status === 'partial' ? status.status : ''
  const milestoneNotice = milestone ? (following ? '首轮扫描完成，持续补齐已开启。' : milestone === 'partial' ? '本轮已结束，仍有待处理记录。' : '本轮同步已完成。') : ''
  useEffect(() => {
    if (!milestone || !status?.runId) return
    const key = status.runId + ':' + milestone
    if (announced.current === key) return
    announced.current = key
    add(milestoneNotice + ' 本次新增 ' + status.inserted + ' 条。', status.failed || status.mediaPending ? 'info' : 'success')
  }, [milestone, milestoneNotice, status?.runId, status?.inserted, status?.failed, status?.mediaPending, add])

  async function action(fn: () => Promise<HistoryStatus>, notice?: string) {
    setBusy(true); setError('')
    try { setStatus(await fn()); if (notice) add(notice) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const draftOptions = { ...options, ordinalRange: byNumber ? bounds : undefined, sessions: byNumber ? numbered.map(s=>s.id) : choose ? options.sessions : [],
    start: range.start ? Math.floor(new Date(range.start + 'T00:00:00').getTime() / 1000) : 0,
    end: range.end ? Math.floor(new Date(range.end + 'T23:59:59').getTime() / 1000) : 0 }
  const draftKey = JSON.stringify([status?.accountWxid, status?.binding?.id, draftOptions])
  const [preview, setPreview] = useState<{key: string; rows: SessionProgress[]; total?: number} | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const previewRequest = useRef<{id:string; key:string} | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let buffer: SessionProgress[] = [], batchId = ''
    const off = window.electronAPI.historySync.onPreviewRow?.(({requestId,row,total}) => {
      const req = previewRequest.current
      if (!req || req.id !== requestId) return
      if (batchId !== requestId) { clearTimeout(timer); timer = undefined; buffer = []; batchId = requestId }
      buffer.push(row)
      if (!timer) timer = setTimeout(() => {
        timer = undefined
        const delta = buffer; buffer = []
        if (previewRequest.current?.id === requestId)
          setPreview(prev => ({key:req.key, rows:[...(prev?.key === req.key ? prev.rows : []),...delta],total}))
      }, 100)
    })
    return () => { off?.(); clearTimeout(timer) }
  }, [])
  async function previewRange() {
    setBusy(true); setPreviewing(true); setError(''); setPreview(null)
    const id = crypto.randomUUID(); previewRequest.current = {id,key:draftKey}
    try { setPreview({key: draftKey, rows: await window.electronAPI.historySync.preview(draftOptions,id)}) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { previewRequest.current = null; setBusy(false); setPreviewing(false) }
  }
  function start() {
    if (kinds.length !== allHistoryKinds.length && status?.typeFilterVersion !== 1) {
      setError('请完全退出 WeFlow 并重新启动，以启用消息类型筛选'); return
    }
    if (!isDbConnected) { setError('请先在数据库设置中连接可用的微信读取组件'); return }
    if (invalidNumber) { setError('请输入有效的起止序号'); return }
    if (!byNumber && choose && !options.sessions.length) { setError('请至少选择一个会话'); return }
    void action(() => window.electronAPI.historySync.start(draftOptions), '已按所选范围开始同步。')
  }

  const running = status?.status === 'running' || status?.status === 'offline'
  const bound = Boolean(status?.binding)
  const paused = status?.status === 'paused'
  const hasRun = Boolean(bound && status?.runId)
  const issues = Boolean(status?.failed || status?.mediaPending || status?.problems.length)
  const cycleTitle = following ? '本轮扫描已完成，持续补齐已开启' : paused ? '同步已暂停' :
    status?.status === 'completed' ? '本次同步已完成' : status?.status === 'partial' ? '本轮结束，仍有待处理记录' :
    status?.status === 'offline' ? '等待自动重试' : '正在同步所选记录'
  const pauseSync = () => void action(() => window.electronAPI.historySync.pause(), '已暂停后续扫描，已入库记录保留。')
  const resumeSync = () => void action(async () => {
    const value = await window.electronAPI.historySync.resume()
    if (value.status === 'running') add('已按原范围继续同步。')
    return value
  })
  const unbindSync = async () => {
    setError('')
    try { setStatus(await window.electronAPI.historySync.unbind()) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  return <div className="history-sync-page">
    <ToastProvider toasts={toasts} onRemove={remove} />
    <header><CloudUpload size={30} /><div><h1>同步到汉小密中台</h1><p>把本机聊天记录补入中台同一个微信的会话中。</p></div>
      <span className={`sync-status ${running ? 'active' : ''}`}>{following ? '首轮已扫描 · 持续补齐中' : status ? labels[status.status] : '正在读取状态'}</span></header>
    {hasRun && status && <section className="sync-card sync-outcome" aria-labelledby="sync-outcome-title">
      <div><h2 id="sync-outcome-title" role="status">{cycleTitle}</h2><RunClock status={status}/>
        <p><strong>本次新增 {status.inserted} 条</strong> · {status.binding?.account_name}
          {status.lastSuccess && <> · 最近确认 {new Date(status.lastSuccess).toLocaleTimeString()}</>}</p>
        <p className="sync-note">{following ? '保持开启会定期检查所选范围。现在暂停也会保留已入库的消息。' :
          paused ? '继续会沿用原来的会话、日期和消息类型。要换一批聊天，请先修改范围。' :
          running ? '暂停会停止后续扫描，已提交的批次可以完成。' : '已入库的消息保留，你可以查看结果或选择下一批聊天。'}
          {issues && ' 还有记录或附件需处理，请查看同步进度。'}</p></div>
      <div className="sync-outcome-actions">
        {running ? <button className="primary" disabled={busy} onClick={pauseSync}><Pause size={16}/>暂停同步</button> :
         paused ? <button className="primary" disabled={busy || !isDbConnected} onClick={resumeSync}><Play size={16}/>按原范围继续</button> : null}
        {!running && <button disabled={busy} onClick={() => jump(scopeHeading.current)}>更改同步范围</button>}
        {paused && <button disabled={busy || !isDbConnected} onClick={() => void action(() => window.electronAPI.historySync.rescan(), '已从头核对原范围，已入库的消息会保留。')}>重新扫描原范围</button>}
        <button onClick={() => jump(progressHeading.current)}>查看同步进度</button>
      </div>
      {(error || status.error) && <p role="alert" className="sync-error">{error || status.error}</p>}
    </section>}
    <section className="sync-card">
      <h2>连接与账号</h2>
      {status?.detaching ? <p role="status">正在停止原任务并保存进度。中台已接收的批次可能继续入库。</p> :
        !bound && status?.detachReason && <p role="status">
          {status.detachReason === 'account-change' ? '微信已切换，原同步绑定已解除，进度已保留。' : '本机已解除同步绑定，进度已保留。'}
        </p>}
      {!!status?.revocationsPending && <p className="sync-note" role="status">还有 {status.revocationsPending} 个旧绑定等待中台确认撤销。WeFlow 会自动重试。</p>}
      {status?.recovering && <p className="sync-note" role="status">
        已找到该微信的原任务。{paused ? '点击「按原范围继续」核对待确认批次并续传。' : '可查看原任务的对账报告。'}
      </p>}
      <div className="sync-account"><span>本地微信</span><strong>{status?.accountWxid || '请先连接微信数据库'}</strong></div>
      {bound ? <>
        <div className="sync-account"><span>目标中台</span><strong>{status!.binding!.tenant_name} · {status!.binding!.account_name}</strong></div>
        <div className="sync-account"><span>微信身份</span><code>{status!.binding!.account_wxid}</code></div>
        <p className="sync-note">{status!.origin} · 原有客户资料、员工归属和微信登录状态保持不变。</p>
        <button onClick={() => void unbindSync()}>{running ? '停止同步并解除绑定' : '解除同步绑定'}</button>
      </> : <div className="sync-binding">
        <label>中台地址<input value={origin} onChange={e => setOrigin(e.target.value)} placeholder="https://zt.hmed1991.com" /></label>
        <label>绑定码<input value={code} onChange={e => setCode(e.target.value)} placeholder="在中台微信账号列表点击「本地历史同步」获取" autoComplete="off" /></label>
        <button className="primary" disabled={busy || status?.detaching || !code.trim()} onClick={() => void action(async () => {
          const value = await window.electronAPI.historySync.bind(origin, code); setCode(''); return value
        })}><Link2 size={16} />绑定同一个微信</button>
        <p className="sync-note">绑定码 10 分钟内有效。首次绑定后，后续可直接同步。</p>
      </div>}
    </section>
    <section className="sync-card">
      <h2 ref={scopeHeading} tabIndex={-1}>同步范围</h2>
      {!isDbConnected && <p className="sync-error" role="status">本地微信数据库尚未连接，绑定配置可以查看，连接成功后才能读取和同步聊天。{dbConnectionError || ''}</p>}
      <fieldset disabled={running || busy || status?.detaching}>
        <div className="sync-options"><label><input type="radio" checked={!byNumber && !choose} onChange={() => { setByNumber(false);setChoose(false) }} />全部私聊和群聊</label>
          <label><input type="radio" checked={!byNumber && choose} onChange={() => {setByNumber(false);setChoose(true)}} />选择会话</label>
          <label><input type="radio" checked={byNumber} onChange={()=>setByNumber(true)} />按会话序号</label></div>
        {byNumber && <><div className="sync-options"><label>从第 <input type="number" min="1" max={maxOrdinal} value={first} onChange={e=>setFirst(e.target.value)} /> 位</label>
          <label>到第 <input type="number" min="1" max={maxOrdinal} value={last} placeholder={String(maxOrdinal)} onChange={e=>setLast(e.target.value)} /> 位</label></div>
          <p className="sync-note">{invalidNumber ? '当前范围无效，请检查序号。' : '本段 '+numbered.length+' 个会话（含群聊）'} · 名单共 {sessions.length} 个，最大序号 {maxOrdinal}。{!invalidNumber && `本段之后还有 ${sessions.filter(s => (s.ordinal || 0) > bounds.last).length} 个会话。`}新会话追加到末尾。</p></>}
        {choose && !byNumber && <><input className="sync-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索联系人或群聊" />
          <div className="sync-session-list">{sessions.filter(s => s.name.includes(search) || s.id.includes(search)).map(s =>
            <label key={s.id}><input type="checkbox" checked={options.sessions.includes(s.id)} onChange={e => setOptions({ ...options, sessions: e.target.checked ? [...options.sessions, s.id] : options.sessions.filter(id => id !== s.id) })} />
              <span>{s.ordinal ? s.ordinal + '. ' : ''}{s.name}</span><small>{s.group ? '群聊' : '私聊'}</small></label>)}
          </div></>}
        <div className="sync-options"><label>开始日期<input type="date" value={range.start} onChange={e => setRange({ ...range, start: e.target.value })} /></label>
          <label>结束日期<input type="date" value={range.end} onChange={e => setRange({ ...range, end: e.target.value })} /></label><span className="sync-note">留空则同步全部本地历史</span></div>
        <strong>消息类型</strong>
        <div className="sync-options" style={{ flexWrap: 'wrap' }}><label><input type="checkbox" checked={kinds.length === allHistoryKinds.length}
          onChange={e => setOptions({ ...options, kinds: e.target.checked ? [...allHistoryKinds] : [] })} />全选</label>
          {allHistoryKinds.map(k => <label key={k}><input type="checkbox" checked={kinds.includes(k)}
            onChange={e => setOptions({ ...options, kinds: e.target.checked ? [...kinds, k] : kinds.filter(x => x !== k) })} />{historyKinds[k]}</label>)}</div>
        <p className="sync-note">{!kinds.length ? '请至少选择一种消息类型。' : '仅上传勾选的消息。要传图片、视频等附件本身，请同时勾选「同步附件」。'}</p>
        <div className="sync-options"><label><input type="checkbox" checked={options.media} onChange={e => setOptions({ ...options, media: e.target.checked })} />同步附件</label>
          <label><input type="checkbox" checked={options.continuous} onChange={e => setOptions({ ...options, continuous: e.target.checked })} />持续补齐（应用运行期间）</label></div>
      </fieldset>
      <p className="sync-note">历史同步不会触发 AI 回复、营销发送或增加未读提醒。原生微信新消息继续按中台原有规则处理。</p>
      {status?.status === 'paused' && <p className="sync-note">更改范围后点「按所选范围开始」将结束旧任务并重新扫描，已入库消息保留。「按原范围继续」会沿用原任务设置。</p>}
      {!running && preview?.key === draftKey && <>{previewing && <p role="status">正在统计，已返回 {preview.rows.length} / {preview.total} 个会话</p>}<ScopeProgress rows={preview.rows} preview/></>}
      {!running && <div className="sync-actions">
        <button disabled={busy || !bound || !isDbConnected || !kinds.length || invalidNumber || (!byNumber && choose && !options.sessions.length)} onClick={() => void previewRange()}>{previewing ? '正在统计…' : '先统计所选范围'}</button>
        <button className="primary" disabled={busy || !bound || !isDbConnected || !kinds.length || invalidNumber} onClick={start}><CloudUpload size={17} />{paused ? '按所选范围开始' : '开始同步'}</button>
        {hasRun && issues && <button disabled={busy || !isDbConnected} onClick={() => void action(() => window.electronAPI.historySync.retry(), '已开始重试。')}><RefreshCw size={16} />重试失败项</button>}
      </div>}
      {running && <p className="sync-note">要调整这些选项，请先<button className="sync-inline" disabled={busy} onClick={pauseSync}>暂停同步</button>。</p>}
      {!hasRun && (error || status?.error) && <p role="alert" className="sync-error">{error || status?.error}</p>}
    </section>
    {bound && <section className="sync-card">
      <h2 ref={progressHeading} tabIndex={-1}>同步进度</h2>
      <button disabled={busy || !status?.runId} onClick={async () => {
        setBusy(true); setError('')
        try { setReview(await window.electronAPI.historySync.review()) } catch (e) { setError(String(e)) } finally { setBusy(false) }
      }}>查看 / 刷新会话对账</button>
      <button disabled={busy || !isDbConnected || status?.status !== 'paused'} onClick={() => void action(() => window.electronAPI.historySync.rescan(), '已开始重新核对原任务范围。')}>迁移后重新核对并补传</button>
      <p className="sync-note">手机迁移完成后，先暂停，再重新核对原任务日期范围。持续补齐会重读近期消息，累计读取次数不代表唯一消息数。</p>
      {review && review.id === status?.runId && <details open><summary>中台原任务对账：已确认 {review.partitions.reduce((n,p)=>n+p.matched,0).toLocaleString()} 条，待核对 {review.partitions.reduce((n,p)=>n+p.unresolved,0).toLocaleString()} 条（按来源去重）</summary>
        <div style={{maxHeight: 360, overflow: 'auto'}}><table><thead><tr>{['会话','日期','记录','已对应','待核对','附件已传 / 缺失'].map(x => <th key={x}>{x}</th>)}</tr></thead><tbody>
        {review.partitions.map(p => <tr key={p.session_wxid + ':' + p.date}><td>{sessions.find(s => s.id === p.session_wxid)?.name || p.session_wxid}</td><td>{p.date === 'unknown' ? '日期未记录' : p.date}</td>
        <td>{p.source_records}</td><td>{p.matched}</td><td>{p.unresolved}</td><td>{p.media.uploaded || 0} / {p.media.missing || 0}</td></tr>)}</tbody></table></div></details>}
      <button disabled={busy || !status?.runId} onClick={() => {
        setBusy(true)
        void window.electronAPI.historySync.report().catch(e => setError(String(e))).finally(() => setBusy(false))
      }}>保存对账报告</button>
      {status?.options.ordinalRange && status.sessionProgress && (() => {
        const total = status.options.sessions.length
        const done = Math.min(total,status.completedSessions)
        return <div className="sync-range-progress"><strong>第 {status.options.ordinalRange.first}～{status.options.ordinalRange.last} 位 · 本段会话进度</strong>
          <progress aria-label="本段会话进度" max={total || 1} value={done}/><small>已处理 {done} / {total}，本段剩余 {total-done} 个会话。名单中位于本段之后的还有 {sessions.filter(s => (s.ordinal || 0) > status.options.ordinalRange!.last).length} 个。待核对消息另计。</small></div>
      })()}
      {status?.legacyRecovery?.reportConfirmed !== undefined && <div className="sync-range-progress" role="status">
        <strong>{status.legacyRecovery.checkingReport ? '正在从中台重建会话断点' : '已读取原任务的中台对账报告'}</strong>
        <p>中台已确认来源 {status.legacyRecovery.reportConfirmed.toLocaleString()} 条，待核对 {status.legacyRecovery.reportPending} 条，涉及 {status.legacyRecovery.reportPeers} 个会话。</p>
        <p>本次比对已检查 {status.legacyRecovery.examined} / {status.legacyRecovery.planned} 个候选会话；已按摘要恢复 {status.legacyRecovery.restoredPeers || 0} 个完整会话，跳过 {status.legacyRecovery.restoredMessages || 0} 条正文。</p>
      </div>}
      {status?.sendLimit !== undefined && <p>发送并发上限 {status.sendLimit} · {status.feedbackLabel}</p>}
      {status?.readerCount !== undefined && <p className="sync-note">本批目标 {status.batchRows ?? 128} 条 / {Math.round((status.batchBytes ?? 524288)/1024)} KiB · 读取线程 {status.readerCount} / 120，查询中 {status.activeReaders ?? 0} · 对账请求 {status.activeChecks ?? 0} · 正文或附件提交 {status.activeUploads ?? 0}</p>}
      {status?.sessionProgress && <ScopeProgress limitTarget={status.concurrencyLimit} activeSessions={status.activeSessions} rows={status.sessionProgress} counting={status.progressPhase === 'counting'}/>}
      {status?.legacyRecovery?.runId && status.legacyRecovery.runId===currentRun && <section className="sync-range-progress" role="status">
        <strong>已接入旧版原任务</strong><p>旧版累计已读取 {status.legacyRecovery.previousScanned.toLocaleString()} 条次。逐条编号对账另跳过正文 {status.legacyRecovery.checked.toLocaleString()} 条。</p>
        {status.sessionProgress && <p>当前本地记录共 {status.sessionProgress.length} 个会话，已完成或无匹配记录 {status.sessionProgress.filter(r=>r.phase==='done' || r.phase==='skipped').length} 个。待接续会话包括：{status.sessionProgress.filter(r=>r.phase!=='done' && r.phase!=='skipped').slice(0,3).map(r=>r.name).join('、') || '无'}。</p>}
        <p>按原范围继续即可。已完成的会话沿用本机进度；没有精确断点的部分先核对来源编号，再补传缺失记录。</p>
      </section>}
      {currentRun && <section aria-label="上传与中台队列"><h3>上传与中台队列</h3>
        {transfer?.runId===currentRun && transfer ? <>
          <p>本机近 60 秒已获回执的正文和附件速率 <strong>{(transfer.bytesPerSecond/1024).toFixed(1)} KiB/s</strong> · 编号对账 {((transfer.checkBytesPerSecond || 0)/1024).toFixed(1)} KiB/s（{transfer.checkRequests || 0} 次/分钟） · 待确认 {transfer.clientPending} 批 · 已上传并对账 {transfer.clientAcknowledged.toLocaleString()} 条次</p>
          {transfer.server ? <>
            <p>中台累计接收 <strong>{transfer.server.accepted_batches.toLocaleString()} 批</strong> · 已消费 {transfer.server.committed_batches.toLocaleString()} 批 · 新增入库 <strong>{transfer.server.inserted.toLocaleString()} 条</strong></p>
            <p>{transfer.server.queue_enabled ? `排队 ${transfer.server.queued_batches} 批 · 写入中 ${transfer.server.processing} / ${transfer.server.worker_limit} · 空闲写入槽 ${transfer.server.free_slots ?? '—'} · 批次失败 ${transfer.server.failed_batches} · 最老未完成批次 ${transfer.server.oldest_seconds} 秒` : '本任务采用直接入库模式'}</p>
            <p>最近 60 秒处理 {transfer.server.processed_per_minute} 条次，其中新增 {transfer.server.inserted_per_minute} 条 · 更新于 {new Date(transfer.server.sampled_at).toLocaleTimeString()}</p>
          </> : <p role="status">{transfer.counts ? `中台原任务累计新增 ${(transfer.counts.inserted || 0).toLocaleString()} 条，已有匹配 ${(transfer.counts.existing || 0).toLocaleString()} 次，待处理 ${(transfer.counts.failed || 0).toLocaleString()} 次。` : '暂未取得中台原任务统计。'} 详细队列深度请在中台微信账号页查看。</p>}
          <p>近一分钟典型耗时 · 数据库读取 {transfer.readMs == null ? '—' : transfer.readMs+' ms'} · 批次提交至回执 {transfer.batchMs == null ? '—' : transfer.batchMs+' ms'} · 编号对账 {transfer.checkMs == null ? '—' : transfer.checkMs+' ms'}</p>
          <small>上传速度按本机最近一分钟成功返回的消息批次和附件请求体计算。只核对编号、在本地校验或等待回执时，此速度可为 0。</small>
        </> : <p>等待读取统计…</p>}</section>}
      <div className="sync-metrics">{[
        ['会话', `${status!.completedSessions} / ${status!.totalSessions}`], ['已读取', status!.scanned], ['本任务新增入库', (transfer?.runId===currentRun ? transfer?.server?.inserted ?? transfer?.counts?.inserted : undefined) ?? status!.inserted],
        ['累计匹配次数', status!.existing], ['需处理', status!.failed], ['附件已上传', status!.mediaUploaded], ['附件待处理', status!.mediaPending],
      ].map(([label, value]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
      {status?.currentSession && <p>当前会话：{status.currentSession}</p>}
      <p className="sync-note">最后成功同步：{status?.lastSuccess ? new Date(status.lastSuccess).toLocaleString() : '尚未同步'}</p>
      {Boolean(status?.problems.length) && <><h3>需要处理的记录</h3><p className="sync-note">旧编号待核对表示尚未确认对应哪条中台消息，无需合并会话。仅遇到“重复会话”时才使用中台查重。附件结果与消息结果分开计算。</p>
        <button onClick={() => void window.electronAPI.shell.openExternal(origin + '/accounts')}>打开中台微信账号</button>
        <div className="sync-problems">{status!.problems.map((p, i) => <div key={i}><strong>{sessions.find(s => s.id === p.session_wxid)?.name || p.session_wxid}</strong><span>{p.error}</span></div>)}</div>
      </>}
    </section>}
  </div>
}
