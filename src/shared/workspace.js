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

// 需求9：按两个节点中心的相对方位，选择各自最近的连接点作为连线端点。
// 上下位置用上下圆点，左右位置用左右圆点；距离相同则按水平优先。
export function pickPortSides({ source, target }, nodes) {
  const a = nodes.find(n => n.id === source)
  const b = nodes.find(n => n.id === target)
  if (!a || !b) return { sourceHandle: 'out-top', targetHandle: 'in-top' }
  const ca = { x: a.position.x + nodeSize(a).width / 2, y: a.position.y + nodeSize(a).height / 2 }
  const cb = { x: b.position.x + nodeSize(b).width / 2, y: b.position.y + nodeSize(b).height / 2 }
  const dx = cb.x - ca.x
  const dy = cb.y - ca.y
  const horizontal = Math.abs(dx) >= Math.abs(dy)
  const sourceSide = horizontal ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top')
  const targetSide = horizontal ? (dx >= 0 ? 'left' : 'right') : (dy >= 0 ? 'top' : 'bottom')
  return { sourceHandle: `out-${sourceSide}`, targetHandle: `in-${targetSide}` }
}

// 需求6：自动排版。按软件分组，同组相邻排成网格，整体紧凑排列。
export function autoLayout(nodes, gap = 48) {
  const byGroup = new Map()
  for (const node of nodes) {
    const key = node.type === 'agent' ? (node.software || 'agent') : (node.agentId || node.type || 'misc')
    if (!byGroup.has(key)) byGroup.set(key, [])
    byGroup.get(key).push(node)
  }
  const columns = Math.max(1, Math.ceil(Math.sqrt(byGroup.size)))
  const groups = [...byGroup.values()]
  let cursorX = 0
  let cursorY = 0
  let rowHeight = 0
  const placed = new Map()
  groups.forEach((group, gi) => {
    if (gi > 0 && gi % columns === 0) {
      cursorX = 0
      cursorY += rowHeight + gap * 2
      rowHeight = 0
    }
    let maxWidth = 0
    group.forEach(node => {
      const size = nodeSize(node)
      placed.set(node.id, { x: cursorX, y: cursorY })
      maxWidth = Math.max(maxWidth, size.width)
      cursorX += size.width + gap
    })
    rowHeight = Math.max(rowHeight, ...group.map(n => nodeSize(n).height))
    cursorX += gap
    void columns
  })
  return nodes.map(node => ({ ...node, position: placed.get(node.id) || node.position }))
}

// 需求5：判断一组节点当前是否处于重叠态（任意两框相交）。
export function isOverlapping(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j]
      const sa = nodeSize(a), sb = nodeSize(b)
      if (
        Math.abs(a.position.x - b.position.x) < Math.min(sa.width, sb.width) &&
        Math.abs(a.position.y - b.position.y) < Math.min(sa.height, sb.height)
      ) return true
    }
  }
  return false
}

// 需求5：重叠 <-> 展开切换。
// 已在重叠态则横向铺开（间距 48）；否则全部叠到第一个节点的位置。
export function toggleOverlap(nodes, ids, gap = 48) {
  const set = new Set(ids)
  const targets = nodes.filter(n => set.has(n.id))
  if (!targets.length) return nodes
  const rest = nodes.filter(n => !set.has(n.id))
  if (isOverlapping(targets)) {
    let x = 0
    const y = targets[0].position.y
    const moved = targets.map(n => {
      const out = { ...n, position: { x, y } }
      x += nodeSize(n).width + gap
      return out
    })
    return [...moved, ...rest].sort(byId)
  }
  const anchor = targets[0].position
  const moved = targets.map(n => ({ ...n, position: { ...anchor } }))
  return [...moved, ...rest].sort(byId)
}

const byId = (a, b) => String(a.id).localeCompare(String(b.id))
