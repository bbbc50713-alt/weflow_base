// Real Chromium/React route regression; no native database or real app startup.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'weflow-route-test-'))
const renderer = `
import React, {act, useEffect} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter, Routes, Route, Link, useLocation} from 'react-router-dom'
import RouteGuard from './src/components/RouteGuard'
import HistorySyncPage from './src/pages/HistorySyncPage'
import {useAppStore} from './src/stores/appStore'
window.IS_REACT_ACT_ENVIRONMENT = true
let sessionCalls=0, pageMounts=0, connectCalls=0, location, emitStatus, previewListener, finishPreview
window.electronAPI={chat:{connect:async()=>{connectCalls++;return {success:false,error:'错误码: -101'}}},historySync:{
 status:async()=>({origin:'https://example.test',accountWxid:'wxid_test',status:'unbound',options:{sessions:[],start:0,end:0,media:true,continuous:true},completedSessions:0,totalSessions:0,scanned:0,inserted:0,existing:0,failed:0,mediaPending:0,mediaUploaded:0,problems:[]}),
 onPreviewRow:cb=>{previewListener=cb;return ()=>{}},sessions:async()=>{sessionCalls++;return []},onStatus:cb=>{emitStatus=cb;return ()=>{}}
}}
const assert=(value,message)=>{if(!value)throw new Error(message)}
function DataPage(){useEffect(()=>{pageMounts++},[]);return <div id="data-page">data</div>}
function Harness(){location=useLocation();return <><nav>{['/chat','/sns','/contacts','/ai-reply','/history-sync'].map(p=><Link key={p} id={'link'+p} to={p}>{p}</Link>)}</nav><RouteGuard><Routes>
 <Route path="/history-sync" element={<HistorySyncPage/>}/><Route path="/settings" element={<div>settings</div>}/>
 {['/chat','/sns','/contacts','/ai-reply'].map(p=><Route key={p} path={p} element={<DataPage/>}/>)}</Routes></RouteGuard></>}
const click=async id=>act(async()=>{document.getElementById(id).click();await new Promise(r=>setTimeout(r,20))})
window.__testPromise=(async()=>{
 const root=createRoot(document.getElementById('test'))
 await act(async()=>{useAppStore.getState().setDbConnectionError('错误码: -101');root.render(<MemoryRouter initialEntries={['/history-sync']}><Harness/></MemoryRouter>);await new Promise(r=>setTimeout(r,20))})
 assert(location.pathname==='/history-sync','sync page redirected')
 assert(document.querySelector('.history-sync-page'),'sync configuration not accessible offline')
 assert(sessionCalls===0,'offline sync page invoked native reader')
 for(const p of ['/chat','/sns','/contacts','/ai-reply']){
  await click('link'+p)
  assert(location.pathname===p,'offline route bounced to home: '+p)
  assert(document.querySelector('.route-connection-state'),'connection error not shown')
 }
 assert(pageMounts===0,'protected page mounted before connection')
 await act(async()=>{document.querySelector('.connection-actions button').click();await new Promise(r=>setTimeout(r,20))})
 assert(connectCalls===1 && location.pathname==='/ai-reply','failed retry bounced or repeated')
 assert(document.querySelector('.connection-error').textContent.includes('-101'),'connection error lost')
 await act(async()=>{document.querySelectorAll('.connection-actions button')[1].click()})
 assert(location.pathname==='/settings' && location.state.initialTab==='database','database settings not reachable')
 assert(location.state.backgroundLocation.pathname==='/ai-reply','settings return location lost')
 await click('link/history-sync')
 assert(sessionCalls===0,'reopening offline sync retried native reader')
 await act(async()=>{useAppStore.getState().setDbConnected(true);await new Promise(r=>setTimeout(r,20))})
 assert(sessionCalls===1,'connected sync should load sessions once')
 const running={...await window.electronAPI.historySync.status(),runId:'review-test',initialScanComplete:true,binding:{account_name:'测试微信'},status:'running',inserted:31}
 Object.assign(running,{progressPhase:'done',sessionProgress:[{id:'peer',name:'测试会话',group:false,total:31,processed:31,failed:0,phase:'done'}]})
 window.electronAPI.historySync.metrics=async()=>({runId:running.runId,clientPending:2,clientAcknowledged:3,bytesPerSecond:2048,
   server:{accepted_batches:12,committed_batches:9,queued_batches:2,processing:1,worker_limit:6,failed_batches:0,oldest_seconds:1,inserted:31,processed_per_minute:25,inserted_per_minute:10,sampled_at:'2026-11-20T00:00:00Z',queue_enabled:true}})
 const paused={...running,status:'paused'}
 window.electronAPI.historySync.preview=async(opts,requestId)=>{
   const row={id:'peer',name:'测试会话',group:false,total:31,processed:0,failed:0,phase:'done'}
   previewListener({requestId,row,total:2})
   return new Promise(resolve=>{finishPreview=()=>resolve([row,{...row,id:'broken',name:'慢会话',total:0,phase:'failed',issue:'读取失败'}])})
 }
 window.electronAPI.historySync.pause=async()=>paused
 window.electronAPI.historySync.resume=async()=>running
 await act(async()=>emitStatus(running))
 const panel=()=>document.querySelector('.sync-outcome')
 const btn=(label)=>Array.from(panel().querySelectorAll('button')).find(b=>b.textContent===label)
 assert(document.querySelector('progress[aria-label="总消息处理进度"]').value===31,'overall message progress missing')
 assert(document.querySelector('progress[aria-label="测试会话处理进度"]').max===31,'per-session progress missing')
 assert(document.querySelector('.sync-contact-progress').textContent.includes('消息处理成功'),'successful task result missing')
 assert(document.querySelector('section[aria-label="上传与中台队列"]').textContent.includes('2.0 KiB/s'),'missing client transfer speed')
 assert(document.querySelector('section[aria-label="上传与中台队列"]').textContent.includes('已消费 9 批'),'missing server receipt metrics')
 assert(document.querySelector('[aria-label="已核实会话占比"]').value===1,'server-confirmed session completion metric missing')
 assert(panel().textContent.includes('本次新增 31 条') && panel().textContent.includes('持续补齐已开启'),'missing persistent result')
 assert(document.querySelectorAll('.toast-item').length===1,'missing completion notification')
 await act(async()=>emitStatus({...running,existing:15}))
 assert(document.querySelectorAll('.toast-item').length===1,'poll repeated completion toast')
 await act(async()=>btn('暂停同步').click())
 assert(panel().textContent.includes('同步已暂停') && btn('重新扫描原范围'),'paused controls missing')
 await act(async()=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='先统计所选范围').click())
 await act(async()=>{await new Promise(r=>setTimeout(r,150))})
 assert(document.querySelector('.history-sync-page').textContent.includes('已返回 1 / 2'),'preview did not stream')
 assert(document.querySelector('section[aria-label="范围预览"]').textContent.includes('共 31 条'),'range preview did not render')
 await act(async()=>finishPreview())
 assert(document.querySelector('section[aria-label="范围预览"]').textContent.includes('读取失败'),'failed preview hidden')

 await act(async()=>btn('更改同步范围').click())
 assert(document.activeElement.textContent==='同步范围','range editor not reached')
 await act(async()=>btn('按原范围继续').click())
 assert(btn('暂停同步'),'original task did not resume')

 await click('link/chat')
 assert(pageMounts===1 && document.querySelector('#data-page'),'connected route still blocked')
 await act(async()=>{root.unmount()})
 return {offlineRoutes:5,sessionCalls,connectCalls,pageMounts}
})()
`

try {
  const built = esbuild.buildSync({ stdin: { contents: renderer, loader: 'tsx', resolveDir: root }, bundle: true, write: false,
    platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.scss': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' } })
  fs.writeFileSync(path.join(temp, 'renderer.js'), built.outputFiles[0].text)
  fs.writeFileSync(path.join(temp, 'index.html'), '<html><body><div id="test"></div><script src="renderer.js"></script></body></html>')
  fs.writeFileSync(path.join(temp, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'user-data'));
const timer=setTimeout(()=>{console.error('Route regression timed out');app.exit(1)},30000);
app.whenReady().then(async()=>{try{
 const win=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
 await win.loadFile(path.join(__dirname,'index.html'));
 const result=await win.webContents.executeJavaScript('window.__testPromise');
 console.log('ROUTE_TEST_PASSED '+JSON.stringify(result));clearTimeout(timer);app.exit(0);
}catch(e){console.error(String(e));clearTimeout(timer);app.exit(1)}});
`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [path.join(temp, 'main.cjs')], { env, encoding: 'utf8', windowsHide: true, timeout: 45000 })
  console.log(result.stdout || '')
  if (result.status !== 0) { console.error(result.stderr || result.error || 'Renderer regression failed'); process.exitCode = 1 }
} finally {
  if (temp.startsWith(path.join(os.tmpdir(), 'weflow-route-test-'))) fs.rmSync(temp, { recursive: true, force: true })
}
