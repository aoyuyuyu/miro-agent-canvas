const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {AgentBridge}=require('../electron/agentBridge.cjs'),{SharedHistory}=require('../electron/sharedHistory.cjs')
const run=require('node:util').promisify(require('node:child_process').execFile)
test('跨 Agent 历史共享、分页、幂等发布、持久化与凭证撤销',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'miro-shared-'))
  const native={list:()=>({sessions:[{key:'codex:fixture',provider:'codex',id:'fixture',readable:true,title:'原生会话'}],providers:[]}),read:async()=>({key:'codex:fixture',messages:[{role:'user',text:'原生问题'}],cwd:'私有路径',origin:'native'})}
  const shared=new SharedHistory({directory,native,live:()=>[]}),bridge=new AgentBridge({directory,emit:()=>{},sharedHistory:shared})
  await bridge.start()
  const invite=JSON.parse(fs.readFileSync(bridge.invitation().file)),request=async(route,token,data,origin)=>{const response=await fetch(bridge.url+route,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+token,...(origin?{Origin:origin}:{})},body:data?JSON.stringify(data):undefined});return {status:response.status,body:await response.json()}}
  try{
    const a=(await request('/register',invite.token,{name:'Antigravity'})).body,b=(await request('/register',invite.token,{name:'WorkBuddy'})).body
    const batch={sessionId:'own-1',title:'共同可见的问题',messages:Array.from({length:140},(_,i)=>({role:i%2?'assistant':'user',text:'正文 '+i}))}
    const publish='/agents/'+a.agentId+'/history-publish',read='/agents/'+b.agentId+'/history-read',list='/agents/'+b.agentId+'/history-list'
    const first=(await request(publish,a.token,batch)).body;assert.equal(first.total,140)
    assert.equal((await request(publish,a.token,{...batch,offset:140,messages:[{role:'assistant',text:'新增回答'}]})).body.total,141)
    assert.equal((await request(publish,a.token,{...batch,offset:140,messages:[{role:'assistant',text:'新增回答'}]})).body.total,141)
    const catalog=(await request(list,b.token)).body;assert.equal(catalog.sessions.length,2)
    const page=(await request(read+'?key='+encodeURIComponent(first.key),b.token)).body;assert.equal(page.messages.length,100);assert.equal(page.nextOffset,100)
    const rest=(await request(read+'?key='+encodeURIComponent(first.key)+'&offset=100',b.token)).body;assert.equal(rest.messages.length,41);assert.equal(rest.messages.at(-1).text,'新增回答')
    assert.equal((await request(read+'?key=codex%3Afixture',b.token)).body.cwd,undefined)
    assert.equal((await request(list,a.token)).status,401)
    assert.equal((await request(list,b.token,undefined,'https://example.com')).status,403)
    assert.equal((await request(publish,a.token,{sessionId:'bad',messages:[{role:'system',text:'密钥'}]})).status,400)
    assert.equal((await request(publish,a.token,{...batch,offset:1000})).status,409)
    assert.equal((new SharedHistory({directory,native,live:()=>[]})).published[first.key].messages.length,141)
    const sessionFile=path.join(directory,'test-session.json');fs.writeFileSync(sessionFile,JSON.stringify(b))
    const helper=path.join(__dirname,'../electron/miro-agent.ps1')
    const helperResult=JSON.parse((await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',helper,'-Action','history-read','-SessionFile',sessionFile,'-HistoryKey',first.key,'-Offset','100'],{encoding:'utf8',timeout:10000})).stdout)
    assert.equal(helperResult.total,141);assert.equal(helperResult.messages.length,41)
    bridge.disconnect(b.agentId);assert.equal((await request(list,b.token)).status,401)
  }finally{await bridge.stop()}
})
