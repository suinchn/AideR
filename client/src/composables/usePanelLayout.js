import { ref, onBeforeUnmount } from 'vue'

/**
 * Tiny resizable splitter composable.
 * Manages a vertical split (left/right) ratio and horizontal split (top/bottom).
 * Renders draggable divider elements via helpers.
 */
export function useResize(direction, initial = 0.5, min = 0.18, max = 0.82) {
  const ratio = ref(initial)
  const dragging = ref(false)

  function onDown(ev) {
    ev.preventDefault()
    // Capture the splitter's container NOW (during the gesture); inside the
    // move handler ev.currentTarget is the window (mousemove bound there).
    const parentEl = ev.currentTarget.parentElement
    dragging.value = true
    const move = (e) => {
      if (!parentEl) return
      const rect = parentEl.getBoundingClientRect()
      let r
      if (direction === 'col') {
        r = (e.clientX - rect.left) / rect.width
      } else {
        r = (e.clientY - rect.top) / rect.height
      }
      ratio.value = Math.min(max, Math.max(min, r))
    }
    const up = () => {
      dragging.value = false
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return { ratio, dragging, onDown }
}
