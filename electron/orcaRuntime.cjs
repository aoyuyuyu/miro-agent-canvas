const upstream = require('./vendor/orca.cjs')
class OrcaRuntime {
  constructor(){ this.sessions=[];this.connected=false }
  async call(method,params={},timeout=30000,envelope){
    const answer=await upstream.sendRequest(upstream.readMetadata(upstream.getDefaultUserDataPath()),method,params,timeout,envelope)
    if(!answer.ok)throw Object.assign(new Error(answer.error.message),{code:answer.error.code})
    this.connected=true
    return answer.result
  }
  async refresh(){
    try{const result=await this.call('aiVault.listSessions',{limit:2000,includeAntigravityIdeSessions:true});this.sessions=result.sessions||[];this.error=null}
    catch(error){this.connected=false;this.error=error.message}
    return this.sessions
  }
  catalog(){return this.sessions.map(s=>({key:s.agent+':'+s.sessionId,id:s.sessionId,provider:s.agent,label:s.agent,title:s.title,updatedAt:s.updatedAt||s.modifiedAt,readable:!!s.messageCount,origin:'orca',total:s.messageCount}))}
  async read(key){
    const session=this.sessions.find(s=>s.agent+':'+s.sessionId===key);if(!session)throw Error('找不到原生会话')
    let beforeOffset,rows=[],seen=new Set()
    for(let page=0;page<100;page++){
      const result=await this.call('nativeChat.readSession',{agent:session.agent,sessionId:session.sessionId,transcriptPath:session.filePath,limit:2000,...(beforeOffset===undefined?{}:{beforeOffset})})
      if(!Array.isArray(result.messages))throw Error('原生正文暂时未就绪')
      const visible=result.messages.filter(m=>['user','assistant'].includes(m.role)).flatMap(m=>{const text=(m.blocks||[]).filter(b=>b.type==='text').map(b=>b.text||'').join('\n');return text?[{role:m.role,text,timestamp:m.timestamp,id:m.id}]:[]})
      rows=[...visible.filter(m=>!seen.has(m.id)),...rows];visible.forEach(m=>seen.add(m.id))
      if(!result.hasMore)break
      if(result.beforeOffset===beforeOffset || !Number.isSafeInteger(result.beforeOffset))throw Error('原生历史分页停止，正文尚未读全')
      beforeOffset=result.beforeOffset
      if(page===99)throw Error('原生会话超过读取上限')
    }
    return {...this.catalog().find(s=>s.key===key),messages:rows.map(({id,...m})=>m),total:rows.length}
  }
}
module.exports={OrcaRuntime,upstream}
