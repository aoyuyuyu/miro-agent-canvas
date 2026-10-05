import React, { useEffect, useMemo, useRef } from 'react'
export default function AgentRow({ agent, messages, status, error, progress, selected, onSelect, onNewSession, onDisconnect, onRename, makeRelay, relayHandle, dragging, chosen }) {
  const scroll = useRef(null), row = useRef(null)
  useEffect(() => { if (selected && row.current) row.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [selected])
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight }, [messages, selected])
  const preview = useMemo(() => [...messages].reverse().find(m => m.role === 'assistant')?.text || (agent.connected ? '已连接，等待消息' : '暂时离线'), [messages, agent.connected])
  const statusLabel = !agent.connected ? '离线' : ({ idle: '待命', working: '工作中', done: '已完成', error: '出错' }[status] || '待命')
  return <section ref={row} className={`agent-row ${selected ? 'expanded selected' : ''} ${chosen ? 'recipient' : ''}`}>
    <div className="avatar-column">
      <button data-relay-target={agent.id} className={`agent-avatar state-${agent.connected ? status : 'offline'} ${dragging && agent.connected ? 'relay-target' : ''}`} onClick={onSelect} title={`选择 ${agent.label}；把线拉到这里`} aria-pressed={selected}>{agent.label.slice(0, 1).toUpperCase()}</button>
      <span className="agent-name">{agent.label}</span><span className="agent-status">{statusLabel}</span>
      {chosen && <span className="recipient-label">已选接收</span>}
    </div>
    <div className="conversation-card" onClick={onSelect}>
      <div className="conversation-topline"><span>{agent.connected ? agent.desktop ? '本聊天 · 已连接' : agent.external ? '外部 Agent · 已连接' : '当前会话' : '未连接'}</span>
        <div className="card-actions" onClick={e => e.stopPropagation()}>
          {agent.external && <button className="text-button" onClick={onRename} aria-label={`更改 ${agent.label} 的名称`}>改名</button>}
          {messages.length > 0 && relayHandle(() => makeRelay('session', agent, messages), '接力会话', `接力 ${agent.label} 的当前会话`)}
        </div>
      </div>
      {!selected ? <p className="preview-text">{error || progress || preview}</p> : <div className="message-scroll" ref={scroll} onClick={e => e.stopPropagation()}>
        {messages.length === 0 && <div className="empty-text">{agent.external ? '消息会送到它自己的会话，再回到这里。' : '这里显示当前连接的对话。'}</div>}
        {messages.map((message, index) => <div key={index} className={`message ${message.role}`}>
          <div className="message-heading"><span className="message-role">{message.role === 'user' ? '你' : agent.label}</span>
            {message.role === 'assistant' && relayHandle(() => makeRelay('reply', agent, [message]), '转交', `转交 ${agent.label} 的第 ${index + 1} 条回复`)}
          </div><div className="message-text">{message.text}</div>
        </div>)}
        {progress && <div className="progress-text">{progress}</div>}
      </div>}
    </div>
    {agent.external ? <button className="new-session" onClick={onDisconnect} title={`断开 ${agent.label}`} aria-label={`断开 ${agent.label}`}>×</button> : <button className="new-session" onClick={onNewSession} disabled={agent.desktop || status === 'working'} title={agent.desktop ? '当前连接保持在本聊天' : '新会话'} aria-label="新会话">＋</button>}
  </section>
}