const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto')
const {DesktopAdapter}=require('./adapters/desktopAdapter.cjs')
const {CodexAdapter}=require('./adapters/codexAdapter.cjs')
const {TUI_AGENT_CONFIG,getTuiAgentDetectCommands}=require('./vendor/orca.cjs')
const normalize=p=>({workbuddy:'codebuddy','claude-code':'claude',codexdesktop:'codex'}[String(p).toLowerCase().replace(/[ _-]/g,'')]||String(p).toLowerCase())
function ownedFolderTrustPrompt(lines,workspace){
  const text=lines.join('\n').replace(/\x1b\[[0-9;]*m/g,'')
  return text.includes('Do you trust the files in this folder?')&&text.toLowerCase().includes(path.resolve(workspace).toLowerCase())&&text.includes('❯ 1. Trust folder only ('+path.basename(workspace)+')')
}
class NativeSessions {
  constructor({directory,codex,orca,bridge,history,memory,workspace,mock=false,emit=()=>{}}){
    Object.assign(this,{directory,codex,orca,bridge,history,memory,workspace,mock,emit});this.file=path.join(directory,'native-sessions.json');this.adapters=new Map();this.locks=new Set()
    try{this.sessions=JSON.parse(fs.readFileSync(this.file,'utf8'))}catch{this.sessions={}}
    for(const session of Object.values(this.sessions))if(session.phase==='sending')session.phase='uncertain'
  }
  save(){fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.sessions),'utf8');fs.renameSync(this.file+'.tmp',this.file)}
  async waitHermes(session){
    try{const result=await this.orca.call('terminal.wait',{terminal:session.terminal,for:'tui-idle',timeoutMs:2000},7000);if(result.wait?.satisfied)return;if(result.wait?.blocked)throw Error('Hermes 正在等待原窗口中的确认')}catch(error){if(error.code!=='timeout')throw error}
    // Older local Hermes has no Orca readiness hook; inspect only this newly owned terminal.
    for(let i=0;i<300;i++){const view=await this.orca.call('terminal.read',{terminal:session.terminal,screen:true,limit:40}),lines=view.terminal?.tail||[],text=lines.join('\n');if(text.includes('Hermes Agent v')&&/─ (就绪|Ready)\s/.test(text)&&lines.some(line=>/^\s*❯(?:\s*$|\s+试试[“"].+[”"]\s*$|\s+Try ["“].+["”]\s*$)/.test(line)))return;await new Promise(resolve=>setTimeout(resolve,400))}
    throw Error('Hermes 输入框尚未就绪；本次没有向旧聊天发送')
  }
  canLaunch(provider, agentId){
    if(agentId && this.bridge?.agents?.some(a=>a.id===agentId && this.bridge.online(a))) return true
    const key=normalize(provider);
    if(this.bridge?.agents?.some(a=>normalize(a.software||a.label)===key && this.bridge.online(a))) return true
    if(key==='codex')return this.codex.connected||this.mock||!this.codex.desktop;
    if(!this.orca.connected||!TUI_AGENT_CONFIG[key])return false;
    const paths=(process.env.PATH||'').split(path.delimiter);
    paths.push(path.join(process.env.LOCALAPPDATA||'','hermes/bin'),path.join(process.env.LOCALAPPDATA||'','agy/bin'),path.join(process.env.USERPROFILE||'','.local/bin'),path.join(process.env.APPDATA||'','npm'));
    return getTuiAgentDetectCommands(TUI_AGENT_CONFIG[key]).some(cmd=>paths.some(p=>['','.exe','.cmd','.bat'].some(ext=>fs.existsSync(path.join(p,cmd+ext)))))
  }
  adapter(session){
    if(this.adapters.has(session.id))return this.adapters.get(session.id)
    const emit=event=>{if(event.type==='history')session.messages=event.messages;if(event.type==='status')session.status=event.status;if(event.type==='assistant_message')session.messages.push({role:'assistant',text:event.text});if(event.type==='error')session.error=event.message;this.save();this.emit({type:'native_session',sessionId:session.id})}
    const adapter=this.codex.desktop?new DesktopAdapter({connection:{...this.codex.connection,callerThreadId:this.codex.connection.threadId,threadId:session.nativeId},outgoingPath:path.join(this.directory,session.id.replace(/[^\w-]/g,'_')+'-outgoing.json'),readNative:id=>this.history.codexMessages(id),emit}):new CodexAdapter({emit,getThreadId:()=>session.nativeId,setThreadId:id=>{session.nativeId=id;this.save()},getWorkspace:()=>this.workspace()})
    this.adapters.set(session.id,adapter);return adapter
  }
  async send({conversationId,agentId,provider,text}){
    if(typeof conversationId!=='string'||!conversationId||conversationId.length>180||typeof text!=='string'||!text.trim()||text.length>20000)throw Error('无效的会话消息')
    const id='miro-session:'+conversationId,preset=normalize(provider);if(this.locks.has(id))throw Error('此会话正在发送')
    const known=this.sessions[id];if(known&&known.preset!==preset)throw Error('会话的助手身份不匹配')
    const bridgeAgent = this.bridge?.agents?.find(a => (a.id === agentId || normalize(a.software || a.label) === preset) && !a.revoked && this.bridge.online(a))
    if(!this.mock&&!bridgeAgent&&!this.canLaunch(preset, agentId))throw Error('此助手的新建聊天通道不可用，消息没有发送到旧聊天')
    if(known?.phase==='uncertain')throw Error('上次发送结果尚未确认，请核对原窗口后重试，避免重复发送')
    const session=known||{id,conversationId,agentId,provider,preset,title:text.slice(0,150),messages:[],createdAt:Date.now(),operationId:Date.now()+'-'+randomUUID().replaceAll('-','')}
    if(!known&&preset==='hermes')session.knownNativeIds=this.history.list(true).sessions.filter(s=>s.provider==='hermes').map(s=>s.id)
    this.sessions[id]=session;this.locks.add(id);session.phase='sending';session.status='working';session.error=null;session.messages.push({role:'user',text});this.save()
    let receipt
    try{
      if(bridgeAgent){
        receipt=this.bridge.send(bridgeAgent.id,text,{conversationId,createNewChat:!known,nativeSessionId:session.nativeId||null});
        session.nativeId ||= bridgeAgent.id;
        session.engine = this.mock ? 'bridge-mock' : 'bridge'
      }else if(this.mock&&agentId!=='codex'){
        receipt=this.bridge.send(agentId,text,{conversationId,createNewChat:!known,nativeSessionId:session.nativeId||null});session.nativeId ||= 'mock-'+randomUUID();session.engine='bridge-mock'
      }else if(preset==='codex'){
        if(this.codex.desktop&&!session.nativeId){
          const result=await this.codex.call('create_thread',{title:session.title,prompt:text,target:{type:'projectless',directoryName:'miro-'+randomUUID().slice(0,12)}})
          if(!result.threadId)throw Error('新聊天尚未返回原生编号；本次不向旧聊天发送')
          session.nativeId=result.threadId;session.engine='codex-desktop';this.save();await this.adapter(session).refresh()
        }else{const adapter=this.adapter(session);if(adapter.desktop)await adapter.refresh();receipt=await adapter.send({text});session.engine=this.mock?'codex-mock':adapter.desktop?'codex-desktop':'codex-cli'}
      }else{
        if(!session.terminal){
          fs.mkdirSync(this.workspace(),{recursive:true})
          await this.orca.call('repo.add',{path:this.workspace(),kind:'folder',displayName:'Miro'})
          const worktrees=await this.orca.call('worktree.list',{}),worktree=worktrees.worktrees?.find(w=>path.resolve(w.path).toLowerCase()===path.resolve(this.workspace()).toLowerCase())
          if(!worktree)throw Error('Orca 尚未返回 Miro 工作区')
          const result=await this.orca.call('terminal.createAgentSession',{clientOperationId:session.operationId,worktree:'id:'+worktree.id,agent:preset,...(preset==='hermes'?{}:{prompt:text,promptDelivery:'auto-submit'}),startupCwd:this.workspace(),presentation:'background',viewMode:'terminal'},60000)
          if(!result.terminal?.handle)throw Error('Orca 没有返回新聊天窗口')
          session.terminal=result.terminal.handle;session.worktree=result.terminal.worktreeId;session.tabId=result.terminal.tabId;session.engine='orca';this.save()
          if(preset==='hermes'){await this.waitHermes(session);const delivered=await this.orca.call('terminal.send',{terminal:session.terminal,text,enter:true,agentPrompt:true,waitSubmitMs:15000,client:{id:'miro',type:'desktop'}},25000,{orchestrationRequestId:randomUUID()});if(!delivered.send?.accepted||!delivered.send?.prompt)throw Error('Hermes 尚未确认首条消息已接收')}
        }else{
          if(preset==='hermes')await this.waitHermes(session)
          const result=await this.orca.call('terminal.send',{terminal:session.terminal,text,enter:true,agentPrompt:true,waitSubmitMs:15000,client:{id:'miro',type:'desktop'}},25000,{orchestrationRequestId:randomUUID()})
          if(!result.send?.accepted||!result.send?.prompt)throw Error('原生会话没有确认接收此消息')
          receipt=result.send
        }
      }
      if(!session.messages.some(m=>m.role==='user'&&m.text===text))session.messages.push({role:'user',text})
      session.updatedAt=new Date().toISOString();session.phase='sent';this.save();this.emit({type:'native_session',sessionId:id})
      return {ok:true,sessionKey:id,nativeId:session.nativeId,engine:session.engine,messageId:receipt?.messageId}
    }catch(error){session.phase=(session.nativeId||session.terminal)?'sent':'uncertain';session.status='error';session.error=error.message;this.save();throw error}
    finally{this.locks.delete(id)}
  }
  states(){return Object.fromEntries(Object.values(this.sessions).map(s=>[s.id,{messages:s.messages,status:s.status,error:s.error,title:s.title,nativeId:s.nativeId,agentId:s.agentId,provider:s.preset}]))}
  records(){return Object.values(this.sessions).map(s=>({key:s.nativeId?s.preset+':'+s.nativeId:s.id,id:s.nativeId||s.conversationId,agentId:s.agentId,provider:s.preset,label:s.provider,title:s.title,updatedAt:s.updatedAt||new Date(s.createdAt).toISOString(),messages:s.messages,origin:s.engine||'miro',readable:true}))}
  async refresh(){
    if(this.refreshing)return this.refreshing
    this.refreshing=Promise.all(Object.values(this.sessions).filter(s=>s.engine!=='bridge-mock').map(async session=>{
      try{
        if(session.preset==='codex'&&session.nativeId){const adapter=this.adapter(session);if(adapter.desktop){await adapter.refresh();session.title=adapter.title||session.title}}
        else if(session.engine==='bridge'){
          const bridgeAgent=this.bridge?.agents?.find(a=>a.id===session.nativeId||a.id===session.agentId);
          if(bridgeAgent){
            if(Array.isArray(bridgeAgent.messages)&&bridgeAgent.messages.length){
              session.messages=bridgeAgent.messages
            }
            session.status=this.bridge.status(bridgeAgent)==='working'?'working':'done'
          }
        }
        else if(session.terminal){
          const inventory=await this.orca.call('session.tabs.list',{worktree:'id:'+session.worktree}),tab=inventory.tabs?.find(t=>t.terminal===session.terminal||(session.tabId&&t.parentTabId===session.tabId));let native=tab?.agentStatus?.providerSession
          if(session.preset==='codebuddy'&&!native&&!session.folderTrustConfirmed&&Date.now()-session.createdAt<60000){
            const view=await this.orca.call('terminal.read',{terminal:session.terminal,screen:true,limit:40})
            if(ownedFolderTrustPrompt(view.terminal?.tail||[],this.workspace())){await this.orca.call('terminal.send',{terminal:session.terminal,enter:true,client:{id:'miro',type:'desktop'}});session.folderTrustConfirmed=true}
          }
          if(session.preset==='hermes'&&!native){
            if(session.nativeId)native={id:session.nativeId}
            else{const candidates=this.history.list(true).sessions.filter(s=>s.provider==='hermes'&&!(session.knownNativeIds||[]).includes(s.id)&&s.cwd&&path.resolve(s.cwd).toLowerCase()===path.resolve(this.workspace()).toLowerCase()&&Date.parse(s.createdAt||s.updatedAt)>=session.createdAt-10000),exact=[]
              for(const candidate of candidates){const record=await this.history.read(candidate.key);if(record.messages.find(m=>m.role==='user')?.text===session.messages.find(m=>m.role==='user')?.text)exact.push(candidate)}
              if(exact.length===1)native={id:exact[0].id}
            }
          }
          if(native){session.nativeId=native.id;let record
            try{record=await this.history.read(session.preset+':'+native.id)}catch{}
            if(!record&&this.memory){try{record=await this.memory.read(session.preset+':'+native.id)}catch{}
              const completed=tab?.agentStatus?.lastCompletedAssistantMessage||tab?.agentStatus?.lastAssistantMessage
              if((!record||completed!==session.capturedReply)&&completed){try{record=await this.memory.syncSession(session.preset,native.id);session.capturedReply=completed}catch{}}
            }
            if(!record){const result=await this.orca.call('nativeChat.readSession',{agent:session.preset,sessionId:native.id,...(native.transcriptPath?{transcriptPath:native.transcriptPath}:{}),limit:2000});if(Array.isArray(result.messages))record={messages:result.messages.filter(m=>['user','assistant'].includes(m.role)).map(m=>({role:m.role,text:(m.blocks||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n')})).filter(m=>m.text)}}
            if(record?.messages?.length)session.messages=record.messages
            const title=this.orca.sessions.find(s=>s.sessionId===native.id&&s.agent===session.preset)?.title||record?.title;if(title&&!/^(未命名会话|会话 · )/.test(title))session.title=title
          }
          session.status=tab?.agentStatus?.state==='working'?'working':tab?.agentStatus?.state==='done'?'done':tab?'idle':'error'
          if(session.preset==='hermes')session.status=session.messages.at(-1)?.role==='assistant'?'done':'working'
        }
      }catch(error){session.error=error.message;session.status='error'}
    })).finally(()=>{this.refreshing=null;this.save()});return this.refreshing
  }
}
module.exports={NativeSessions,normalize,ownedFolderTrustPrompt}
