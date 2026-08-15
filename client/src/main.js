import { createApp } from 'vue'
import App from './App.vue'
import { connect } from './store'
import './style.css'

connect()

// ---- Global error surface: show any runtime error on screen so it can be reported ----
// (not for production polish — a diagnostic aid to surface otherwise-invisible failures)
function surfaceError(msg) {
  try {
    let el = document.getElementById('ra-global-error')
    if (!el) {
      el = document.createElement('div')
      el.id = 'ra-global-error'
      el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#b3261e;color:#fff;padding:6px 10px;font:12px/1.4 monospace;white-space:pre-wrap;max-height:60vh;overflow:auto;'
      document.body.appendChild(el)
    }
    el.textContent = 'Page error: ' + msg + '\n(if this keeps happening, share this text with the developer)'
    console.error('[RA-error]', msg)
  } catch (e) { /* ignore */ }
}
window.addEventListener('error', (e) => { if (e && e.message) surfaceError(e.message) })
window.addEventListener('unhandledrejection', (e) => { if (e && e.reason) surfaceError(String((e.reason && e.reason.message) || e.reason)) })

const app = createApp(App)
app.config.errorHandler = (err) => surfaceError(err && err.message ? err.message : String(err))
app.mount('#app')
