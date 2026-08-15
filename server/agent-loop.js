'use strict';
const fs = require('fs');
const path = require('path');
/**
 * agent-loop.js — bridge between the AI and the stateful R session.
 *
 * Interaction model (adapted from pi's agent loop):
 *
 *   user prompt
 *      └─> LLM  (system prompt: "you are an R data-analysis assistant; emit R code
 *                inside <r_code>…</r_code> tags, or <r_inspect>…</r_inspect> to
 *                READ a variable's actual content, and plain text outside")
 *            └─> at conversation OPEN: inject the CURRENT environment snapshot
 *                + recent RUN HISTORY so the AI immediately "sees" what exists
 *                (manual or earlier AI work) and what was run before
 *            └─> parse segments
 *                  ├─ <r_code>     → execute in the SHARED R session (mutates state)
 *                  └─ <r_inspect>  → read-only inspection (size-capped) of a
 *                                    variable/expression, does NOT change state
 *                  └─ each result + fresh VARIABLE SNAPSHOT fed back to the LLM
 *            └─> repeat until the model stops producing tags, or step limit
 *
 * We use simple tag styles instead of native tool-calling so it works on any
 * model (Ollama/qwen, Groq/llama, Claude, GPT) without per-model tool schemas.
 *
 * Progress is emitted via an `onEvent` callback, mirroring pi's event sequence:
 *   assistant_text, segments, r_code_start, r_exec_result, inspect_result,
 *   variables, done
 */

const PROMPT_DIR = path.join(__dirname, 'prompt');
const _promptCache = {};

function _defaultPrompt(lang) {
  if (lang === 'en') {
    return `You are AideR's R data-analysis assistant, specialized in medical and bioinformatics (NGS/omics) analysis. You get work done by ACTUALLY running R code in the user's live session — not by offering advice.

Capabilities:
- Run code: put executable code between <r_code> and </r_code>. Each block runs in the same stateful R session; state persists (variables created earlier are available to later code).
- Target a specific code block: the user's code window holds numbered cells (code1-1, code2-3; scratch window uses scratch-1). You can state which cell to write/run into, and the program places and truly runs your code there.
- Inspect a value: to view the actual content of a variable/expression (e.g. df, summary(x), model coefficients), put the expression between <r_inspect> and </r_inspect>. Read-only; never changes state.

Rules:
1. The opening block provides a "current environment snapshot" and "recent run results" containing the objects present. Reuse existing variables; do not recreate them. If a variable does not exist yet, create and run it with <r_code>.
2. One <r_code> tag does ONE verifiable thing (create variable, load data, stats, plot, model, test). You may <r_inspect> first, then <r_code>. Put explanations in prose outside the tags.
3. Write robust base-R code; avoid extra packages when possible. If needed, library() it first and, if unavailable, give an install.packages() hint. For bioinformatics, reasonable use of Bioconductor/R packages is fine.
4. For statistical tests, state the applicability conditions and the clinical meaning of the result.
5. Run code and answer from real results; never invent data or describe objects that don't exist.
6. Reply in English.`;
  }
  return `你是 AideR 的 R 数据分析助手，专长是医学与生信数据分析。你通过真正在用户的 R 会话里运行代码来完成任务，而不是只给建议。

能力：
- 运行代码：把可执行代码放在 <r_code> 与 </r_code> 标签内。每段代码在同一个、有状态的 R 会话中执行，会话状态保留（之前创建的变量，之后代码可直接使用）。
- 针对单个代码块操作：用户的代码窗里有很多编号的代码块（如 code1-1、code2-3，临时窗用 scratch-1）。你可以在任务中指定要写入/运行哪个代码块，程序会把你的代码落到对应代码块并真实运行。
- 读取变量内容：想查看某个变量/表达式的实际内容（例如 df、summary(x)、模型系数）时，把表达式放在 <r_inspect> 与 </r_inspect> 标签内。只读、不改状态。

规则：
1. 开场会给你的「当前环境快照」和「近期运行结果」中，已包含环境中已存在的对象。引用已有变量，不要重复创建；若某变量还没建，用 <r_code> 去建并运行。
2. 一个 <r_code> 标签内做一件可验证的事（建变量、读数据、统计、画图、建模、检验）；可以先 <r_inspect> 探查，再 <r_code> 执行。解释与结论写在标签外的正文里。
3. 代码健壮、兼容 base R，尽量少装额外包；确需某包时先 library()，若不可用给出 install.packages() 提示。生信分析可合理使用 Bioconductor/R 相关包。
4. 涉及统计检验，说明适用条件与结果的医学/临床含义。
5. 能运行的尽量运行、用真实结果说话；不要凭空编造数据或凭空描述不存在的对象。
6. 全程用中文交流。`;
}

// System prompt comes from server/prompt/system_<lang>.md so the user can edit it.
// Missing/unreadable file -> built-in default. Loaded once per language (edit then restart).
function systemPrompt(lang) {
  const key = lang === 'en' ? 'en' : 'zh';
  if (key in _promptCache) return _promptCache[key];
  try {
    const f = path.join(PROMPT_DIR, `system_${key}.md`);
    const txt = fs.readFileSync(f, 'utf8').trim();
    if (txt) { _promptCache[key] = txt; return txt; }
  } catch (e) { /* fall back */ }
  _promptCache[key] = _defaultPrompt(lang);
  return _promptCache[key];
}
const SYSTEM_PROMPT = systemPrompt(); // default zh (kept for external importers)

const MAX_STEPS = 20;
const INSPECT_MAXLEN = 4000; // cap how much of a variable we feed to the LLM

/**
 * Authorize a single code segment before running it.
 * Registers a resolver in `approval.awaiters[token]`; the socket layer calls
 * `agentLoop.approve(approval, token, allowed)` to continue. Emits a
 * `approval_needed` event via emitPending so the UI can ask the user.
 * Returns true to run, false to skip. 2-min timeout fallback -> deny.
 */
function waitApproval(approval, code, emitPending) {
  const token = 'ap-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      approval.awaiters.delete(token);
      resolve(false);
    }, 2 * 60 * 1000);
    approval.awaiters = approval.awaiters || new Map();
    approval.awaiters.set(token, (allowed) => {
      clearTimeout(timer);
      resolve(!!allowed);
    });
    try { emitPending(token); } catch (e) {}
  });
}

/** Socket layer calls this to grant/deny a pending approval by token. */
function approve(approval, token, allowed) {
  if (!approval || !approval.awaiters) return false;
  const fn = approval.awaiters.get(token);
  if (fn) { fn(allowed); approval.awaiters.delete(token); return true; }
  return false;
}

/**
 * Split LLM text into ordered segments. Supports two tags:
 *   <r_code>…</r_code>    → { kind: 'code', content }
 *   <r_inspect>…</r_inspect> → { kind: 'inspect', content }
 * Plain text between tags becomes { kind: 'text', content }.
 */
function splitSegments(text) {
  const segs = [];
  const re = /<r_(code|inspect)>([\s\S]*?)<\/r_(?:code|inspect)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      const t = text.slice(last, m.index).trim();
      if (t) segs.push({ kind: 'text', content: t });
    }
    const kind = m[1] === 'code' ? 'code' : 'inspect';
    const content = m[2].trim();
    if (content) segs.push({ kind, content });
    last = m.index + m[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail) segs.push({ kind: 'text', content: tail });
  return segs;
}

/** Build the variable snapshot block fed back to the LLM. */
function variablesBlock(variables, lang) {
  const empty = lang === 'en'
    ? '(no user variables to read right now)'
    : '（当前暂无可读取的自定义变量）';
  if (!variables || !variables.length) return empty;
  const dimLbl = lang === 'en' ? 'dims' : '尺寸';
  const lines = variables.map((v) => {
    const head = (v.head || '').replace(/\n/g, ' | ').slice(0, 180);
    return `- ${v.name}  [${v.class}]  ${v.dim ? dimLbl + ' ' + v.dim : ''} ${v.size || ''}${
      head ? '\n    ↳ ' + head : ''}`;
  });
  return lines.join('\n');
}

/** Render recent run history as a compact text block for the LLM. */
function historyBlock(history, limit = 6, lang) {
  const empty = lang === 'en' ? '(no recent run records)' : '（暂无最近的运行记录）';
  if (!history.length) return empty;
  const tagInspect = lang === 'en' ? 'inspect' : '读取';
  const tagExec = lang === 'en' ? 'exec' : '执行';
  const stOk = lang === 'en' ? 'ok' : '成功';
  const stFail = lang === 'en' ? 'fail' : '失败';
  return history.slice(-limit).map((h) => {
    const code = String(h.code || '').replace(/\n/g, ' ').slice(0, 120);
    const out = String(h.output || '').replace(/\n/g, ' | ').slice(0, 160);
    const tag = h.type === 'inspect' ? tagInspect : tagExec;
    const state = h.ok === false ? stFail : stOk;
    return `> [${tag}·${state}] ${code}\n>   ↳ ${out || '(no output)'}`;
  }).join('\n');
}

/**
 * Run a read-only inspection of an R expression in the shared session.
 * NEVER mutates environment state; only prints and returns captured output.
 */
async function inspectInSession(session, expr) {
  const safeExpr = String(expr).trim();
  if (!safeExpr) return { ok: false, error: '空的读取表达式' };
  // Read-only helper: str() + head() for a human-readable, size-capped look.
  // Uses tryCatch so an error (e.g. undefined variable) returns cleanly instead
  // of killing the session. The helper names start with "." so they never show
  // in the variables window. The result is returned via the session's own
  // captured-output harness by assigning then printing.
  const script = `
.inspect_one <- function(expr) {
  obj <- tryCatch(eval(parse(text = expr), envir = .GlobalEnv), error = function(e) e)
  if (inherits(obj, "error")) return(list(ok = FALSE, error = conditionMessage(obj)))
  txt <- tryCatch({
      s1 <- paste(capture.output(str(obj)), collapse = "\\n")
      s2 <- paste(capture.output(utils::head(obj)), collapse = "\\n")
      paste0(s1, "\\n\\n--- 前若干行 / 预览 ---\\n", s2)
    }, error = function(e) paste(capture.output(print(obj)), collapse = "\\n"))
  list(ok = TRUE, txt = substr(txt, 1, ${INSPECT_MAXLEN}))
}
cat("<<<INSPECT_START>>>\\n")
r <- .inspect_one(${JSON.stringify(safeExpr)})
cat(if (r$ok) r$txt else paste0("ERROR: ", r$error), "\\n")
cat("<<<INSPECT_END>>>\\n")`;
  try {
    const res = await session.submit(script);
    const out = (res.output || '')
      .replace(/<<<INSPECT_START>>>\s*/, '')
      .replace(/<<<INSPECT_END>>>\s*$/, '').trim();
    const errMatch = /^ERROR:\s*(.*)$/m.exec(out);
    if (errMatch) return { ok: false, error: errMatch[1] };
    return { ok: true, content: out || '(无内容)' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Run the AI→R loop.
 * @param {object} ctx {ai, settings, session, history}
 * @param {string|Array} userInput initial user prompt (string) OR message history
 * @param {object} opts {onEvent, signal}
 */
async function run(ctx, userInput, opts = {}) {
  const { ai, settings } = ctx;
  const session = ctx.session;
  const history = ctx.history || (ctx.history = []); // shared across chats
  const onEvent = opts.onEvent || (() => {});
  const messages = Array.isArray(userInput)
    ? userInput.slice()
    : [{ role: 'user', content: String(userInput) }];

  // ensure a system prompt is present
  if (!messages.find((m) => m.role === 'system')) {
    messages.unshift({ role: 'system', content: systemPrompt(opts.lang) });
  }

  // FEATURE 1: inject current environment + recent runtime history at the OPEN,
  // so the AI immediately "sees" variables and results (incl. manual runs).
  const isEn = opts.lang === 'en';
  const snapLbl = isEn ? '--- Current R environment snapshot ---' : '--- 当前 R 环境变量快照 ---';
  const histLbl = isEn ? '--- Recent run results (manual + AI) ---' : '--- 近期运行结果（含手动与 AI 执行的输出） ---';
  let openingBlock =
    `${snapLbl}\n${variablesBlock(session.lastVariables || [], opts.lang)}` +
    `\n\n${histLbl}\n${historyBlock(history, 6, opts.lang)}`;
  // FEATURE 2: include the notebooks' code cells so the AI can reference "第N块" / its tab
  if (Array.isArray(opts.cells) && opts.cells.length) {
    const cellText = opts.cells.map((c, i) => {
      const badge = c.status === 'error' ? (isEn ? ' ⚠(error)' : ' ⚠(出错)') : (c.status === 'running' ? ' ⏳' : '');
      // label each cell with its unique id (code-<window>-<block>) so the AI can target a block exactly
      const id = (c.cid && String(c.cid).trim()) ? c.cid : `code-${(c.window && String(c.window).trim()) || '?'}-${i + 1}`;
      let s = `\n[${id}]${badge}\n${c.code || '(empty)'}`;
      if (c.output) s += `\n  ↳ ${isEn ? 'output: ' : '输出: '}${String(c.output).replace(/\n/g, ' | ').slice(0, 200)}`;
      if (c.error) s += `\n  ↳ ${isEn ? 'error: ' : '错误: '}${String(c.error).replace(/\n/g, ' | ').slice(0, 200)}`;
      return s;
    }).join('\n');
    if (isEn) {
      openingBlock += `\n\n--- Current code blocks in the code windows (user-edited) ---\n${cellText}\n\nA "[id]" like [code1-1] means "Code window 1, block 1" (code<window>-<block>; scratch window uses scratch-1). To target a block, cite its id, e.g. code1-2. When you change a block, give the full rewritten code and name the id.`;
    } else {
      openingBlock += `\n\n--- 当前各代码窗口的代码块（用户手动编辑） ---\n${cellText}\n\n"[编号]"如 [code1-1] 即"代码1 的第1块"（code<窗口>-<块序>；临时窗用 scratch-1）。引用某块时就写它的编号，如 code1-2。要修改某块时，给出改写后的完整代码并说明是哪个编号。`;
    }
  }
  // FEATURE 3: honor the user's requested output language ('zh'|'en')
  if (opts.lang === 'en') {
    openingBlock += `\n\n[Language] Please reply in English and write any code comments or explanations in English.`;
  } else {
    openingBlock += `\n\n[Language] 请用中文回复，代码注释与解释也都用中文。`;
  }
  // FEATURE 4: optional Skill — a reusable analysis playbook injected as guidance
  if (opts.skill) {
    openingBlock += `\n\n[Skill: ${opts.skill.name}]\n${opts.skill.prompt}`;
  } else if (Array.isArray(opts.skillList) && opts.skillList.length) {
    // user didn't pin a skill: offer the available ones so the AI picks the best fit itself
    const listTxt = opts.skillList.map((s) => `- ${s.name}: ${s.label}`).join('\n');
    openingBlock += `\n\n[Available skills — pick the most suitable one for the task and follow it]\n${listTxt}\n(You may select one and state at the start which skill you are applying; if none fit, just proceed normally.)`;
  }
  // FEATURE 5: cross-session Memory for this project (facts/preferences worth remembering)
  if (opts.memory && String(opts.memory).trim()) {
    const mLbl = isEn ? 'Remembered notes for this project (from previous sessions):' : '本工程的记忆笔记（来自之前的会话）：';
    openingBlock += `\n\n[Memory]\n${mLbl}\n${String(opts.memory).trim()}\n(If you conclude something important the user will want later, write it inside <r_memory>…</r_memory>.)`;
  }
  // FEATURE 6: optional Plan — first produce a step list, then execute against it
  const planSteps = [];
  const memNotes = []; // memory notes the model wants persisted
  if (opts.plan) {
    const planLbl = isEn
      ? 'Before doing anything, output a short step-by-step plan inside <r_plan>…</r_plan> (one step per line, numbered). Then work through the steps; each turn say which step you are on.'
      : '动手前请先在一个 <r_plan>…</r_plan> 标签里给出分步计划（每行一步、编号）。然后按步骤执行，每一轮说明你进行到第几步。';
    openingBlock += `\n\n[Plan requested]\n${planLbl}`;
  }
  const sysIdx = messages.findIndex((m) => m.role === 'system');
  messages.splice(sysIdx + 1, 0, { role: 'user', content: openingBlock });

  for (let step = 0; step < MAX_STEPS; step++) {
    // if a plan was requested, remind the model of remaining steps each round
    if (planSteps.length) {
      const remaining = planSteps.map((s) => (s.done ? `[x] ${s.text}` : `[ ] ${s.text}`)).join('\n');
      messages.push({ role: 'user', content: `(Progress so far)\nCurrent step index: ${step}\n${remaining}` });
    }
    onEvent({ type: 'thinking', step });
    let full;
    try {
      full = await ai.chat(settings, messages, {
        onDelta: (d) => onEvent({ type: 'assistant_delta', delta: d }),
        signal: opts.signal,
      });
    } catch (e) {
      onEvent({ type: 'error', message: e.message });
      return { status: 'error', message: e.message, step };
    }
    const content = full.content;
    messages.push({ role: 'assistant', content });

    const segments = splitSegments(content);
    onEvent({ type: 'segments', segments, fullContent: content });

    // collect a memory note the model wants persisted (cross-session)
    const memMatch = content.match(/<r_memory>([\s\S]*?)<\/r_memory>/i);
    if (memMatch && String(memMatch[1]).trim()) {
      const note = String(memMatch[1]).trim();
      onEvent({ type: 'memory', content: note });
      if (!memNotes.includes(note)) memNotes.push(note);
    }
    // parse a step-by-step plan if requested
    if (opts.plan) {
      const planMatch = content.match(/<r_plan>([\s\S]*?)<\/r_plan>/i);
      if (planMatch) {
        const lines = String(planMatch[1]).split('\n').map((l) => l.trim()).filter((l) => /^\s*\d+[.)\s-]/.test(l) || /^[-*]\s/.test(l));
        planSteps.length = 0;
        lines.forEach((t) => planSteps.push({ text: t.replace(/^\s*\d+[.)\s-]\s*/, '').replace(/^[-*]\s*/, ''), done: false }));
        onEvent({ type: 'plan', steps: planSteps.map((s) => s.text) });
      }
    }

    // Exit if the model produced no actionable tags.
    const actions = segments.filter((s) => s.kind === 'code' || s.kind === 'inspect');
    if (!actions.length) {
      onEvent({ type: 'done', segments, step, fullContent: content });
      return { status: 'done', segments, step, fullContent: content, memNotes };
    }

    // Execute actions in order, in the SAME session.
    let toolResultParts = [];
    let sawInspect = false;
    for (const seg of actions) {
      if (seg.kind === 'code') {
        onEvent({ type: 'r_code_start', code: seg.content });
        // OPTIONAL approval gate: wait for the user to authorize this step.
        if (opts.approval && opts.approval.enabled) {
          const allowed = await waitApproval(opts.approval, seg.content, (tok) =>
            onEvent({ type: 'approval_needed', token: tok, code: seg.content }));
          if (!allowed) { // denied/skipped -> do not run this segment
            onEvent({ type: 'r_skipped', code: seg.content });
            toolResultParts.push(`--- 用户跳过（未授权） ---\n${seg.content}`);
            continue;
          }
        }
        let res;
        try {
          res = await session.submit(seg.content);
        } catch (e) {
          res = { ok: false, error: e.message, output: '', variables: session.lastVariables || [] };
        }
        onEvent({
          type: 'r_exec_result',
          code: seg.content,
          ok: res.ok,
          error: res.error,
          output: res.output,
          plot: res.plot || null,
        });
        // record into cross-chat history
        if (history.length > 30) history.shift();
        history.push({ type: 'code', code: seg.content, output: res.output, ok: res.ok, source: 'model' });
        // execution may change workspace -> broadcast updated snapshot
        onEvent({ type: 'variables', variables: res.variables || session.lastVariables || [] });
        toolResultParts.push(
          `--- 执行 R 代码 ---\n${seg.content}\n--- 输出 ---\n${res.output || '(无输出)'}\n${
            res.error ? `--- 错误 ---\n${res.error}` : ''}`
        );
      } else {
        // inspect: read-only, safe, size-capped
        sawInspect = true;
        onEvent({ type: 'inspect_start', expr: seg.content });
        const insp = await inspectInSession(session, seg.content);
        onEvent({
          type: 'inspect_result',
          expr: seg.content,
          ok: insp.ok,
          error: insp.error || null,
          content: insp.content,
        });
        if (history.length > 30) history.shift();
        history.push({ type: 'inspect', code: seg.content, output: insp.content, ok: insp.ok, source: 'model' });
        toolResultParts.push(
          `--- 读取变量/表达式内容 ---\n${seg.content}\n--- 内容 ---\n${insp.content}${
            insp.error ? `\n--- 错误 ---\n${insp.error}` : ''}`
        );
      }
    }

    // feed back: toolResult describing actions + resulting snapshot
    messages.push({
      role: 'toolResult',
      toolCallId: `r-step-${step}`,
      content:
        toolResultParts.join('\n') +
        `\n\n--- 当前变量快照 ---\n${variablesBlock(session.lastVariables || [])}`,
    });
  }

  onEvent({ type: 'max_steps', message: `已达最大步骤数 ${MAX_STEPS}，请简化目标。` });
  return { status: 'max_steps', memNotes };
}

const REWRITE_PROMPT = `你是 R 命令行分析助手。用户给出一段 R 代码，请你改写或续写。

严格按此格式回复：
第一步，用普通文字（不要放在代码里）简要说明你的修改思路和使用方法，用中文；
第二步，在 <r_code> 与 </r_code> 标签内给出完整的、可运行的改写后代码。

要求：
- 普通文字说明必须写在 <r_code> 标签之外，且要有实质内容（改了哪里、为什么），不要为空。
- <r_code> 内是纯代码，不加 markdown 围栏（如 \`\`\`r），代码注释保持精简。
- 若用户要"改写"，返回改写后整段代码；若要"续写"，在已有代码后继续补充。
- 不改动用户未要求部分的功能。`;

/**
 * Rewrite a given chunk of R code via the AI, returning ONLY the rewritten
 * text. Unlike run(), this does NOT touch the R session — it edits script text.
 * @param {object} ctx {ai, settings}
 * @param {object} opts {code, instruction, onDelta, signal}
 */
async function rewrite(ctx, opts = {}) {
  const { ai, settings } = ctx;
  const onDelta = opts.onDelta || (() => {});
  const messages = [
    { role: 'system', content: REWRITE_PROMPT },
    {
      role: 'user',
      content:
        `需要改写的 R 代码：\n<r_code>\n${opts.code}\n</r_code>\n` +
        `改写要求：${opts.instruction || '请优化这段代码，保持功能一致'}`,
    },
  ];
  let full;
  try {
    full = await ai.chat(settings, messages, { onDelta, signal: opts.signal });
  } catch (e) {
    return { ok: false, error: e.message, content: '' };
  }
  // extract first <r_code> block; fall back to whole text if none tagged
  const m = /<r_code>([\s\S]*?)<\/r_code>/s.exec(full.content);
  const content = m ? m[1].trim() : full.content.trim();
  // explanation = the model's prose outside <r_code> (its reasoning / notes)
  const explanation = full.content.replace(/<r_code>[\s\S]*?<\/r_code>/g, '').trim();
  if (!content) return { ok: false, error: 'AI 未返回改写代码', content: '' };
  return { ok: true, content, explanation, fullContent: full.content };
}

const SPLIT_PROMPT = `你是 R 代码整理助手。用户会给出一段完整的 R 脚本。请把它按逻辑拆成多个**较小的代码块**（每个逻辑步骤一个块，例如：载入包→读数据→数据清洗→描述性统计→检验→画图→建模→看结果。若某步骤较长，再进一步拆分，让每块尽量小而独立）。

要求：
- 逐块放入各自的 <r_code> 与 </r_code> 标签。
- **块要小**：宁可多分几块，不要合并成大块。每块只做一件完整的小事，方便每个块单独运行。
- 除了把代码块用 <r_code> 包裹外，**不要改动任何代码内容**（不改、不删、不加注释、不改格式）。
- 不要补充 <r_code> 之外的说明。`;

/**
 * Ask the AI to split a chunk of R code into several code blocks, WITHOUT
 * altering the code content. Returns { blocks: string[] }.
 */
async function splitCode(ctx, code, opts = {}) {
  const { ai, settings } = ctx;
  const onDelta = opts.onDelta || (() => {});
  const messages = [
    { role: 'system', content: SPLIT_PROMPT },
    { role: 'user', content: `请拆分这段 R 代码（不改内容，只分块）：\n\n${code}` },
  ];
  let full;
  try {
    full = await ai.complete(settings, messages, { signal: opts.signal });
  } catch (e) {
    return { ok: false, error: e.message, blocks: [] };
  }
  // collect all <r_code> blocks in order
  const blocks = [];
  const re = /<r_code>([\s\S]*?)<\/r_code>/g;
  let m;
  while ((m = re.exec(String(full || ''))) !== null) {
    const t = m[1].trim();
    if (t) blocks.push(t);
  }
  if (!blocks.length) return { ok: false, error: 'AI 未返回代码块', blocks: [] };
  return { ok: true, blocks };
}


module.exports = { run, rewrite, splitCode, approve, splitSegments, inspectInSession, SYSTEM_PROMPT, REWRITE_PROMPT, variablesBlock, historyBlock };
