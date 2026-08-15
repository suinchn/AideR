import { ref } from 'vue'
import { executeCell } from '../store'

let uid = 0

/**
 * Jupyter-style notebook state for one code window.
 * Each cell: { id, code, status: idle|running|done|error, output, plot, error }
 * Cells all run in the SAME shared R session, so variables carry across cells.
 */
export function useNotebook(initialCode = '') {
  const cells = ref([])
  const runningCount = ref(0)
  const runningAll = ref(false)
  const pausedAt = ref(-1) // index of cell that errored during runAll (-1 = none)
  const activeIndex = ref(-1) // currently selected/focused cell (for "replace selected")

  function setActive(i) { activeIndex.value = (i >= 0 && i < cells.value.length) ? i : -1 }

  function newCell(code = '') {
    return { id: 'c' + (++uid), code, status: 'idle', output: '', plot: null, error: null }
  }

  function addCell(code = '') {
    cells.value.push(newCell(code))
    return cells.value.length - 1
  }

  /** Overwrite the currently-active (selected) cell; if none active, append. */
  function replaceActive(code) {
    const i = activeIndex.value
    if (i >= 0 && cells.value[i]) {
      cells.value[i].code = code
      cells.value[i].status = 'idle'; cells.value[i].output = ''; cells.value[i].error = null; cells.value[i].plot = null
      return i
    }
    return insertAfter(Math.max(0, cells.value.length - 1), code)
  }

  function seed(code) {
    cells.value = [newCell(code || '')]
  }

  function seedMany(codes) {
    cells.value = (codes || []).filter((c) => c !== undefined).map((c) => newCell(c))
    if (!cells.value.length) cells.value = [newCell('')]
  }

  /** Clear ALL cells in this window (keeps the notebook/window itself). */
  function clear() {
    cells.value = [newCell('')]
  }

  /** Serialize for persistence: just the codes. */
  function toJSON() {
    return cells.value.map((c) => ({ code: c.code }))
  }

  /** Restore cells from a [{code}] array (persisted). Marks seeded so the
   *  initial-cells default won't re-apply on remount. */
  function load(arr) {
    cells.value = (Array.isArray(arr) && arr.length ? arr.map((c) => newCell(c.code || '')) : [newCell('')])
    this._seededInitially = true
  }

  function insertAfter(i, code = '') {
    cells.value.splice(i + 1, 0, newCell(code))
    return i + 1
  }
  function del(i) {
    cells.value.splice(i, 1)
    if (pausedAt.value === i) pausedAt.value = -1
  }
  function moveUp(i) {
    if (i <= 0) return
    const c = cells.value.splice(i, 1)[0]
    cells.value.splice(i - 1, 0, c)
  }
  function moveDown(i) {
    if (i >= cells.value.length - 1) return
    const c = cells.value.splice(i, 1)[0]
    cells.value.splice(i + 1, 0, c)
  }
  function updateCode(i, code) {
    if (cells.value[i]) cells.value[i].code = code
  }

  async function runCell(i) {
    const cell = cells.value[i]
    if (!cell || !cell.code.trim()) return
    cell.status = 'running'
    cell.error = null
    cell.output = ''
    cell.plot = null
    runningCount.value++
    try {
      const res = await executeCell(cell.code)
      if (res.ok) {
        cell.status = 'done'
        cell.output = res.output || ''
        cell.plot = res.plot || null
      } else {
        cell.status = 'error'
        cell.error = res.error || '未知错误'
        cell.output = res.output || ''
      }
    } catch (e) {
      cell.status = 'error'
      cell.error = e.message || '执行失败'
    } finally {
      runningCount.value = Math.max(0, runningCount.value - 1)
    }
    return cell
  }

  // run cells top→bottom, stopping on first error (pausedAt set -> can resume)
  async function runAll() {
    runningAll.value = true
    pausedAt.value = -1
    try {
      for (let i = 0; i < cells.value.length; i++) {
        const cell = cells.value[i]
        if (!cell.code.trim()) { cell.status = 'idle'; continue }
        await runCell(i)
        if (cell.status === 'error') { pausedAt.value = i; break }
      }
    } finally {
      runningAll.value = false
    }
  }

  // resume from the cell AFTER pausedAt (after a fix); stop again if another error
  async function resumeFrom(start) {
    runningAll.value = true
    try {
      for (let i = start; i < cells.value.length; i++) {
        const cell = cells.value[i]
        if (!cell.code.trim()) { cell.status = 'idle'; continue }
        await runCell(i)
        if (cell.status === 'error') { pausedAt.value = i; return }
      }
      pausedAt.value = -1
    } finally {
      runningAll.value = false
    }
  }

  return {
    cells, runningCount, runningAll, pausedAt, activeIndex, setActive,
    seed, seedMany, clear, toJSON, load, addCell, replaceActive, insertAfter, del, moveUp, moveDown, updateCode, runCell, runAll, resumeFrom,
  }
}
