import { ref } from 'vue'

/** Shared code-font size (persisted to localStorage). Used by the Code panel
 *  title-bar A−/A+ controls and by NotebookCell for the editor font. */
const codeFont = ref(Number(localStorage.getItem('racodefont') || 15))
function bumpCodeFont(d) {
  codeFont.value = Math.min(25, Math.max(9, codeFont.value + d))
  localStorage.setItem('racodefont', String(codeFont.value))
}

export function useCodeFont() {
  return { codeFont, bumpCodeFont }
}
