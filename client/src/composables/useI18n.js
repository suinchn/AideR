/**
 * useI18n.js — tiny reactive i18n (en/zh) with no dependencies.
 *  - ui.lang: reactive current language ('en' | 'zh')
 *  - t(key, ...args): lookup in dictionaries; value may be a string or fn(args)
 *  - setLang(l): switch + persist
 */
import { reactive } from 'vue'
import { dictionaries } from '../i18n/strings'

const savedLang = (() => {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('rauilang') : null
    return v === 'zh' ? 'zh' : 'en'
  } catch (e) { return 'en' }
})()

// reactive mirror so templates update when setLang() runs
const ui = reactive({ lang: savedLang })

function t(key, ...args) {
  const entry = dictionaries[key]
  if (!entry) return key
  const val = ui.lang === 'zh' ? entry.zh : entry.en
  if (typeof val === 'function') return val(...args)
  return val
}

function setLang(l) {
  const next = l === 'zh' ? 'zh' : 'en'
  ui.lang = next
  try { localStorage.setItem('rauilang', next) } catch (e) {}
}

export function useI18n() {
  return { ui, t, setLang }
}
