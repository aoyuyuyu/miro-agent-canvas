const aliases={codebuddy:'workbuddy',workbuddyai:'workbuddy',doubaowork:'doubao','豆包':'doubao','豆包工作':'doubao',codexdesktop:'codex'}
export const providerKey=value=>{const key=String(value||'').trim().toLowerCase().replace(/[ _-]/g,'');return aliases[key]||key}
export function groupAgents(agents) {
  const parents=agents.map((_,i)=>i),providers=new Map(),avatars=new Map(),groups=new Map()
  const root=i=>{while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i]}return i},join=(a,b)=>{parents[root(a)]=root(b)}
  agents.forEach((agent,i)=>{const key=providerKey(agent.software||agent.label||agent.id);if(providers.has(key))join(i,providers.get(key));providers.set(key,i);if(agent.avatar){if(avatars.has(agent.avatar))join(i,avatars.get(agent.avatar));avatars.set(agent.avatar,i)}})
  agents.forEach((agent,i)=>{
    const identity=root(i),key=providerKey(agent.software || agent.label || agent.id)
    const group=groups.get(identity)||{key,members:[],providers:[],avatar:agent.avatar,software:key,label:agent.label}
    group.members.push(agent);group.providers=[...new Set([...group.providers,key])];if(agent.avatar)group.avatar=agent.avatar;groups.set(identity,group)
  })
  return [...groups.values()].map(group=>({...group,connected:group.members.some(m=>m.connected),representative:group.members.find(m=>m.connected&&m.id==='codex')||group.members.find(m=>m.connected)||group.members[0]}))
}
export const sessionMatchesGroup=(session,group)=>!!group&&(group.members.some(m=>m.id===session.agentId)||group.providers.includes(providerKey(session.provider)))
export const nodeSize=node=>({width:Math.max(node.type==='prompt'?320:360,node.width|| (node.type==='prompt'?340:410)),height:Math.max(node.type==='prompt'?200:320,node.height||(node.type==='prompt'?220:430))})
export const overlaps=(a,b,gap=24)=>{const as=nodeSize(a),bs=nodeSize(b);return a.position.x<b.position.x+bs.width+gap && a.position.x+as.width+gap>b.position.x && a.position.y<b.position.y+bs.height+gap && a.position.y+as.height+gap>b.position.y}
export function vacantPosition(node, occupied, gap = 24) {
  if (!occupied.some(other => overlaps(node, other, gap))) return node.position
  const currentSize = nodeSize(node)
  let pos = { ...node.position }

  // 发生碰撞时，按顺序寻找与碰撞节点的吸附点（侧边吸附顶部对齐，或上下碰撞吸附左侧对齐）
  for (let iter = 0; iter < occupied.length * 4 + 4; iter++) {
    const colliders = occupied.filter(other => overlaps({ ...node, position: pos }, other, gap))
    if (!colliders.length) return pos
    
    // 找到距离当前位置最近的碰撞节点
    const other = colliders.reduce((closest, cur) => {
      const curDist = (cur.position.x - pos.x) ** 2 + (cur.position.y - pos.y) ** 2
      const closestDist = (closest.position.x - pos.x) ** 2 + (closest.position.y - pos.y) ** 2
      return curDist < closestDist ? cur : closest
    }, colliders[0])

    const otherSize = nodeSize(other)
    const currentCenterX = pos.x + currentSize.width / 2
    const currentCenterY = pos.y + currentSize.height / 2
    const otherCenterX = other.position.x + otherSize.width / 2
    const otherCenterY = other.position.y + otherSize.height / 2

    const diffX = currentCenterX - otherCenterX
    const diffY = currentCenterY - otherCenterY

    // 优先按距离判断是横向碰撞还是纵向碰撞
    const snapCandidates = []
    if (Math.abs(diffX) / (otherSize.width || 1) >= Math.abs(diffY) / (otherSize.height || 1)) {
      // 侧边吸附：自动顶部对齐 (y = other.position.y)
      if (diffX >= 0) {
        snapCandidates.push({ x: other.position.x + otherSize.width + gap, y: other.position.y })
        snapCandidates.push({ x: other.position.x - currentSize.width - gap, y: other.position.y })
      } else {
        snapCandidates.push({ x: other.position.x - currentSize.width - gap, y: other.position.y })
        snapCandidates.push({ x: other.position.x + otherSize.width + gap, y: other.position.y })
      }
      // 备选上下吸附：左侧对齐
      snapCandidates.push({ x: other.position.x, y: other.position.y + otherSize.height + gap })
      snapCandidates.push({ x: other.position.x, y: other.position.y - currentSize.height - gap })
    } else {
      // 上下碰撞吸附：自动左侧对齐 (x = other.position.x)
      if (diffY >= 0) {
        snapCandidates.push({ x: other.position.x, y: other.position.y + otherSize.height + gap })
        snapCandidates.push({ x: other.position.x, y: other.position.y - currentSize.height - gap })
      } else {
        snapCandidates.push({ x: other.position.x, y: other.position.y - currentSize.height - gap })
        snapCandidates.push({ x: other.position.x, y: other.position.y + otherSize.height + gap })
      }
      // 备选侧边吸附：顶部对齐
      snapCandidates.push({ x: other.position.x + otherSize.width + gap, y: other.position.y })
      snapCandidates.push({ x: other.position.x - currentSize.width - gap, y: other.position.y })
    }

    const available = snapCandidates.find(c => !occupied.some(o => overlaps({ ...node, position: c }, o, gap)))
    if (available) return available

    // 如果首选候选都有交叉，选择重叠最小的一个候选位置继续迭代
    pos = snapCandidates[0]
  }

  // 兜底回退：向右侧吸附并自动顶部对齐
  const maxX = Math.max(...occupied.map(n => n.position.x + nodeSize(n).width))
  return { x: maxX + gap, y: node.position.y }
}
export function settleNodes(nodes, anchorId) {
  const placed = [], ordered = anchorId ? [...nodes.filter(n => n.id === anchorId), ...nodes.filter(n => n.id !== anchorId)] : nodes
  for (const node of ordered) {
    if (anchorId && node.id === anchorId) placed.push(node)
    else placed.push({ ...node, position: vacantPosition(node, placed) })
  }
  const byId = new Map(placed.map(n => [n.id, n]))
  return nodes.map(n => byId.get(n.id))
}
export function visibleAgentMessages(node,states) {
  const original=states[node.agentId]?.messages||[]
  let messages
  if(node.requestIds?.length){const matches=Object.values(states).flatMap(state=>state.messages||[]).filter(m=>node.requestIds.includes(m.messageId));messages=node.requestIds.flatMap(id=>matches.filter(m=>m.messageId===id))}
  else if(node.requestTexts?.length){messages=[];let include=false;for(const message of original.slice(node.messageOffset||0)){if(message.role==='user')include=node.requestTexts.includes(message.text);if(include)messages.push(message)}}
  else messages=original.slice(node.messageOffset||0)
  return [...messages,...(node.messages||[]).filter(m=>!messages.some(original=>original.role===m.role&&original.text===m.text))]
}
