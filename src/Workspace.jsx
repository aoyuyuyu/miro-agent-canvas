import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  NodeResizeControl,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  useReactFlow,
  useUpdateNodeInternals,
  SelectionMode,
  PanOnScrollMode,
  getNodesBounds,
  getViewportForBounds
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  groupAgents,
  providerKey,
  sessionMatchesGroup,
  visibleAgentMessages,
  pickPortSides,
  autoLayout,
  nodeSize,
  toggleOverlap
} from './shared/workspace.js'

import codexAvatar from './assets/avatars/codex.png'
import antigravityAvatar from './assets/avatars/antigravity.png'
import workbuddyAvatar from './assets/avatars/workbuddy.png'
import hermesAvatar from './assets/avatars/hermes.svg'
import doubaoAvatar from './assets/avatars/doubao.png'
import orcaAvatar from './assets/avatars/orca.png'
import openclawAvatar from './assets/avatars/openclaw.png'
import miroAvatar from './assets/avatars/miro.png'
import { OpenCodeIcon } from './vendor/OpenCodeIcon'

const portraits = {
  miro: miroAvatar,
  codex: codexAvatar,
  antigravity: antigravityAvatar,
  workbuddy: workbuddyAvatar,
  hermes: hermesAvatar,
  doubao: doubaoAvatar,
  orca: orcaAvatar,
  openclaw: openclawAvatar
}

const portrait = item => portraits[providerKey(item?.software || item?.provider || item?.label)] || item?.avatar

function playNotifySound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const osc1 = ctx.createOscillator()
    const osc2 = ctx.createOscillator()
    const gain = ctx.createGain()
    osc1.type = 'sine'; osc1.frequency.setValueAtTime(587.33, ctx.currentTime)
    osc2.type = 'sine'; osc2.frequency.setValueAtTime(880, ctx.currentTime)
    gain.gain.setValueAtTime(0.08, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.42)
    osc1.connect(gain); osc2.connect(gain); gain.connect(ctx.destination)
    osc1.start(); osc2.start()
    osc1.stop(ctx.currentTime + 0.42); osc2.stop(ctx.currentTime + 0.42)
  } catch {}
}

function Icon({ name }) {
  const paths = {
    plus: 'M12 4v16M4 12h16',
    send: 'm6 12 6-6 6 6M12 6v13',
    person: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 22v-3a8 8 0 0 1 16 0v3',
    check: 'm5 12 4 4L19 6',
    close: 'm6 6 12 12M6 18 18 6',
    minus: 'M5 12h14',
    maximize: 'M6 9V6h3M15 6h3v3M18 15v3h-3M9 18H6v-3',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    alert: 'M12 7v6M12 17h.01',
    history: 'M5 7a9 9 0 1 1-2 8M3 3v6h6M12 7v5l3 2',
    image: 'M4 6h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm2 10 4-4 3 3 4-5 5 6H6z',
    video: 'm15 10 5-3v10l-5-3v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v2z',
    // 需求5：重叠/展开会话
    layers: 'M12 3 3 8l9 5 9-5-9-5ZM3 13l9 5 9-5M3 18l9 5 9-5',
    // 需求6：自动排版
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name] || paths.person} />
    </svg>
  )
}

function Avatar({ item, small = false, isMiro = false }) {
  if (isMiro) {
    return (
      <span className={`avatar ${small ? 'small' : ''} miro-avatar`}>
        <img src={miroAvatar} alt="Miro" draggable="false" />
      </span>
    )
  }
  const src = portrait(item)
  return (
    <span className={`avatar ${small ? 'small' : ''}`}>
      {src ? (
        <img src={src} alt="" draggable="false" />
      ) : providerKey(item?.software || item?.provider || item?.label) === 'opencode' ? (
        <OpenCodeIcon size={small ? 24 : 48} />
      ) : (
        <Icon name="person" />
      )}
    </span>
  )
}

function MediaChip({ media, onOpenLightbox }) {
  const [hovered, setHovered] = useState(false)
  const isVideo = media.type === 'video' || /\.(mp4|webm|mov)$/i.test(media.name || '')
  return (
    <div
      className="media-chip-wrapper"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className="media-chip nodrag"
        onClick={() => onOpenLightbox(media)}
        title="点击放大查看"
      >
        <span className="media-chip-icon">
          <Icon name={isVideo ? 'video' : 'image'} />
        </span>
        <span className="media-chip-name">{media.name || '附件'}</span>
      </button>
      {hovered && (
        <div className="media-preview-popover nodrag nowheel">
          {isVideo ? (
            <video src={media.src} muted autoPlay loop playsInline />
          ) : (
            <img src={media.src} alt="" />
          )}
        </div>
      )}
    </div>
  )
}

function Messages({ messages = [], media = [], onOpenLightbox, error, loading = false }) {
  const [limit, setLimit] = useState(100)
  const scroll = useRef(null)
  const atBottom = useRef(true)

  useEffect(() => {
    if (atBottom.current && scroll.current) {
      scroll.current.scrollTop = scroll.current.scrollHeight
    }
  }, [messages.length, media.length, loading])

  return (
    <div
      className="messages nodrag nowheel"
      ref={scroll}
      onScroll={e => {
        atBottom.current =
          e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 45
      }}
    >
      {messages.length > limit && (
        <button
          className="older"
          aria-label="更早的消息"
          onClick={() => {
            atBottom.current = false
            setLimit(v => v + 100)
          }}
        >
          <Icon name="more" />
        </button>
      )}
      {error && (
        <span className="record-alert" aria-label={error} role="img">
          <Icon name="alert" />
        </span>
      )}
      {loading && (
        <div className="skeleton">
          <i />
          <i />
          <i />
        </div>
      )}
      {media.map((item, idx) => (
        <MediaChip key={`media-${idx}`} media={item} onOpenLightbox={onOpenLightbox} />
      ))}
      {messages.slice(-limit).map((m, i) => (
        <div className={`bubble ${m.role}`} key={i}>
          {m.text}
        </div>
      ))}
    </div>
  )
}

function ResizeArcIcon() {
  return (
    <svg className="resize-arc-icon" viewBox="0 0 20 20" fill="none">
      <path d="M16 6 A 10 10 0 0 1 6 16" stroke="#52525b" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M16 11 A 5 5 0 0 1 11 16" stroke="#71717a" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

// 需求8：四个方位的连接点，顺序即绘制顺序
const PORT_SIDES = [
  ['top', Position.Top],
  ['right', Position.Right],
  ['bottom', Position.Bottom],
  ['left', Position.Left]
]

// 需求8：会话框内的模型与思考强度选择器。
// 只对 Agent 会话框显示；用户会话框没有模型概念。
function ModelPicker({ model, effort, models, efforts, onPickModel, onPickEffort, disabled }) {
  const [open, setOpen] = useState(false)
  if (disabled) return null
  const modelLabel = models.find(m => m.id === model)?.label || '默认模型'
  const effortLabel = efforts.find(e => e.id === effort)?.label || '默认思考'
  return (
    <div className="model-picker nodrag nopan" onClick={e => e.stopPropagation()}>
      <button
        type="button"
        className="model-chip"
        onClick={() => setOpen(v => !v)}
        title="切换模型与思考能力"
        aria-label="切换模型与思考能力"
      >
        <span className="model-name">{modelLabel}</span>
        <span className="model-effort">{effortLabel}</span>
      </button>
      {open && (
        <div className="model-menu" role="menu">
          <div className="model-menu-group">
            <div className="model-menu-title">模型</div>
            {models.map(m => (
              <button
                key={m.id}
                type="button"
                role="menuitemradio"
                aria-checked={model === m.id}
                className={`model-menu-item ${model === m.id ? 'active' : ''}`}
                onClick={() => { onPickModel(m.id); setOpen(false) }}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="model-menu-group">
            <div className="model-menu-title">思考能力</div>
            {efforts.map(e => (
              <button
                key={e.id}
                type="button"
                role="menuitemradio"
                aria-checked={effort === e.id}
                className={`model-menu-item ${effort === e.id ? 'active' : ''}`}
                onClick={() => { onPickEffort(e.id); setOpen(false) }}
              >
                {e.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Conversation({ id, data, selected }) {
  const isThinking = data.status === 'working'
  const isUnread = !isThinking && data.unread

  return (
    <section
      className={`conversation ${data.local ? 'local-conversation' : ''} ${selected ? 'selected' : ''} ${data.wired ? 'wired' : ''}`}
      data-conversation={id}
      onClick={data.onRead}
    >
      {/* 仅在右下角保留拉大把手，鼠标悬停时出现半圆弧 */}
      <NodeResizeControl
        position="bottom-right"
        minWidth={data.local ? 320 : 360}
        minHeight={data.local ? 200 : 320}
        maxWidth={2000}
        maxHeight={3000}
        className="corner-resizer"
      >
        <ResizeArcIcon />
      </NodeResizeControl>

      <header className="conversation-grip">
        <Avatar item={data.item} small />
        <span className="conversation-title">{data.title}</span>
        {/* 需求8：标题栏显示当前模型名，点击可切换模型与思考能力 */}
        <ModelPicker
          model={data.model}
          effort={data.reasoningEffort}
          models={data.models || []}
          efforts={data.efforts || []}
          disabled={!data.showModelPicker}
          onPickModel={data.onPickModel}
          onPickEffort={data.onPickEffort}
        />
      </header>

      {/* 状态指示点：橙点（思考中）或绿点（新回复），已读后消失，取消关闭功能 */}
      {isThinking ? (
        <span className="status-indicator thinking" title="Agent 思考中..." />
      ) : isUnread ? (
        <span className="status-indicator replied" title="新回复（点击已读）" />
      ) : null}

      {/* 需求8+9：四向连接点。默认隐藏，仅鼠标靠近该侧时该侧才出现。
          位置键供需求9 判断两框相对方向并选择最近的一侧连线。 */}
      {PORT_SIDES.map(([side, pos]) => (
        <Handle
          key={side}
          type="source"
          position={pos}
          id={`out-${side}`}
          className={`edge-port port-${side}`}
          isConnectableStart
          isConnectableEnd
          aria-label={`从${side}连接`}
          data-port-side={side}
        />
      ))}

      <Messages
        messages={data.messages}
        media={data.media || []}
        onOpenLightbox={data.onOpenLightbox}
        error={data.error}
        loading={data.loading}
      />
    </section>
  )
}

function Wire(props) {
  const [path, x, y] = getBezierPath(props)
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        interactionWidth={26}
        style={props.style}
        markerStart={props.markerStart}
        markerEnd={props.markerEnd}
      />
      <EdgeLabelRenderer>
        <button
          className={`wire-remove nodrag nopan ${props.selected ? 'selected' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${x}px,${y}px)` }}
          aria-label="断开连线"
          data-wire={props.id}
          onClick={() => props.data.remove(props.id)}
        >
          <Icon name="close" />
        </button>
      </EdgeLabelRenderer>
    </>
  )
}

const nodeTypes = { agent: Conversation, history: Conversation, prompt: Conversation }
const edgeTypes = { wire: Wire }

const serial = ({
  id,
  type,
  position,
  agentId,
  groupKey,
  messageOffset,
  historyKey,
  width,
  height,
  title,
  recipients,
  requestIds,
  requestTexts,
  deliveries,
  messages,
  media,
  parentPromptId,
  sessionKey
}) => ({
  id,
  type,
  position,
  agentId,
  groupKey,
  messageOffset,
  historyKey,
  width,
  height,
  title,
  recipients,
  requestIds,
  requestTexts,
  deliveries,
  messages,
  media,
  parentPromptId,
  sessionKey
})

function Surface() {
  const [agents, setAgents] = useState([])
  const [states, setStates] = useState({})
  const [catalog, setCatalog] = useState([])
  const [records, setRecords] = useState({})
  const [nodes, setNodes] = useState([])
  const [edges, setEdges] = useState([])

  const [ready, setReady] = useState(false)
  const [shelfHovered, setShelfHovered] = useState(false)
  const [filter, setFilter] = useState(null)
  const [hoverFilter, setHoverFilter] = useState(null)
  const [inline, setInline] = useState(null)
  const [page, setPage] = useState(80)

  const [busy, setBusy] = useState({})
  const [feedback, setFeedback] = useState(null)
  const [copyBubble, setCopyBubble] = useState(false)
  const [lightboxMedia, setLightboxMedia] = useState(null)

  // 浮动输入框状态
  const [composerText, setComposerText] = useState('')
  // 需求8：可选模型与思考强度
  const [modelChoices, setModelChoices] = useState({ models: [], efforts: [] })
  const [nodeModels, setNodeModels] = useState({})

  // 记录每个会话已读的消息数量
  const [readCounts, setReadCounts] = useState({})

  // 右键临时全新未发消息的对话框映射：groupKey -> nodeId
  const [pendingRightClickNodes, setPendingRightClickNodes] = useState({})

  // 用户设置（提示音等）
  const [settings, setSettings] = useState({ sound: false, glowIntensity: 'weak' })

  const flow = useReactFlow()
  const internals = useUpdateNodeInternals()
  const graph = useRef({ nodes: [], edges: [] })
  const snapshot = useRef({ agents: [], groups: [], states: {}, catalog: [], records: {} })
  const refreshing = useRef(false)
  const inlineRef = useRef(null)
  const sending = useRef(new Set())
  const recordLoads = useRef(new Map())
  const prevStates = useRef({})

  const groups = groupAgents(agents)
  snapshot.current = { agents, groups, states, catalog, records }
  inlineRef.current = inline

  const flash = useCallback(ok => {
    setFeedback(ok ? 'check' : 'alert')
    setTimeout(() => setFeedback(null), 1800)
  }, [])

  // 需求4：取消磁吸与碰撞避让，对话框允许自由重叠。仅保留原坐标。
  const commit = (nextNodes, nextEdges = graph.current.edges) => {
    graph.current = { nodes: nextNodes, edges: nextEdges }
    setNodes(nextNodes)
    setEdges(nextEdges)
  }

  const readRecord = useCallback(async key => {
    if (recordLoads.current.has(key)) return recordLoads.current.get(key)
    const task = window.miro
      .readHistory(key)
      .then(record => {
        setRecords(prev => ({ ...prev, [key]: { ...record, loaded: true } }))
        return record
      })
      .catch(error => {
        setRecords(prev => ({ ...prev, [key]: { messages: [], loaded: true, error: error.message } }))
        return null
      })
      .finally(() => recordLoads.current.delete(key))
    recordLoads.current.set(key, task)
    return task
  }, [])

  const refresh = useCallback(async () => {
    if (refreshing.current) return
    refreshing.current = true
    try {
      const [list, state, history, s] = await Promise.all([
        window.miro.listAgents(),
        window.miro.getState(),
        window.miro.listHistory(),
        window.miro.getSettings ? window.miro.getSettings() : Promise.resolve({ sound: false })
      ])
      setAgents(list)
      const newStates = { ...state.agentStates, codex: { messages: state.messages, status: state.status } }
      setStates(newStates)
      setCatalog(history.sessions)
      if (s) setSettings(s)

      // 判断是否有新回复完成 -> 触发提示音
      if (s?.sound) {
        for (const [k, cur] of Object.entries(newStates)) {
          const old = prevStates.current[k]
          if (old?.status === 'working' && cur?.status !== 'working') {
            playNotifySound()
            break
          }
        }
      }
      prevStates.current = newStates

      // 更新托盘活跃状态
      const active = list.filter(a => newStates[a.id]?.status === 'working' || a.status === 'working')
      if (window.miro.updateTrayActivity) {
        window.miro.updateTrayActivity({
          activeAgents: active,
          hasUnread: Object.entries(newStates).some(([_, st]) => st?.messages?.at(-1)?.role === 'assistant')
        })
      }

      const keys = new Set(
        [...graph.current.nodes.map(n => n.historyKey).filter(Boolean), inlineRef.current].filter(Boolean)
      )
      await Promise.all([...keys].map(readRecord))
    } catch {
      flash(false)
    } finally {
      refreshing.current = false
    }
  }, [flash, readRecord])

  useEffect(() => {
    let active = true
    window.miro
      .loadCanvas()
      .then(saved => {
        if (!active) return
        const restored = (saved?.nodes || [])
          .filter(n => ['agent', 'history', 'prompt'].includes(n.type))
          .map(n => ({ ...n, recipients: n.recipients || [], messages: n.messages || [], media: n.media || [] }))
        const valid = (saved?.edges || [])
          .filter(e => restored.some(n => n.id === e.source) && restored.some(n => n.id === e.target))
          .map(e => ({
            ...e,
            sourceHandle: e.sourceHandle === 'session' || e.sourceHandle === 'text' || e.sourceHandle === 'out'
              ? 'out-top'
              : e.sourceHandle
          }))
        commit(restored, valid)
        if (saved?.viewport) flow.setViewport(saved.viewport)
        setReady(true)
      })
      .catch(() => {
        flash(false)
        setReady(true)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!ready) return
    refresh()
    const timer = setInterval(refresh, 3000)
    const unsubscribe = window.miro.onAgentEvent(event => {
      if (event.type === 'close_blocked') flash(false)
      else refresh()
    })
    const unsubSettings = window.miro.onSettingsChange?.(s => {
      if (s) setSettings(s)
    })
    return () => {
      clearInterval(timer)
      unsubscribe()
      unsubSettings?.()
    }
  }, [ready, refresh, flash])

  const persist = useCallback(() => {
    if (ready) {
      window.miro
        .saveCanvas({
          nodes: graph.current.nodes.map(serial),
          edges: graph.current.edges.map(({ id, source, target, sourceHandle = 'out-top', targetHandle = 'in-top' }) => ({
            id,
            source,
            target,
            sourceHandle,
            targetHandle
          })),
          viewport: flow.getViewport()
        })
        .catch(() => flash(false))
    }
  }, [ready, flash, flow])

  useEffect(() => {
    if (!ready) return
    const timer = setTimeout(persist, 350)
    const ports = setTimeout(() => internals(nodes.map(n => n.id)), 100)
    return () => {
      clearTimeout(timer)
      clearTimeout(ports)
    }
  }, [ready, nodes, edges, persist, internals])

  const location = () => flow.screenToFlowPosition({ x: 120, y: 120 })

  const groupFor = node =>
    snapshot.current.groups.find(
      g =>
        g.key === node.groupKey ||
        g.members.some(a => a.id === node.agentId) ||
        (node.historyKey && sessionMatchesGroup(snapshot.current.catalog.find(s => s.key === node.historyKey) || {}, g))
    )

  const messageList = node => {
    if (node.type === 'prompt') return node.messages || []
    const own = node.sessionKey ? snapshot.current.states[node.sessionKey]?.messages || [] : []
    const delivered = node.requestIds?.length ? visibleAgentMessages(node, snapshot.current.states) : []
    const local = node.messages || []
    const base = delivered.length ? delivered : own
    const counts = new Map()
    base.forEach(m => {
      const key = m.role + '\0' + m.text
      counts.set(key, (counts.get(key) || 0) + 1)
    })
    const pending = local.filter(m => {
      const key = m.role + '\0' + m.text
      const count = counts.get(key) || 0
      if (count) {
        counts.set(key, count - 1)
        return false
      }
      return true
    })
    const fresh = node.sessionKey
      ? [...base, ...pending]
      : visibleAgentMessages(
          { ...node, agentId: node.requestIds?.length || node.requestTexts?.length ? node.agentId : undefined },
          snapshot.current.states
        )
    return node.historyKey ? [...(snapshot.current.records[node.historyKey]?.messages || []), ...fresh] : fresh
  }

  const selectedFor = node => [
    ...new Set([...(node.recipients || []), ...(node.type === 'agent' ? [groupFor(node)?.key].filter(Boolean) : [])])
  ]

  function markNodeAsRead(nodeId) {
    const node = graph.current.nodes.find(n => n.id === nodeId)
    if (!node) return
    const total = messageList(node).length
    setReadCounts(prev => ({ ...prev, [nodeId]: total }))
  }

  function setTargets(id, keys) {
    const source = graph.current.nodes.find(n => n.id === id)
    if (!source) return
    const own = source.type === 'agent' ? groupFor(source)?.key : null
    const chosen = [...new Set(keys)]
    const nextNodes = graph.current.nodes.map(n => (n.id === id ? { ...n, recipients: chosen } : n))
    let nextEdges = graph.current.edges.filter(
      e => e.source !== id || chosen.includes(groupFor(graph.current.nodes.find(n => n.id === e.target) || {})?.key)
    )
    chosen
      .filter(k => k !== own)
      .forEach((key, index) => {
        const group = snapshot.current.groups.find(g => g.key === key)
        if (!group) return
        if (nextEdges.some(e => e.source === id && groupFor(nextNodes.find(n => n.id === e.target) || {})?.key === key))
          return
        let target = nextNodes.find(n => n.parentPromptId === id && groupFor(n)?.key === key)
        if (!target) {
          target = {
            id: 'agent:' + crypto.randomUUID(),
            type: 'agent',
            parentPromptId: id,
            groupKey: key,
            agentId: group.representative.id,
            messageOffset: snapshot.current.states[group.representative.id]?.messages?.length || 0,
            position: { x: source.position.x + (index + 1) * 438, y: source.position.y },
            width: 410,
            height: 430,
            messages: [],
            recipients: [key]
          }
          nextNodes.push(target)
        }
        nextEdges = addEdge(
          { id: 'wire:' + crypto.randomUUID(), source: id, target: target.id, sourceHandle: 'out', targetHandle: 'in' },
          nextEdges
        )
      })
    commit(nextNodes, nextEdges)
  }

  function removeWires(ids) {
    const removed = new Set(ids)
    const nextEdges = graph.current.edges.filter(e => !removed.has(e.id))
    const affected = new Set(graph.current.edges.filter(e => removed.has(e.id)).map(e => e.source))
    commit(
      graph.current.nodes.map(n =>
        affected.has(n.id)
          ? {
              ...n,
              recipients: [
                ...new Set([
                  ...(n.type === 'agent' ? [groupFor(n)?.key].filter(Boolean) : []),
                  ...nextEdges
                    .filter(e => e.source === n.id)
                    .map(e => groupFor(graph.current.nodes.find(t => t.id === e.target) || {})?.key)
                    .filter(Boolean)
                ])
              ]
            }
          : n
      ),
      nextEdges
    )
  }

  async function openHistory(session, position) {
    if (graph.current.nodes.some(n => n.historyKey === session.key)) return
    const group = snapshot.current.groups.find(g => sessionMatchesGroup(session, g))
    const node = {
      id: 'history:' + crypto.randomUUID(),
      type: 'history',
      historyKey: session.key,
      groupKey: group?.key,
      position: position || location(),
      width: 410,
      height: 430,
      messages: [],
      recipients: []
    }
    commit([...graph.current.nodes, node])
    setInline(null)
    await readRecord(session.key)
    setTimeout(() => flow.fitView({ padding: 0.15, duration: 200 }), 150)
  }

  // 发送消息到指定节点（支持单发和群发）
  async function sendToNode(id, text) {
    if (sending.current.has(id)) return false
    let node = graph.current.nodes.find(n => n.id === id)
    if (!node) return false
    text = text.trim()
    if (text) {
      const previous = node.type === 'agent' && !node.requestTexts?.length ? messageList(node) : node.messages || []
      node = {
        ...node,
        messages: [...previous, { role: 'user', text }],
        title: node.title || (node.type === 'prompt' ? text.slice(0, 150) : undefined)
      }
      commit(graph.current.nodes.map(n => (n.id === id ? node : n)))
      markNodeAsRead(id)
    }
    const keys = selectedFor(node)
    if (!keys.length) return true
    sending.current.add(id)
    setBusy(prev => ({ ...prev, [id]: true }))
    let allOk = true
    try {
      const context = messageList(node)
      const total = context.length
      await Promise.all(
        keys.map(async key => {
          const source = graph.current.nodes.find(n => n.id === id)
          const own = node.type === 'agent' && groupFor(node)?.key === key
          const delivered = source?.deliveries?.[key] || 0
          const pending = own && source.requestTexts?.length ? (text ? [{ role: 'user', text }] : []) : context.slice(delivered)
          if (!pending.length) return
          const group = snapshot.current.groups.find(g => g.key === key)
          const client = group?.representative
          if (!client?.connected) {
            allOk = false
            return
          }
          const targets = own
            ? [source]
            : graph.current.nodes.filter(
                n => graph.current.edges.some(e => e.source === id && e.target === n.id) && groupFor(n)?.key === key
              )
          if (!targets.length) {
            allOk = false
            return
          }
          const payload = pending.map(m => m.text).join('\n\n')
          if (payload.length > 20000) {
            allOk = false
            return
          }
          const receipt = await window.miro.sendConversation({
            agentId: client.id,
            conversationId: targets[0].sessionKey?.replace(/^miro-session:/, '') || targets[0].id,
            text: payload
          })
          if (!receipt?.ok) {
            allOk = false
            return
          }
          commit(
            graph.current.nodes.map(n => {
              let updated = n.id === id ? { ...n, deliveries: { ...n.deliveries, [key]: total } } : n
              if (targets.some(t => t.id === n.id)) {
                updated = {
                  ...updated,
                  agentId: client.id,
                  sessionKey: receipt.sessionKey,
                  requestIds: [...(n.requestIds || []), ...(receipt.messageId ? [receipt.messageId] : [])],
                  requestTexts: [...(n.requestTexts || []), payload],
                  messages: own ? updated.messages : [...(n.messages || []), { role: 'user', text: payload }]
                }
              }
              return updated
            })
          )
        })
      )
      if (!allOk) flash(false)
    } catch (error) {
      allOk = false
      commit(graph.current.nodes.map(n => (n.id === id ? { ...n, error: error.message } : n)))
      flash(false)
    } finally {
      sending.current.delete(id)
      setBusy(prev => ({ ...prev, [id]: false }))
      refresh()
    }
    return true
  }

  // 点击最左侧加号：新建空白会话框
  function handleAddNode() {
    const node = {
      id: 'prompt:' + crypto.randomUUID(),
      type: 'prompt',
      position: location(),
      width: 410,
      height: 320,
      messages: [],
      media: [],
      recipients: [],
      deliveries: {}
    }
    commit([...graph.current.nodes, node])
  }

  // 需求2：点击某个 Agent 头像，在画布新建该 Agent 的会话框。
  // 不使用右键，不改筛选，因此不会出现蓝框高亮。
  function handleAddNodeForGroup(group) {
    if (!group) return
    const representative = group.connected
      ? group.members.find(m => m.id === 'codex') || group.members.find(m => m.connected) || group.members[0]
      : group.members[0]
    const node = {
      id: 'local:' + crypto.randomUUID(),
      type: 'agent',
      local: true,
      agentId: representative?.id,
      provider: group.key,
      software: group.key,
      title: group.label || group.key,
      position: location(),
      width: 410,
      height: 430,
      messages: []
    }
    commit([...graph.current.nodes, node])
  }

  // 需求3：点击 Miro 头像，在画布新建「用户会话框」（你自己的输入框）。
  function handleAddUserNode() {
    const node = {
      id: 'prompt:' + crypto.randomUUID(),
      type: 'prompt',
      position: location(),
      width: 410,
      height: 320,
      messages: []
    }
    commit([...graph.current.nodes, node])
  }

  // 右键 Agent 头像：弹出全新对话框；再次右键（若未开始聊天）则收回消失
  function handleRightClickAgent(group) {
    const existingNodeId = pendingRightClickNodes[group.key]
    const existingNode = existingNodeId && graph.current.nodes.find(n => n.id === existingNodeId)

    // 如果已有一个由此 Agent 右键弹出且还没有聊天记录的对话框，再次右键收回消失
    if (existingNode && (!existingNode.messages || existingNode.messages.length === 0)) {
      removeWires(graph.current.edges.filter(e => e.source === existingNodeId || e.target === existingNodeId).map(e => e.id))
      commit(
        graph.current.nodes.filter(n => n.id !== existingNodeId),
        graph.current.edges.filter(e => e.source !== existingNodeId && e.target !== existingNodeId)
      )
      setPendingRightClickNodes(prev => {
        const next = { ...prev }
        delete next[group.key]
        return next
      })
      return
    }

    // 否则弹出全新对话框
    const newNode = {
      id: 'agent:' + crypto.randomUUID(),
      type: 'agent',
      groupKey: group.key,
      agentId: group.representative?.id,
      position: location(),
      width: 410,
      height: 430,
      messages: [],
      media: [],
      recipients: [group.key],
      deliveries: {}
    }
    setPendingRightClickNodes(prev => ({ ...prev, [group.key]: newNode.id }))
    commit([...graph.current.nodes, newNode])
  }

  // 剪贴板富媒体粘贴处理
  const handlePaste = useCallback(
    e => {
      if (['TEXTAREA', 'INPUT'].includes(e.target.tagName)) return
      const clipboardData = e.clipboardData
      if (!clipboardData) return

      const items = clipboardData.items
      let foundMedia = false

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.type.indexOf('image') !== -1) {
          const blob = item.getAsFile()
          const reader = new FileReader()
          reader.onload = event => {
            const mediaItem = {
              type: 'image',
              name: blob.name || 'Clipboard_Screenshot.png',
              src: event.target.result
            }
            const node = {
              id: 'prompt:' + crypto.randomUUID(),
              type: 'prompt',
              position: location(),
              width: 410,
              height: 320,
              messages: [],
              media: [mediaItem],
              recipients: [],
              deliveries: {}
            }
            commit([...graph.current.nodes, node])
          }
          reader.readAsDataURL(blob)
          foundMedia = true
          break
        }
      }

      if (!foundMedia) {
        const text = clipboardData.getData('text/plain')
        if (text && text.trim()) {
          const node = {
            id: 'prompt:' + crypto.randomUUID(),
            type: 'prompt',
            position: location(),
            width: 410,
            height: 320,
            messages: [{ role: 'user', text: text.trim() }],
            media: [],
            recipients: [],
            deliveries: {}
          }
          commit([...graph.current.nodes, node])
        }
      }
    },
    [commit]
  )

  useEffect(() => {
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [handlePaste])

  function connect(rawConnection) {
    if (rawConnection.source === rawConnection.target) return
    const target = graph.current.nodes.find(n => n.id === rawConnection.target)
    const group = groupFor(target || {})
    if (!['agent', 'history'].includes(target?.type) || !group) return
    // 需求9：按两框相对位置选择最近的方位作为连线端点
    const connection = { ...rawConnection, ...pickPortSides(rawConnection, graph.current.nodes) }
    const nextEdges = addEdge({ ...connection, id: 'wire:' + crypto.randomUUID() }, graph.current.edges)
    commit(
      graph.current.nodes.map(n =>
        n.id === connection.source ? { ...n, recipients: [...new Set([...(n.recipients || []), group.key])] } : n
      ),
      nextEdges
    )
  }

  // 选中的节点列表
  const selectedNodes = nodes.filter(n => n.selected)

  /* ---------- 需求10：空格键三态切换：聚焦选中 -> 全览所有 -> 聚焦选中 ---------- */
  const focusCycle = useRef('focused')
  const toggleFocus = useCallback(() => {
    if (!graph.current.nodes.length) return
    const ids = selectedNodes.map(n => n.id)
    const targets = ids.length ? graph.current.nodes.filter(n => ids.includes(n.id)) : graph.current.nodes
    const mode = focusCycle.current === 'focused' ? 'overview' : 'focused'
    focusCycle.current = mode
    const rect = flow.wrapper?.getBoundingClientRect?.()
    const width = rect?.width || window.innerWidth
    const height = rect?.height || window.innerHeight
    if (mode === 'overview') {
      // 需求10：全览所有会话框
      flow.fitView({ nodes: graph.current.nodes, padding: 0.15, duration: 320, maxZoom: 1 })
    } else if (targets.length) {
      // 需求10：聚焦到所选会话框。
      // getViewportForBounds 是 6 个位置参数 (bounds, width, height, minZoom, maxZoom, padding)，
      // 误把对象当第 4 个参数传入会被解读为 minZoom，clamp 出 NaN，setViewport 静默失效。
      const bounds = getNodesBounds(targets)
      flow.setViewport(getViewportForBounds(bounds, width, height, 0.15, 1, 0.25))
    }
  }, [flow, selectedNodes])

  // 需求8：读取可用模型与思考强度
  useEffect(() => {
    let alive = true
    window.miro?.listModels?.()
      .then(list => { if (alive && list) setModelChoices(list) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  /* ---------- 需求1：鼠标移到历史会话左侧才收回 ---------- */
  useEffect(() => {
    const onMove = e => {
      const el = shelfRef.current
      if (!el) return
      // 面板左边界：越过它（向左）即视为收回
      const left = el.getBoundingClientRect().left
      setShelfHovered(e.clientX > left - 12)
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  /* ---------- 需求10：空格键三态切换 ---------- */
  useEffect(() => {
    const onKey = e => {
      // 输入框内打字时不触发
      const tag = (e.target?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault()
        toggleFocus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleFocus])

  /* ---------- 需求8：切换会话模型与思考能力 ---------- */
  const applyModel = useCallback(async (nodeId, patch) => {
    setNodeModels(prev => {
      const cur = prev[nodeId] || {}
      const next = { ...prev, [nodeId]: { ...cur, ...patch } }
      return next
    })
    try { await window.miro?.setModel?.(patch) } catch {}
  }, [])

  /* ---------- 需求5：重叠 / 展开选中会话（逻辑见 shared/workspace.js） ---------- */
  const toggleOverlapSelected = useCallback(() => {
    const ids = selectedNodes.map(n => n.id)
    if (!ids.length) return
    commit(toggleOverlap(graph.current.nodes, ids))
  }, [selectedNodes])

  /* ---------- 需求6：自动排版（参考 pureRef 的紧凑网格） ---------- */
  const handleAutoLayout = useCallback(() => {
    const ids = new Set(selectedNodes.map(n => n.id))
    const targets = graph.current.nodes.filter(n => ids.has(n.id))
    const rest = graph.current.nodes.filter(n => !ids.has(n.id))
    const laid = autoLayout(targets.length ? targets : graph.current.nodes)
    const maxY = Math.max(0, ...laid.map(n => n.position.y + nodeSize(n).height))
    commit([
      ...laid,
      ...rest.map(n => ({ ...n, position: { x: n.position.x, y: Math.max(n.position.y, maxY + 64) } }))
    ].sort(byId))
  }, [selectedNodes])

  /* ---------- 需求1：框选后点加号，新建可群发给框选内所有 Agent 的窗口 ---------- */
  const spawnForSelection = useCallback(() => {
    const ids = new Set(selectedNodes.map(n => n.id))
    if (!ids.size) return
    const targets = graph.current.nodes.filter(n => ids.has(n.id))
    const keys = new Set()
    for (const n of targets) {
      for (const k of n.recipients || []) keys.add(k)
      if (n.type === 'agent') {
        const g = snapshot.current.groups.find(x => sessionMatchesGroup(n, x) || x.key === n.agentId)
        if (g) keys.add(g.key)
      }
    }
    if (!keys.size) return
    // 放在框选包围盒右侧
    let maxX = -Infinity, minY = Infinity
    for (const n of targets) {
      maxX = Math.max(maxX, n.position.x + nodeSize(n).width)
      minY = Math.min(minY, n.position.y)
    }
    const node = {
      id: 'local:' + crypto.randomUUID(),
      type: 'agent',
      local: true,
      recipients: [...keys],
      position: { x: maxX + 48, y: Number.isFinite(minY) ? minY : 0 },
      width: 400,
      height: 320,
      messages: [],
      selected: true
    }
    // 新节点自动选中，composer 随之出现在它下方，可直接输入并群发
    commit([...graph.current.nodes.map(n => ({ ...n, selected: false })), node])
  }, [selectedNodes])

  // 处理输入框发送（支持单选与多选批量发送）
  const handleSendComposer = async () => {
    if (!composerText.trim() || !selectedNodes.length) return
    const text = composerText.trim()
    setComposerText('')

    // 同时向选中的所有对话框广播发送
    await Promise.all(selectedNodes.map(node => sendToNode(node.id, text)))
  }

  // 装饰所有节点
  // 需求9：已连线的节点不再常显圆点（仅 hover 时可再连接）
  const wiredIds = new Set(edges.flatMap(e => [e.source, e.target]))

  const decorated = nodes.map(n => {
    const group = groupFor(n)
    const session = catalog.find(s => s.key === n.historyKey)
    const record = records[n.historyKey]
    const native = states[n.sessionKey]
    const messages = messageList(n)
    const selected = selectedFor(n)
    const readCount = readCounts[n.id] || 0
    const unread = messages.length > readCount && messages.at(-1)?.role === 'assistant'
    const status = native?.status || (group ? states[group.representative?.id]?.status : 'idle')

    return {
      ...n,
      wired: wiredIds.has(n.id),
      // 需求4：整张卡片都是拖拽区，无需先点击选中再拖；标题栏不再被单独限死。
      dragHandle: undefined,
      draggable: true,
      data: {
        item: n.type === 'prompt' ? null : group || session,
        title:
          session?.title ||
          native?.title ||
          n.title ||
          messages.find(m => m.role === 'user')?.text.slice(0, 150) ||
          '会话',
        local: n.type === 'prompt',
        // 需求8：仅 Agent 会话框可切换模型
        showModelPicker: n.type === 'agent',
        model: nodeModels[n.id]?.model || n.model || null,
        reasoningEffort: nodeModels[n.id]?.reasoningEffort || n.reasoningEffort || null,
        models: modelChoices.models,
        efforts: modelChoices.efforts,
        onPickModel: id => applyModel(n.id, { model: id }),
        onPickEffort: id => applyModel(n.id, { reasoningEffort: id }),
        messages,
        media: n.media || [],
        error: n.error || native?.error || record?.error,
        loading: n.historyKey && !record?.loaded,
        status,
        unread,
        groups,
        selected,
        onRecipients: keys => setTargets(n.id, keys),
        busy: !!busy[n.id],
        onRead: () => markNodeAsRead(n.id),
        onOpenLightbox: item => setLightboxMedia(item)
      }
    }
  })

  // 历史抽屉筛选
  const activeKeys = new Set(nodes.map(n => n.historyKey).filter(Boolean))
  const currentFilterKey = shelfHovered && hoverFilter !== undefined ? hoverFilter : filter
  const filterGroup = groups.find(g => g.key === currentFilterKey)
  // 需求1：历史会话只在鼠标进入其左侧区域（离开面板、回到画布方向）时才收回。
  const shelfRef = useRef(null)
  const isShelfOpen = shelfHovered
  const displayedHistory = catalog.filter(
    s => !activeKeys.has(s.key) && (!filterGroup || sessionMatchesGroup(s, filterGroup))
  )

  // 计算浮动输入框位置（参考图 1）
  let composerStyle = null
  let composerMode = null // 'single' | 'multi'

  if (selectedNodes.length === 1) {
    composerMode = 'single'
    const sel = selectedNodes[0]
    const width = sel.width || 410
    const height = sel.height || (sel.type === 'prompt' ? 320 : 430)
    // 渲染在选中节点的正下方
    composerStyle = {
      transform: `translate(${sel.position.x}px, ${sel.position.y + height + 12}px)`,
      width: `${width}px`
    }
  } else if (selectedNodes.length > 1) {
    composerMode = 'multi'
    // 需求7：多选时同样渲染在包围盒的下方
    let maxX = -Infinity
    let maxBottom = -Infinity
    selectedNodes.forEach(n => {
      const w = n.width || 410
      const h = n.height || (n.type === 'prompt' ? 320 : 430)
      maxX = Math.max(maxX, n.position.x)
      maxBottom = Math.max(maxBottom, n.position.y + h)
    })
    composerStyle = {
      transform: `translate(${maxX}px, ${maxBottom + 12}px)`,
      width: '420px'
    }
  }

  // 需求1：加号定位在框选包围盒右侧中部
  let selectionAddStyle = null
  if (selectedNodes.length > 0) {
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    selectedNodes.forEach(n => {
      const w = n.width || 410
      maxX = Math.max(maxX, n.position.x + w)
      minY = Math.min(minY, n.position.y)
      maxY = Math.max(maxY, n.position.y + (n.height || 430))
    })
    selectionAddStyle = {
      transform: `translate(${maxX + 20}px, ${(minY + maxY) / 2 - 20}px)`
    }
  }

  // 复制接入提示词
  const handleCopyPrompt = async () => {
    try {
      setCopyBubble(true)
      await window.miro.copyInvitation()
      setTimeout(() => setCopyBubble(false), 2600)
    } catch {
      setCopyBubble(false)
      flash(false)
    }
  }

  return (
    <main className={`surface ${isShelfOpen ? 'shelf-open' : ''}`}>
      <div className="window-grip" />

      {/* 右上角窗口控制按钮：纯色无图标 */}
      <div className="window-buttons">
        <button
          aria-label="最小化窗口"
          className="win-btn win-btn-minimize"
          onClick={() => window.miro.windowAction('minimize')}
        />
        <button
          aria-label="全屏窗口"
          className="win-btn win-btn-fullscreen"
          onClick={() => window.miro.windowAction('fullscreen')}
        />
        <button
          aria-label="关闭窗口"
          className="win-btn win-btn-close"
          onClick={() => window.miro.windowAction('close')}
        />
      </div>

      {/* 画布区域 */}
      <div
        className="workspace"
        onDragOver={e => {
          if (e.dataTransfer.types.includes('application/miro-history')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
          }
        }}
        onDrop={e => {
          e.preventDefault()
          const session = catalog.find(s => s.key === e.dataTransfer.getData('application/miro-history'))
          if (session) openHistory(session, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }))
        }}
      >
        <ReactFlow
          nodes={decorated}
          edges={edges.map(e => ({ ...e, type: 'wire', data: { remove: id => removeWires([id]) } }))}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={changes => {
            commit(applyNodeChanges(changes, graph.current.nodes), graph.current.edges)
          }}
          onEdgesChange={changes => {
            const removals = changes.filter(c => c.type === 'remove').map(c => c.id)
            if (removals.length) removeWires(removals)
            else commit(graph.current.nodes, applyEdgeChanges(changes, graph.current.edges))
          }}
          onConnect={connect}
          onEdgeDoubleClick={(_e, edge) => removeWires([edge.id])}
          onMoveEnd={persist}
          minZoom={0.15}
          maxZoom={2.5}
          defaultEdgeOptions={{ style: { stroke: '#a1a1aa', strokeWidth: 2.5 }, interactionWidth: 26 }}
          deleteKeyCode={['Backspace', 'Delete']}
          connectionLineStyle={{ stroke: '#a1a1aa', strokeWidth: 2.5 }}
          proOptions={{ hideAttribution: true }}
          /* 需求2：右键与中键平移画布 */
          panOnDrag={[1, 2]}
          /* 需求1：左键在空白处拖拽即框选 */
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          /* 需求4：节点无需先点击即可直接拖动（整卡都是拖拽把手） */
          nodesDraggable
          /* 需求5：滚轮直接缩放，不需按 Ctrl */
          zoomOnScroll
          zoomOnScrollSpeed={0.2}
          panOnScroll={false}
          zoomOnPinch
          zoomActivationKeyCode={null}
          preventScrolling={false}
          /* 需求2：屏蔽浏览器右键菜单，交给画布平移 */
          onContextMenu={e => e.preventDefault()}
        >
          {/* 需求6：仅多选（两个及以上）时才出现工具栏；单选不出现 */}
          {selectedNodes.length > 1 && (
            <div className="selection-toolbar nodrag nopan" role="toolbar" aria-label="选中对话框工具">
              <button type="button" onClick={toggleOverlapSelected} title="重叠 / 展开所选会话">
                <Icon name="layers" />
                <span>重叠/展开</span>
              </button>
              <button type="button" onClick={handleAutoLayout} title="自动排版所选会话">
                <Icon name="grid" />
                <span>自动排版</span>
              </button>
              <span className="selection-count">已选 {selectedNodes.length}</span>
            </div>
          )}

          {/* 需求1：框选后在旁边显示加号，点击新建可群发的窗口 */}
          {selectedNodes.length > 0 && (
            <button
              type="button"
              className="selection-add nodrag nopan"
              style={selectionAddStyle}
              onClick={spawnForSelection}
              title="新建会话并发送给框选内的所有 Agent"
              aria-label="新建会话并群发给所选 Agent"
            >
              <Icon name="plus" />
            </button>
          )}

          {/* 浮动输入框（参考图 1：单选在下方，多选在旁边） */}
          {composerStyle && (
            <div className={`floating-composer nodrag nowheel ${composerMode}`} style={composerStyle}>
              {composerMode === 'multi' && (
                <div className="multi-target-badge">
                  <span>同时发送给 {selectedNodes.length} 个对话框</span>
                </div>
              )}
              <form
                className="floating-composer-inner"
                onSubmit={e => {
                  e.preventDefault()
                  handleSendComposer()
                }}
              >
                <textarea
                  placeholder="描述任何你想要生成的内容"
                  value={composerText}
                  maxLength={20000}
                  rows={2}
                  onChange={e => setComposerText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      handleSendComposer()
                    }
                  }}
                />
                <button
                  type="submit"
                  className="floating-send-btn"
                  aria-label="发送"
                  disabled={!composerText.trim()}
                >
                  <Icon name="send" />
                </button>
              </form>
            </div>
          )}
        </ReactFlow>
      </div>

      {/* 历史抽屉 */}
      {isShelfOpen && (
        <>
        <aside
          ref={shelfRef}
          className="history-shelf nodrag"
          onMouseEnter={() => setShelfHovered(true)}
        >
          <div
            className="history-scroll"
            onScroll={e => {
              if (e.currentTarget.scrollTop + e.currentTarget.clientHeight > e.currentTarget.scrollHeight - 160) {
                setPage(v => v + 80)
              }
            }}
          >
            {displayedHistory.slice(0, page).map(session => (
              <section
                key={session.key}
                className={`history-card ${inline === session.key ? 'expanded' : ''} ${session.readable ? '' : 'unreadable'}`}
                data-history-key={session.key}
              >
                <button
                  className="history-heading"
                  draggable
                  onDragStart={e => {
                    e.dataTransfer.setData('application/miro-history', session.key)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onClick={() => {
                    const key = inline === session.key ? null : session.key
                    setInline(key)
                    if (key) readRecord(key)
                  }}
                  onDoubleClick={() => openHistory(session)}
                  aria-label="展开或收起历史会话"
                >
                  <Avatar item={session} small />
                  <span className="history-preview">{session.title}</span>
                  {!session.readable && <span className="unreadable-dot" />}
                </button>
                {inline === session.key && (
                  <Messages
                    messages={records[session.key]?.messages}
                    error={records[session.key]?.error}
                    loading={!records[session.key]?.loaded}
                  />
                )}
              </section>
            ))}
          </div>
        </aside>
        </>
      )}

      {/* 右侧 Agent 栏 */}
      <aside className="agent-rail">
        <div className="agent-scroll">
          {/* 最顶部：Miro 头像 */}
          <div
            className="agent-slot miro-slot"
            onMouseEnter={() => {
              setHoverFilter(null)
              setShelfHovered(true)
            }}
          >
            <button
              className={`agent-button miro-button ${filter === null ? 'filtered' : ''}`}
              aria-label="Miro 全部历史"
              onClick={() => {
                // 需求3：点击 Miro 头像在画布新建「用户会话框」
                handleAddUserNode()
              }}
            >
              <Avatar isMiro />
            </button>
          </div>

          {/* 各个 Agent 头像 */}
          {groups.map(group => {
            const isWorking = group.members.some(
              m => states[m.id]?.status === 'working' || m.status === 'working'
            )
            const hasUnread =
              !isWorking &&
              group.members.some(
                m => states[m.id]?.messages?.at(-1)?.role === 'assistant'
              )

            return (
              <div
                className="agent-slot"
                key={group.key}
                onMouseEnter={() => {
                  setHoverFilter(group.key)
                  setShelfHovered(true)
                }}
                  >
                {/* 头顶状态点：思考中橙点（低频闪烁），未读绿点，已读后不出现任何点 */}
                <div className="status-dots">
                  {isWorking ? (
                    <span className="thinking" title="思考中" />
                  ) : hasUnread ? (
                    <span className="replied" title="新回复" />
                  ) : null}
                </div>

                <button
                  className={`agent-button ${group.connected ? '' : 'offline'} ${filter === group.key ? 'filtered' : ''}`}
                  aria-label={`筛选 ${group.label || group.key} 历史`}
                  data-agent-group={group.key}
                  onClick={() => {
                    // 需求2：点击头像直接在画布新建该Agent 的会话框，
                    // 不再切换筛选（因此不会出现蓝框高亮）。
                    handleAddNodeForGroup(group)
                  }}
                  onContextMenu={e => {
                    e.preventDefault()
                    handleRightClickAgent(group)
                  }}
                  title="左键查看历史，右键新建/收回会话框"
                >
                  <Avatar item={group} />
                </button>
              </div>
            )
          })}

          {/* 需求7：加号做成与 Agent 头像同尺寸的头像，放在头像列表末尾，
              随列表滚动，滚到最下面才可见。 */}
          <div className="add-agent-slot">
            {copyBubble && (
              <div className="copy-prompt-bubble">
                已复制，请发送给您的Agent
              </div>
            )}
            <button
              type="button"
              className="agent-button add-agent-avatar"
              aria-label="新建会话窗口"
              onClick={handleAddNode}
              title="新建会话窗口"
            >
              <Icon name="plus" />
            </button>
          </div>

          {/* 复制接入提示词：保留原有能力，改为紧凑小按钮 */}
          <button
            type="button"
            className="rail-mini-btn"
            aria-label="复制接入提示词"
            onClick={handleCopyPrompt}
            title="复制接入提示词，发给您的Agent"
          >
            <Icon name="person" />
          </button>
        </div>
      </aside>

      {/* 图片/视频灯箱全屏查看 */}
      {lightboxMedia && (
        <div className="lightbox-overlay nodrag" onClick={() => setLightboxMedia(null)}>
          <div className="lightbox-modal" onClick={e => e.stopPropagation()}>
            <button className="lightbox-close" onClick={() => setLightboxMedia(null)}>
              <Icon name="close" />
            </button>
            {lightboxMedia.type === 'video' || /\.(mp4|webm|mov)$/i.test(lightboxMedia.name || '') ? (
              <video src={lightboxMedia.src} controls autoPlay />
            ) : (
              <img src={lightboxMedia.src} alt="" />
            )}
            <div className="lightbox-caption">{lightboxMedia.name}</div>
          </div>
        </div>
      )}
    </main>
  )
}

export default function Workspace() {
  return (
    <ReactFlowProvider>
      <Surface />
    </ReactFlowProvider>
  )
}
