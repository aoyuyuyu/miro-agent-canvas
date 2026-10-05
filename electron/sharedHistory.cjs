const fs = require('node:fs')
const path = require('node:path')
class SharedHistory {
  constructor({directory, native, live, external=[]}) {
    Object.assign(this, {directory, native, live, external})
    fs.mkdirSync(directory, {recursive:true})
    this.file = path.join(directory, 'published.json')
    try { this.published = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { this.published = {} }
  }
  list(force) {
    const original = this.native.list(force)
    const live = this.live().filter(item=>item.messages.length).map(({messages, ...item}) => ({...item, readable:true, origin:'miro', total:messages.length}))
    const published = Object.values(this.published).map(({messages,...item}) => ({...item, readable:true, total:messages.length}))
    const native = original.sessions.map(item => {
      const exportItem=published.find(p=>p.provider===item.provider && p.id===item.id)
      return exportItem && !item.readable ? {...item,readable:true,origin:'published',agentId:exportItem.agentId,total:exportItem.total} : item
    })
    const merged=new Map()
    for(const item of [...this.external.flatMap(source=>source.catalog()),...native,...live,...published]){
      const identity=item.provider+':'+item.id,old=merged.get(identity)
      merged.set(identity,old?{...old,...item,readable:old.readable||item.readable,title:item.origin==='miro'&&old.origin!=='miro'?old.title:(!item.title||/^(会话 · |未命名会话)/.test(item.title))?old.title:item.title}:item)
    }
    const sessions=[...merged.values()].sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''))
    const providers=[...new Set(sessions.map(s=>s.provider))].map(id=>({...(original.providers.find(p=>p.id===id)||{}),id,count:sessions.filter(s=>s.provider===id).length,status:sessions.some(s=>s.provider===id&&s.readable)?'ready':'index-only'}))
    return {...original,sessions,providers,sync:this.external.map(s=>({source:s.constructor.name,connected:s.connected,error:s.error||null}))}
  }
  async read(key) {
    const original=this.native.list().sessions.find(item=>item.key===key)
    if(!original?.readable){
      for(const source of [...this.external].reverse())if(source.catalog().some(s=>s.key===key)){try{return await source.read(key)}catch{}}
    }
    const unreadable=this.native.list().sessions.find(item=>item.key===key && !item.readable)
    const local = this.published[key] || this.live().find(item => item.key === key || (key==='miro:codex'&&item.agentId==='codex')) || (unreadable && Object.values(this.published).find(item=>key===item.provider+':'+item.id))
    if(original?.readable&&local&&local.origin!=='published'&&local.origin!=='miro'){try{const item=await this.native.read(key);const {cwd,file,...publicItem}=item;return publicItem}catch{}}
    if (local) return {...local, messages:local.messages.map(m=>({...m})), total:local.messages.length}
    let item
    try{item=await this.native.read(key)}catch(error){for(const source of [...this.external].reverse())if(source.catalog().some(s=>s.key===key)){try{return await source.read(key)}catch{}}throw error}
    const {cwd, file, ...publicItem} = item
    return publicItem
  }
  publish(agent, data) {
    if (typeof data.sessionId !== 'string' || !data.sessionId.trim() || data.sessionId.length > 160 || !Array.isArray(data.messages) || data.messages.length > 200) throw Object.assign(new Error('历史批次格式无效'), {status:400})
    const messages = data.messages.map(m => {
      if (!['user','assistant'].includes(m.role) || typeof m.text !== 'string' || !m.text.trim() || m.text.length > 20000) throw Object.assign(new Error('只能发布用户和助手的可见正文'), {status:400})
      return {role:m.role, text:m.text, ...(typeof m.timestamp === 'string' ? {timestamp:m.timestamp.slice(0,40)} : {})}
    })
    const key = 'published:' + agent.id + ':' + data.sessionId
    const previous = this.published[key]
    const offset = data.offset === undefined ? 0 : data.offset
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > (previous?.messages.length || 0)) throw Object.assign(new Error('历史位置无效'), {status:409})
    // An offset makes retries idempotent. Offset zero starts a fresh snapshot.
    const all = [...(previous?.messages.slice(0,offset) || []), ...messages]
    if (all.length > 50000 || Buffer.byteLength(JSON.stringify(all)) > 20*1024*1024) throw Object.assign(new Error('单个会话历史过大'), {status:413})
    if (!previous && Object.keys(this.published).length >= 10000) throw Object.assign(new Error('历史数量已满'), {status:413})
    this.published[key] = {key, id:data.sessionId, agentId:agent.id, avatar:agent.avatar, provider:agent.software || agent.label.toLowerCase(), label:agent.label, title:typeof data.title === 'string' ? data.title.slice(0,300) : '', updatedAt:new Date().toISOString(), origin:'published', readable:true, messages:all}
    fs.writeFileSync(this.file+'.tmp', JSON.stringify(this.published), 'utf8'); fs.renameSync(this.file+'.tmp',this.file)
    return {ok:true, key, total:all.length}
  }
  archive(agentId, data, sourceAgent) {
    if(!Array.isArray(data.messages) || data.messages.length>50000)throw new Error('会话过大')
    const agent={label:data.provider || 'Miro',software:data.provider || 'miro',...sourceAgent,id:agentId}
    let result
    for(let offset=0;offset<Math.max(1,data.messages.length);offset+=200)result=this.publish(agent,{...data,offset,messages:data.messages.slice(offset,offset+200)})
    this.published[result.key].origin='miro'
    fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.published),'utf8');fs.renameSync(this.file+'.tmp',this.file)
    return result
  }
}
module.exports = {SharedHistory}
