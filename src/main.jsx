import './shared/resizeObserver.js'
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './workspace.css'
class StartupBoundary extends React.Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <main className="startup-error" aria-label="界面加载失败，请重新启动"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v6M12 17h.01"/></svg></main> : this.props.children }
}
createRoot(document.getElementById('root')).render(<React.StrictMode><StartupBoundary><App /></StartupBoundary></React.StrictMode>)
