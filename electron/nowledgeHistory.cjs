const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto')
const {runProcess}=require('./vendor/orca.cjs')
const aliases={'claude-code':'claude',codebuddy:'codebuddy',workbuddy:'workbuddy',codex:'codex',hermes:'hermes',antigravity:'antigravity','google-antigravity':'antigravity',opencode:'opencode',pi:'pi','gemini-cli':'gemini'}
class NowledgeHistory {
  constructor({directory,url='http://127.0.0.1:14242',request=fetch,runner=runProcess,cli=path.join(process.env.USERPROFILE||'','.local/bin/nmem.exe')}){
    if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(url))throw Error('记忆服务必须在本机')
    fs.mkdirSync(directory,{recursive:true});Object.assign(this,{url,request,runner,cli});this.file=path.join(directory,'nowledge-index.json');this.bodyDirectory=path.join(directory,'nowledge-bodies');this.sessions=[];this.connected=false;this.bodies=new Map()
    try{this.sessions=JSON.parse(fs.readFileSync(this.file,'utf8'))}catch{}
  }
  async get(route,timeoutMs=15000){try{const response=await this.request(this.url+route,{signal:AbortSignal.timeout(timeoutMs)});if(!response.ok)throw Error('本机记忆服务暂时不可用');return await response.json()}catch{throw Error('本机记忆服务正在整理历史或暂时离线，请稍后再试')}}
  catalog(){return this.sessions.map(({threadId,...s})=>({...s,origin:'nowledge',readable:true}))}
  async refresh(){
    if(this.refreshing)return this.refreshing
    this.refreshing=(async()=>{try{
      let rows=[]
      for(let offset=0;offset<20000;offset+=1000){const data=await this.get('/threads?limit=1000&offset='+offset+'&space_id=default',120000);rows.push(...(data.threads||[]));if(!data.pagination?.has_more)break;if(offset===19000)throw Error('共享历史目录超过读取上限')}
      this.sessions=rows.flatMap(t=>{const provider=aliases[t.source_app||t.metadata?.source_app||String(t.source||'').toLowerCase()];if(!provider)return [];const id=t.metadata?.session_id||t.id;return [{key:provider+':'+id,id,threadId:t.id,provider,label:provider,title:t.title,updatedAt:t.last_activity||t.date,total:t.messages||0}]})
      this.connected=true;this.error=null;fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.sessions),'utf8');fs.renameSync(this.file+'.tmp',this.file)
    }catch(error){this.connected=false;this.error=error.message}})().finally(()=>{this.refreshing=null})
    return this.refreshing
  }
  async read(key){
    const session=this.sessions.find(s=>s.key===key);if(!session)throw Error('找不到共享历史')
    const bodyFile=path.join(this.bodyDirectory,createHash('sha256').update(key).digest('hex')+'.json')
    try{let messages=[],offset=0
      for(let page=0;page<100;page++){
        const data=await this.get('/threads/'+encodeURIComponent(session.threadId)+'?space_id=default&limit=1000&offset='+offset),batch=data.messages||[]
        messages.push(...batch.filter(m=>['user','assistant'].includes(m.role)).map(m=>({role:m.role,text:m.content,timestamp:m.timestamp})).filter(m=>typeof m.text==='string'&&m.text.trim()))
        offset+=batch.length;if(offset>=data.total_messages || batch.length===0)break;if(page===99)throw Error('共享历史超过读取上限')
      }
      const record={...this.catalog().find(s=>s.key===key),messages,total:messages.length};this.bodies.set(key,record);fs.mkdirSync(this.bodyDirectory,{recursive:true});fs.writeFileSync(bodyFile+'.tmp',JSON.stringify(record),'utf8');fs.renameSync(bodyFile+'.tmp',bodyFile);return record
    }catch(error){if(this.bodies.has(key))return {...this.bodies.get(key),stale:true};try{return {...JSON.parse(fs.readFileSync(bodyFile,'utf8')),stale:true}}catch{}throw error}
  }
  async sync(){
    if(this.syncing)return this.syncing
    const cli=this.cli
    if(!fs.existsSync(cli))return
    this.syncAbort=new AbortController();this.syncing=(async()=>{this.syncResults=[]
      for(const provider of ['codex','workbuddy','codebuddy','hermes','antigravity','opencode']){
        if(this.syncAbort.signal.aborted)break
        try{const result=await this.runner({program:cli,args:['t','sync','--from',provider,'--all-projects','--space-id','default','--limit','1000','--apply','--checkpointed','--json'],signal:this.syncAbort.signal,timeoutMs:120000,maxOutputBytes:8*1024*1024});const data=JSON.parse(result.stdout.replace(/^\uFEFF/,''));this.syncResults.push({provider,count:data.count,created:data.created,appended:data.appended,failed:data.failed,unchanged:data.unchanged,timedOut:result.timedOut})}catch{this.syncResults.push({provider,error:'本机历史同步失败'})}
      }
      await this.refresh()
    })().finally(()=>{this.syncing=null});return this.syncing
  }
  async workingMemory(){return this.get('/agent/working-memory?space_id=default')}
  async syncSession(provider,id){
    if(!/^[\w-]+$/.test(id))throw Error('无效原生会话编号')
    const cli=path.join(process.env.USERPROFILE||'','.local/bin/nmem.exe')
    const result=await this.runner({program:cli,args:['t','sync','--from',provider,'--all-projects','--space-id','default','--session-id',id,'--apply','--checkpointed','--json'],timeoutMs:60000,maxOutputBytes:1024*1024})
    if(result.code!==0)throw Error('这份原生历史暂未导入共同记忆')
    await this.refresh()
    return this.read(provider+':'+id)
  }
  start(){this.sync();this.timer=setInterval(()=>this.sync(),60000);this.timer.unref()}
  stop(){clearInterval(this.timer);this.syncAbort?.abort()}
}
module.exports={NowledgeHistory}
