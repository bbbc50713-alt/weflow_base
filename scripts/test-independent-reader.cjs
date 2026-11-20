const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),assert=require('assert/strict')
const esbuild=require('esbuild'),Module=require('module'),koffi=require('koffi')
const root=path.resolve(__dirname,'..')
const dll=path.join(root,'resources/independent-reader/win32/x64/sqlite3mc.dll')
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'weflow-readonly-test-'))
const api=koffi.load(dll)
const open=api.func('int sqlite3_open_v2(const char*, _Out_ void**, int, const char*)')
const exec=api.func('int sqlite3_exec(void*, const char*, void*, void*, void*)')
const close=api.func('int sqlite3_close_v2(void*)')
function fixture(file,key,wal=false){
 const out=[null];assert.equal(open(file,out,6,null),0)
 const db=out[0]
 const sql=(value)=>assert.equal(exec(db,value,null,null,null),0,'fixture SQL failed')
 sql('PRAGMA cipher=sqlcipher');sql('PRAGMA legacy=4');sql(`PRAGMA key="x'${key}'"`)
 if(wal)sql('PRAGMA journal_mode=WAL')
 sql('CREATE TABLE records(server_id INTEGER, content TEXT, data BLOB)')
 sql("INSERT INTO records VALUES(9223372036854775801,'测试消息',x'010203')")
 return {db,sql}
}
const key=crypto.randomBytes(32).toString('hex')
function load(file){
 const result=esbuild.buildSync({entryPoints:[file],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',absWorkingDir:root})
 const mod=new Module(path.join(__dirname,'independent-test-bundle.cjs'));mod.filename=path.join(__dirname,'independent-test-bundle.cjs');mod.paths=module.paths
 mod._compile(result.outputFiles[0].text,mod.filename);return mod.exports
}
let writer,store
async function main(){
try{
 const {SnapshotStore,SqliteReader}=load('electron/services/independent-reader/SqliteReader.ts')
 const account=path.join(temp,'account');fs.mkdirSync(account)
 const file=path.join(account,'messages.db');writer=fixture(file,key,true)
 const fingerprint=()=>Object.fromEntries(['','-wal','-shm'].filter(s=>fs.existsSync(file+s)).map(s=>[s,crypto.createHash('sha256').update(fs.readFileSync(file+s)).digest('hex')]))
 const before=fingerprint()
 store=new SnapshotStore(dll,account,path.join(temp,'snapshots'),key)
 const db=store.database(file)
 const rows=db.query('SELECT * FROM records WHERE content=?',['测试消息'])
 assert.equal(rows.length,1);assert.equal(rows[0].server_id,'9223372036854775801');assert.deepEqual(rows[0].data,Buffer.from([1,2,3]))
 assert.throws(()=>db.query('DELETE FROM records'),/只允许查询/)
 assert.throws(()=>db.query("ATTACH DATABASE 'other.db' AS other"),/只允许查询/)
 assert.throws(()=>db.query('SELECT 1; DELETE FROM records'),/单条/)
 assert.throws(()=>db.query('WITH x AS (SELECT 1) DELETE FROM records'),/写操作|失败/)
 assert.deepEqual(fingerprint(),before,'source DB/WAL/SHM changed')
 writer.sql("INSERT INTO records VALUES(9223372036854775802,'新消息',x'04')")
 assert.equal(store.database(file).query('SELECT count(*) n FROM records')[0].n,2)
 const wrong=new SnapshotStore(dll,account,path.join(temp,'wrong-key'),'00'.repeat(32))
 assert.throws(()=>wrong.database(file),/无法读取加密数据库/);wrong.close()
 assert.throws(()=>store.database(path.join(root,'package.json')),/不属于/)
 store.close();store=null;close(writer.db);writer=null

 const {IndependentReader}=load('electron/services/independent-reader/IndependentReader.ts')
 const acct=path.join(temp,'wxid_owner_ab12'),storage=path.join(acct,'db_storage')
 fs.mkdirSync(storage,{recursive:true})
 const create=(name,sqls)=>{const f=fixture(path.join(storage,name),key);for(const sql of sqls)f.sql(sql);close(f.db)}
 create('session.db',["CREATE TABLE SessionTable(username TEXT,sort_timestamp INTEGER,last_timestamp INTEGER,summary TEXT)","INSERT INTO SessionTable VALUES('wxid_friend',100,100,'最近消息'),('room@chatroom',101,101,'群消息')"])
 create('contact.db',["CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT,local_type INTEGER)","INSERT INTO contact VALUES('wxid_friend','朋友','备注',1),('wxid_member','群成员','',1),('room@chatroom','测试群','',2)"])
 const tableFor=s=>'Msg_'+crypto.createHash('md5').update(s).digest('hex')
 const friendTable=tableFor('wxid_friend'),groupTable=tableFor('room@chatroom')
 const messageSchema=name=>`CREATE TABLE ${name}(local_id INTEGER,server_id INTEGER,local_type INTEGER,create_time INTEGER,sort_seq INTEGER,real_sender_id INTEGER,message_content TEXT,compress_content BLOB)`
 const identities=["CREATE TABLE Name2Id(user_name TEXT)","INSERT INTO Name2Id VALUES('wxid_owner'),('wxid_friend'),('wxid_member')"]
 create('message_0.db',[...identities,messageSchema(friendTable),messageSchema(groupTable),
  `INSERT INTO ${friendTable} VALUES(1,9223372036854775801,1,100,1001,2,'你好',NULL),(2,9223372036854775802,1,100,1002,1,'收到',NULL)`,
  `INSERT INTO ${groupTable} VALUES(1,-16,1,101,1003,3,'群聊内容',NULL)`])
 create('message_1.db',[...identities,messageSchema(friendTable),`INSERT INTO ${friendTable} VALUES(1,9223372036854775804,1,100,1001,2,'另一分片同秒记录',NULL)`])
 const hashes=()=>Object.fromEntries(fs.readdirSync(storage).map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync(path.join(storage,n))).digest('hex')]))
 const original=hashes(),core=new IndependentReader()
 await core.dispatch('setPaths',{resourcesPath:path.join(root,'resources'),userDataPath:path.join(temp,'app-data')})
 assert.equal((await core.dispatch('testConnection',{accountDir:acct,hexKey:key})).success,true)
 assert.equal(await core.dispatch('open',{accountDir:acct,hexKey:key}),true)
 assert.equal((await core.dispatch('getSessions')).sessions.length,2)
 assert.equal((await core.dispatch('getContact',{username:'wxid_friend'})).contact.remark,'备注')
 assert.equal((await core.dispatch('getMessageCount',{sessionId:'wxid_friend'})).count,3)
 const cursor=(await core.dispatch('openMessageCursor',{sessionId:'wxid_friend',batchSize:1,ascending:true})).cursor
 const all=[];for(;;){const p=await core.dispatch('fetchMessageBatch',{cursor});assert.equal(p.success,true,p.error);all.push(...p.rows);if(!p.hasMore)break}
 assert.deepEqual(all.map(r=>r.server_id),['9223372036854775801','9223372036854775804','9223372036854775802'])
 assert.deepEqual(all.map(r=>r.is_send),[0,0,1]);assert.equal(new Set(all.map(r=>r.db_name+':'+r.table_name+':'+r.local_id)).size,3)
 const group=(await core.dispatch('getMessages',{sessionId:'room@chatroom',limit:10})).messages
 assert.equal(group[0].sender_username,'wxid_member');assert.equal(group[0].is_send,0);assert.equal(group[0].server_id,'18446744073709551600')
 assert.equal((await core.dispatch('getMessageByServerId',{sessionId:'room@chatroom',svrid:'18446744073709551600'})).row.local_id,1)
 const backwards=(await core.dispatch('getMessages',{sessionId:'wxid_friend',limit:3})).messages
 assert.deepEqual(backwards.map(r=>r.server_id),all.map(r=>r.server_id).reverse())
 assert.equal((await core.dispatch('getSessionMessageTypeStats',{sessionId:'wxid_friend'})).data.total_messages,3)
 assert.equal((await core.dispatch('execQuery',{kind:'contact',sql:'DELETE FROM contact'})).success,false)
 assert.equal((await core.dispatch('deleteMessage',{sessionId:'wxid_friend',localId:1})).success,false)
 assert.equal((await core.dispatch('testConnection',{accountDir:acct,hexKey:'00'.repeat(32)})).success,false)
 assert.equal(await core.dispatch('isConnected'),true)
 assert.equal((await core.dispatch('getSessions')).sessions.length,2)
 await core.dispatch('close')
 assert.deepEqual(hashes(),original,'account databases modified by reader')

 if(process.argv.includes('--large')) {
   for (const [name,sql] of [
     ['session.db',"ALTER TABLE SessionTable ADD COLUMN packed_info_data BLOB; WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<12000) INSERT INTO SessionTable SELECT 'test_'||i,100,100,'hello',zeroblob(2048) FROM n"],
     ['contact.db',"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100050) INSERT INTO contact SELECT 'user_'||i,'normal','',1 FROM n; INSERT INTO contact VALUES('gh_test','official','',1)"]
   ]) {
     const handle=[null];assert.equal(open(path.join(storage,name),handle,6,null),0)
     try { assert.equal(exec(handle[0],"PRAGMA cipher=sqlcipher;PRAGMA legacy=4;PRAGMA key=\"x'"+key+"'\";"+sql,null,null,null),0) } finally {close(handle[0])}
   }
   const start=Date.now()
   assert.equal(await core.dispatch('open',{accountDir:acct,hexKey:key}),true)
   const list=await core.dispatch('getSessions')
   assert.equal(list.sessions.length,12002)
   assert(list.sessions.every(r=>!Object.hasOwn(r,'packed_info_data')))
   assert.deepEqual((await core.dispatch('getSessionListSupplement')).contacts.map(c=>c.username),['gh_test'])
   await core.dispatch('close')
   console.log('LARGE_FIXTURE_OK: 12002 sessions, 100054 contacts; open + list + supplement '+(Date.now()-start)+' ms')
 }
 if(process.argv.includes('--workers')) {
  const {Worker}=require('worker_threads')
  const output=path.join(temp,'export.json')
  const result=await new Promise((resolve,reject)=>{
   const worker=new Worker(path.join(root,'dist-electron/exportWorker.js'),{workerData:{mode:'single',sessionId:'wxid_friend',outputPath:output,options:{format:'json',exportMedia:false},dbPath:temp,accountDir:acct,myWxid:'wxid_owner',decryptKey:key,resourcesPath:path.join(root,'resources'),userDataPath:path.join(temp,'export-user'),isPackaged:false}})
   const timer=setTimeout(()=>{void worker.terminate();reject(new Error('export timeout'))},45000)
   worker.on('error',error=>{clearTimeout(timer);reject(error)})
   worker.on('message',message=>{
    if(message.type==='export:result'){clearTimeout(timer);void worker.terminate().then(()=>resolve(message.data))}
    if(message.type==='export:error'){clearTimeout(timer);void worker.terminate();reject(new Error(message.error))}
   })
  })
  assert.equal(result.success,true,result.error)
  const exported=JSON.parse(fs.readFileSync(output,'utf8'))
  assert.equal(exported.messages.length,3)
  assert.deepEqual(new Set(exported.messages.map(m=>m.platformMessageId)),new Set(['9223372036854775801','9223372036854775802','9223372036854775804']))
  assert.deepEqual(hashes(),original,'export changed original databases')
  console.log('EXPORT_WORKER_TEST_PASSED: encrypted database to detailed JSON through independent WCDB worker')
 }
 console.log('READER_ADAPTER_TEST_PASSED: sessions, contacts, multi-shard same-second pagination, direction, group sender, failed-test isolation')
 console.log('SQLITE_READER_TEST_PASSED: encrypted WAL snapshot, int64, blobs, refresh, wrong-key rejection, write denial, unchanged originals')
}finally{
 if(store)store.close();if(writer)close(writer.db)
 if(temp.startsWith(path.join(os.tmpdir(),'weflow-readonly-test-')))fs.rmSync(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100})
}

}
main().catch(e=>{console.error(e);process.exitCode=1})
