export default function Composer({ text, onText, disabled, busy, onSend, agentName, group, onGroup, agents, audience, onAudience, relayHandle }) {
  const submit = () => { if (text.trim() && !disabled && !busy) onSend(text) }
  return <div className="composer-area">
    <div className="composer-heading">
      <span>{group ? `已连接 ${audience.length} 个接收对象` : `发给 ${agentName || '助手'}`}</span>
      <button className={`text-button ${group ? 'active' : ''}`} onClick={onGroup} disabled={busy}>{group ? '退出群发' : '群发'}</button>
    </div>
    {group && <div className="audience-list" aria-label="群发接收对象">
      {agents.map(a => <label key={a.id} className={`audience-chip ${audience.includes(a.id) ? 'chosen' : ''}`}>
        <input type="checkbox" checked={audience.includes(a.id)} disabled={busy || (!a.connected && !audience.includes(a.id))} onChange={() => onAudience(a.id)} />{a.label}{!a.connected && ' · 离线'}
      </label>)}
    </div>}
    <div className="composer-shell">
      <textarea aria-label="消息内容" value={text} onChange={e => onText(e.target.value)} maxLength={20000}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
        placeholder={group ? '写一句话，拉线连接多个头像，再点发送…' : '写消息，拉线到头像即可发送；也可回车发送…'} rows={2} />
      <div className="composer-actions">
        {relayHandle}
        <button className="send-button" onClick={submit} disabled={disabled || busy || !text.trim()}>{busy ? '发送中…' : group ? `发送给 ${audience.length} 位` : '发送'}</button>
      </div>
    </div>
  </div>
}