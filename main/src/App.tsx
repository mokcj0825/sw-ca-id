import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

function App() {
  const [url, setUrl] = useState('')
  const [current, setCurrent] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  // Ensure SW is ready before first load so it can cache on first fetch
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.catch(() => {})
    }
    return () => {}
  }, [])

  const onLoadClick = useCallback(() => {
    const trimmed = url.trim()
    if (!trimmed) return
    // Normalize to same-origin path if user pasted full URL
    try {
      const u = new URL(trimmed, window.location.origin)
      const path = u.origin === window.location.origin ? u.pathname + u.search + u.hash : trimmed
      setCurrent(path)
      // Set iframe src; SW will intercept and cache. On subsequent loads, cache will be used first.
      requestAnimationFrame(() => {
        if (iframeRef.current) iframeRef.current.src = path
      })
    } catch {
      setCurrent(trimmed)
      requestAnimationFrame(() => {
        if (iframeRef.current) iframeRef.current.src = trimmed
      })
    }
  }, [url])

  return (
    <div style={{ padding: 16 }}>
      <h2>Game Loader</h2>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="e.g. /project-1/index.html"
          style={{ flex: 1, padding: '8px 12px' }}
        />
        <button onClick={onLoadClick}>Load</button>
      </div>
      <div style={{ marginBottom: 12, color: '#666' }}>
        Current: {current || '(none)'}
      </div>
      <div style={{ border: '1px solid #ccc', height: '70vh' }}>
        <iframe ref={iframeRef} title="game" style={{ width: '100%', height: '100%', border: '0' }} />
      </div>
      <div style={{ marginTop: 12 }}>
        <button onClick={() => navigator.serviceWorker.getRegistration().then(r => r?.active?.postMessage({ type: 'PURGE' }))}>Purge Cache</button>
      </div>
    </div>
  )
}

export default App
