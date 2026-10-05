import React, { useEffect, useRef, useState } from 'react'
import { ReactFlow, ReactFlowProvider, Background, MiniMap, Controls, ControlButton, Handle, Position, Panel, NodeResizer, addEdge, applyNodeChanges, applyEdgeChanges, useReactFlow, useUpdateNodeInternals } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { relayPayload } from '../shared/relay.js'

const statusText = { idle: '待命', working: '工作中', done: '已完成', offline: '离线', error: '连接异常' }
function MessageList({ messages, onOpen }) {
  const visible = messages.slice(-3)
  return <div className="node-messages nodrag nowheel">{visible.length ? visible.map((message, index) => <div key={index} className={`node-message ${message.role}`}><small>{message.role === 'user' ? '你' : '助手'}</small><p>{message.text}</p></div>) : <p className="node-empty">等待对话</p>}{messages.length > 3 && <button className="node-link" onClick={onOpen}>查看全部 {messages.length} 条</button>}</div>
}
function AgentNode({ id, data, selected }) {
  return <section className={`canvas-node agent-node ${selected ? 'node-selected' : ''}`} data-agent-node={data.agent.id}>
    <NodeResizer minWidth={290} minHeight={210} isVisible={selected} />
    <Handle type="target" position={Position.Left} id="in" aria-label={`向${data.agent.label}发送`} />
    <div className="node-heading"><div className={`node-avatar ${data.status === 'working' ? 'working' : ''}`}>{data.agent.label.slice(0, 1)}</div><div><strong>{data.agent.label}</strong><small>{data.source?.origin === 'native' ? '原生记录' : data.agent.desktop ? data.nativeDesktop ? '原生 · 本聊天' : '桌面预览 · 本聊天' : 'Miro 收发记录'}</small></div><span className={`node-status ${data.status}`}>{statusText[data.status] || '待命'}</span></div>
    <div className="node-tools nodrag"><button onClick={data.onOpen}>打开对话</button>{data.agent.external && <button onClick={data.onRename}>改名</button>}{data.source && <button onClick={data.onUnbind}>解除显示绑定</button>}</div>
    {data.source && <div className="native-title nodrag">{data.source.title || data.source.error}</div>}
    {data.source?.warning && <p className="node-warning">{data.source.warning}</p>}
    <MessageList messages={data.messages} onOpen={data.onOpen} />
    <div className="node-output">最近回复 <Handle type="source" position={Position.Right} id="reply" style={{ top: '50%', bottom: 'auto' }} aria-label="转交最近回复" /></div>
    <div className="node-output">整段对话 <Handle type="source" position={Position.Right} id="session" style={{ top: '50%', bottom: 'auto' }} aria-label="接力整段对话" /></div>
  </section>
}
function DraftNode({ data }) {
  return <section className="canvas-node draft-node"><div className="node-heading"><strong>写给 Agent</strong><span className="node-tag">输入</span></div><div className="nodrag"><textarea className="nodrag nowheel" aria-label="画布消息" placeholder="写消息，将右侧圆点连到目标节点…" maxLength={20000} value={data.text} onChange={e => data.onText(e.target.value)} />
    <p className="draft-targets">{data.targets.length ? data.targets.map(a => a.label).join('、') : '先连线选择接收对象'}</p>
    <button className="canvas-send" disabled={data.busy || !data.text.trim() || !data.targets.length} onClick={data.onSend}>{data.busy ? '发送中…' : `${data.retry ? '重试' : '发送'}给 ${data.targets.length} 位`}</button></div><Handle type="source" position={Position.Right} id="text" aria-label="输入消息连线" /></section>
}
function HistoryNode({ data, selected }) {
  return <section className={`canvas-node history-node ${selected ? 'node-selected' : ''}`} data-history-node={data.session.key}><NodeResizer minWidth={290} minHeight={200} isVisible={selected} />
    <div className="node-heading"><strong>{data.session.label} 历史</strong><span className="node-tag">原生记录</span></div><h3 className="native-title">{data.session.title}</h3><small className="history-time">{data.session.updatedAt?.slice(0, 16).replace('T', ' ')}</small>
    {data.error ? <p className="node-warning">{data.error}</p> : data.record ? <MessageList messages={data.record.messages} onOpen={data.onOpen} /> : <p className="node-empty">读取原生记录中…</p>}
    <div className="node-tools nodrag"><button onClick={data.onOpen} disabled={!data.record}>打开完整对话</button><button onClick={data.onBind} disabled={!data.record}>绑定到 Agent 显示</button></div>
    <div className="node-output">上下文接力 <Handle type="source" position={Position.Right} id="session" aria-label="历史会话接力" style={{ top: '50%', bottom: 'auto' }} /></div>
  </section>
}
const nodeTypes = { agent: AgentNode, draft: DraftNode, history: HistoryNode }
const cleanNode = n => ({ id: n.id, type: n.type, position: n.position, historyKey: n.historyKey, width: n.width, height: n.height })
const cleanEdge = e => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle })

function Canvas({ agents, states, sources, nativeDesktop, draft, onDraft, busy, dispatch, onRelay, onRename, onBindingsChanged, onNotice }) {
  const [catalog, setCatalog] = useState({ sessions: [], providers: [] })
  const [query, setQuery] = useState(''), [provider, setProvider] = useState('all'), [listLimit, setListLimit] = useState(250)
  const [nodes, setNodes] = useState([]), [edges, setEdges] = useState([]), [ready, setReady] = useState(false)
  const [records, setRecords] = useState({}), [errors, setErrors] = useState({}), [retry, setRetry] = useState(null)
  const [detail, setDetail] = useState(null), [visible, setVisible] = useState(80), [binding, setBinding] = useState(null)
  const flow = useReactFlow(), nodesRef = useRef(nodes), readyRef = useRef(false), labels = useRef(new Map())
  agents.forEach(a => labels.current.set(a.id,a.label))
  const updateInternals = useUpdateNodeInternals()
  useEffect(() => {
    if (!ready || !agents.length) return
    const timer = setTimeout(() => updateInternals(nodesRef.current.map(n => n.id)), 100)
    return () => clearTimeout(timer)
  }, [ready, agents.map(a => a.id).join('|'), nodes.map(n => n.id).join('|')])
  nodesRef.current = nodes
  const refresh = async force => { try { setCatalog(await window.miro.listHistory(force)) } catch { onNotice('历史目录读取失败，请重试') } }
  useEffect(() => {
    const escape = event => { if (event.key === 'Escape') { setDetail(null); setBinding(null) } }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [])
  useEffect(() => {
    if (!detail && !binding) return
    const dialog = document.querySelector('[role="dialog"]'), previous = document.activeElement
    const controls = () => [...dialog.querySelectorAll('button:not(:disabled)')]
    controls()[0]?.focus()
    const trap = event => { if (event.key !== 'Tab') return; const items = controls(), index = items.indexOf(document.activeElement); if (index < 0 || (!event.shiftKey && index === items.length - 1) || (event.shiftKey && index === 0)) { event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0]?.focus() } }
    document.addEventListener('keydown', trap)
    return () => { document.removeEventListener('keydown', trap); if (previous?.isConnected) previous.focus() }
  }, [!!detail, !!binding])
  useEffect(() => {
    let active = true
    Promise.all([window.miro.loadCanvas(), window.miro.listHistory()]).then(([saved, list]) => {
      if (!active) return
      setCatalog(list); setNodes(saved?.nodes || []); setEdges((saved?.edges || []).map(e => ({ ...e, type: 'default' })))
      if (saved?.viewport) flow.setViewport(saved.viewport)
      setReady(true); readyRef.current = true
    }).catch(() => { if (active) { setReady(true); readyRef.current = true; onNotice('画布加载失败，已打开空白画布') } })
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (!ready || !agents.length) return
    const alive = new Set(['draft', ...agents.map(a => 'agent:' + a.id)])
    setNodes(prev => {
      const next = prev.filter(n => n.type === 'history' || alive.has(n.id))
      if (!next.some(n => n.id === 'draft')) next.unshift({ id: 'draft', type: 'draft', position: { x: 60, y: 140 }, deletable: false })
      agents.forEach((a, i) => { if (!next.some(n => n.id === 'agent:' + a.id)) next.push({ id: 'agent:' + a.id, type: 'agent', position: { x: 470 + Math.floor(i / 3) * 380, y: 50 + (i % 3) * 400 }, deletable: false }) })
      return next
    })
    setEdges(prev => prev.filter(e => (alive.has(e.source) || e.source.startsWith('history:')) && alive.has(e.target)))
  }, [ready, agents.map(a => a.id).join('|')])
  useEffect(() => {
    if (!ready) return
    const timer = setTimeout(() => window.miro.saveCanvas({ nodes: nodes.map(cleanNode), edges: edges.map(cleanEdge), viewport: flow.getViewport() }).catch(() => onNotice('画布保存失败')), 400)
    return () => clearTimeout(timer)
  }, [ready, nodes, edges])
  useEffect(() => {
    let active = true, running = false
    const load = async () => {
      if (running) return; running = true
      try {
        for (const node of nodesRef.current.filter(n => n.type === 'history')) {
          try { const record = await window.miro.readHistory(node.historyKey); if (active) { setRecords(prev => ({ ...prev, [node.historyKey]: record })); setErrors(prev => ({ ...prev, [node.historyKey]: null })) } }
          catch (e) { if (active) setErrors(prev => ({ ...prev, [node.historyKey]: e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') })) }
        }
      } finally { running = false }
    }
    load(); const timer = setInterval(load, 4000)
    return () => { active = false; clearInterval(timer) }
  }, [nodes.filter(n => n.type === 'history').map(n => n.historyKey).join('|')])
  const draftTargets = [...new Set(edges.filter(e => e.source === 'draft').map(e => e.target.slice(6)))].map(id => agents.find(a => a.id === id)).filter(Boolean)
  const targets = retry ? retry.map(id => agents.find(a => a.id === id) || { id, label: labels.current.get(id) || '已断开的 Agent' }) : draftTargets
  const send = async () => {
    const text = draft, result = await dispatch(text, targets.map(a => a.id))
    if (result?.ok) { onDraft(value => value === text ? '' : value); setRetry(null) }
    else if (result) setRetry(result.results.filter(r => !r.ok).map(r => r.agentId))
  }
  const open = (title, messages, source) => { setVisible(80); setDetail({ title, messages, source }) }
  const unbind = async id => { try { await window.miro.bindHistory(id, null); onBindingsChanged(); onNotice('已解除显示绑定，恢复 Miro 收发记录') } catch (e) { onNotice(e.message) } }
  const enriched = nodes.filter(n => n.type !== 'agent' || agents.some(a => n.id === 'agent:' + a.id)).map(n => {
    if (n.type === 'draft') return { ...n, deletable: false, data: { text: draft, onText: text => { onDraft(text); setRetry(null) }, targets, retry: !!retry, busy, onSend: send } }
    if (n.type === 'agent') {
      const agent = agents.find(a => n.id === 'agent:' + a.id)
      if (!agent) return n
      const source = sources[agent.id], messages = source ? source.messages : states[agent.id]?.messages || []
      return { ...n, deletable: false, data: { agent, messages, source, nativeDesktop, status: states[agent.id]?.status || agent.status || 'idle', onRename: () => onRename(agent), onOpen: () => open(agent.label, messages, source?.origin === 'native' || (agent.desktop && nativeDesktop) ? '原生文字记录' : 'Miro 收发记录'), onUnbind: () => unbind(agent.id) } }
    }
    const session = catalog.sessions.find(s => s.key === n.historyKey) || records[n.historyKey] || { key: n.historyKey, title: '历史会话', label: n.historyKey?.split(':')[0] }
    return { ...n, data: { session, record: records[n.historyKey], error: errors[n.historyKey], onOpen: () => open(session.title, records[n.historyKey]?.messages || [], '原生文字记录'), onBind: () => setBinding(session) } }
  })
  const payloadFor = edge => {
    const node = enriched.find(n => n.id === edge.source)
    if (!node) throw new Error('来源节点不存在')
    if (node.type === 'draft') return { kind: 'draft', text: draft }
    const data = node.data
    const agent = data.agent || { id: data.session.key, label: `${data.session.label} · ${data.session.title}` }
    let messages = data.messages || data.record?.messages || []
    if (edge.sourceHandle === 'reply') messages = messages.filter(m => m.role === 'assistant').slice(-1)
    return { ...relayPayload(edge.sourceHandle === 'reply' ? 'reply' : 'session', agent, messages), native: data.source?.origin === 'native' || node.type === 'history' || (agent.desktop && nativeDesktop) }
  }
  const connect = connection => {
    setEdges(prev => addEdge({ ...connection, type: 'default' }, prev)); setRetry(null)
    if (connection.source !== 'draft') { try { onRelay(payloadFor(connection), [connection.target.slice(6)]) } catch (e) { onNotice(e.message) } }
  }
  const addHistory = session => {
    if (!session.readable) { onNotice(session.reason); return }
    const id = 'history:' + session.key
    if (!nodes.some(n => n.id === id)) { const position = flow.screenToFlowPosition({ x: window.innerWidth * .5, y: window.innerHeight * .4 }); setNodes(prev => [...prev, { id, type: 'history', historyKey: session.key, position }]) }
    else flow.fitView({ nodes: [{ id }], duration: 200 })
  }
  const filtered = catalog.sessions.filter(s => (provider === 'all' || s.provider === provider) && (!query || `${s.title} ${s.cwd || ''} ${s.label} ${s.id}`.toLowerCase().includes(query.toLowerCase())))
  const detailMessages = detail ? detail.messages.slice(-visible) : []
  return <div className="history-workbench">
    <aside className="history-sidebar"><div className="history-heading"><strong>历史对话</strong><button onClick={() => refresh(true)} title="重新读取本机目录">↻ 刷新</button></div><input aria-label="搜索历史" placeholder="搜索标题、目录或编号" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="历史来源" value={provider} onChange={e => setProvider(e.target.value)}><option value="all">所有软件 · {catalog.sessions.length}</option>{catalog.providers.map(p => <option key={p.id} value={p.id}>{p.label} · {p.count}</option>)}</select><p className="history-help">点击会话加入画布。读取原生记录，无需先从 Miro 发过消息。</p>
      <div className="history-entries">{filtered.slice(0, listLimit).map(s => <button key={s.key} className={`history-entry ${!s.readable ? 'catalog-only' : ''}`} onClick={() => addHistory(s)} data-history-key={s.key}><strong>{s.title}</strong><span>{s.label} · {s.readable ? '原生正文' : '仅目录'}{s.archived && ' · 已归档'}</span><small>{s.updatedAt?.slice(0, 10)} {s.cwd || ''}</small></button>)}{!filtered.length && <p className="history-help">没有匹配的本机会话</p>}{filtered.length > listLimit && <button className="load-older" onClick={() => setListLimit(v => v + 250)}>显示更多历史（剩余 {filtered.length - listLimit} 条）</button>}</div>
      <div className="provider-status">{catalog.providers.filter(p => p.status === 'unavailable').map(p => <p key={p.id}>{p.label}：{p.reason}</p>)}{catalog.providers.find(p => p.id === 'antigravity' && p.count > 0) && <p>Antigravity：目录可读，正文接口待接入。</p>}</div>
    </aside>
    <section className="flow-stage" aria-label="对话节点画布"><ReactFlow nodes={enriched.map(n => ({ ...n, ariaRoleDescription: '对话节点', ariaLabel: n.type === 'draft' ? '消息输入节点' : n.data?.agent?.label || n.data?.session?.title || '历史对话节点' }))} edges={edges.map(e => ({ ...e, ariaRoleDescription: '连线', ariaLabel: '消息发送连线，双击预览接力' }))} nodeTypes={nodeTypes} onNodesChange={changes => setNodes(prev => applyNodeChanges(changes, prev))} onEdgesChange={changes => { setEdges(prev => applyEdgeChanges(changes, prev)); if (changes.some(c => c.type !== 'select')) setRetry(null) }} onConnect={connect}
      isValidConnection={c => c.target?.startsWith('agent:') && c.source !== c.target && agents.some(a => 'agent:' + a.id === c.target && a.connected)}
      onEdgeDoubleClick={(_event, edge) => { try { onRelay(payloadFor(edge), [edge.target.slice(6)]) } catch (e) { onNotice(e.message) } }}
      onMoveEnd={() => { if (readyRef.current) window.miro.saveCanvas({ nodes: nodesRef.current.map(cleanNode), edges: edges.map(cleanEdge), viewport: flow.getViewport() }).catch(() => onNotice('缩放位置保存失败')) }}
      minZoom={0.2} maxZoom={2} snapToGrid snapGrid={[16, 16]} deleteKeyCode={['Backspace', 'Delete']} panOnDrag={[1, 2]} selectionOnDrag nodesDraggable={!busy} nodesConnectable={!busy}
      ariaLabelConfig={{ 'node.a11yDescription.default': '按回车选中节点，方向键移动，退出键取消；按删除键移除历史节点。', 'node.a11yDescription.keyboardDisabled': '按回车选中节点，退出键取消选择。', 'node.a11yDescription.ariaLiveMessage': ({ x,y }) => `节点已移动至横坐标 ${x}，纵坐标 ${y}。`, 'edge.a11yDescription.default': '按回车选中，按删除键删除连线。', 'controls.ariaLabel': '画布控制', 'controls.zoomIn.ariaLabel': '放大画布', 'controls.zoomOut.ariaLabel': '缩小画布', 'controls.fitView.ariaLabel': '显示全部节点', 'controls.interactive.ariaLabel': '切换交互锁定', 'minimap.ariaLabel': '画布缩略图', 'handle.ariaLabel': '连线端口' }}>
      <Background gap={24} size={1} color="#cec9bd" /><MiniMap pannable zoomable nodeColor={n => n.type === 'draft' ? '#adc0a6' : n.type === 'history' ? '#b5c8d1' : '#ddd5c6'} /><Controls showInteractive={false}><ControlButton title="平移：鼠标中键或右键拖动" aria-label="画布操作说明" onClick={() => onNotice('中键／右键拖动画布；滚轮缩放；拖动卡片顶部移动；选中线按删除键移除；双击线重新打开接力。')}>?</ControlButton></Controls><Panel position="top-right" className="canvas-hint">{edges.length} 条连线 · 自动保存</Panel>
    </ReactFlow></section>
    {detail && <div className="conversation-backdrop"><section className="conversation-drawer" role="dialog" aria-modal="true" aria-label="完整对话"><div className="dialog-heading"><div><strong>{detail.title}</strong><p>{detail.source} · 共 {detail.messages.length} 条</p></div><button onClick={() => setDetail(null)}>关闭</button></div><div className="detail-messages">{visible < detail.messages.length && <button className="load-older" onClick={() => setVisible(v => v + 80)}>加载更早的记录（剩余 {detail.messages.length - visible} 条）</button>}{detailMessages.map((m, i) => <article key={i} className={`detail-message ${m.role}`}><strong>{m.role === 'user' ? '你' : '助手'}</strong><time>{m.timestamp?.slice(0, 19).replace('T', ' ')}</time><p>{m.text}</p></article>)}</div></section></div>}
    {binding && <div className="modal-backdrop"><section className="relay-dialog" role="dialog" aria-modal="true" aria-label="绑定原生会话"><div className="dialog-heading"><strong>绑定原生记录</strong><button onClick={() => setBinding(null)}>取消</button></div><p>来源：{binding.label} · {binding.title}</p><p className="relay-scope">请选择正在使用这段对话的 Agent。仅改变 Miro 显示，不切换其原窗口的会话。</p><div className="binding-options">{agents.filter(a => a.external || !a.desktop).map(a => <button key={a.id} onClick={async () => { try { await window.miro.bindHistory(a.id, binding.key); onBindingsChanged(); setBinding(null); onNotice('已绑定原生显示，持续读取更新') } catch (e) { onNotice(e.message) } }}>{a.label}</button>)}</div></section></div>}
  </div>
}
export default function SessionCanvas(props) { return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider> }
