import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

async function registerSw() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw-proxy.js');
    await navigator.serviceWorker.ready;
  } catch (e) {
    console.warn('SW registration failed', e);
  }
}

registerSw();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
