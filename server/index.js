'use strict';
/**
 * server/index.js — Fastify + Socket.IO backend.
 *
 * Responsibilities:
 *   - Host one persistent, stateful R session (r-engine.js).
 *   - Expose Socket.IO events for the web client:
 *       client→server:  execute   {id, code}
 *                       chat      {id, text}          (AI→R agent loop)
 *                       get_state {}
 *                       save_settings {settings}
 *       server→client:  exec_result {id, ok, error, output, variables}
 *                       variables  {variables}
 *                       ai:{thinking|assistant_delta|segments|r_code_start|
 *                            r_exec_result|done|error|variables|max_steps}
 *                       state {ready, rscript, rError, ai:{available}}
 *                       settings {settings}
 *   - FATSHIVE static serving of the built client + a tiny REST health/`/api`.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { exec } = require('child_process');

const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');
const { Server } = require('socket.io');

const { RSession } = require('./r-engine');
const config = require('./config');
const ai = require('./ai');
const agentLoop = require('./agent-loop');

const PORT = process.env.PORT || 8787;
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

async function main() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'warn' } });

  // static client (built)
  try {
    if (fs.existsSync(CLIENT_DIST)) {
      await app.register(fastifyStatic, { root: CLIENT_DIST, prefix: '/' });
    }
  } catch (e) {
    app.log.warn('不能注册 static，先 `npm run build`?');
  }

  // health
  app.get('/api/health', async () => ({ ok: true }));

  await app.listen({ port: PORT, host: '0.0.0.0' });
  const base = `http://127.0.0.1:${PORT}`;
  app.log.info(`服务已启动: ${base}`);

  // ---- runtime singletons ----
  const settingsStore = config.load();
  const session = new RSession({ rscript: settingsStore.rscript || undefined });
  const agentHistory = []; // shared run history (AI + manual) so the AI can read past results
  const approvalState = { enabled: false, awaiters: new Map() }; // AI code runs automatically by default (no approval popup)

  function revealFolder(target) {
    // best-effort: open the target file/folder in the OS file explorer (Windows)
    try {
      if (process.platform !== 'win32') return;
      const targetDir = fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.dirname(target);
      exec(`explorer /select,"${targetDir}"`, { windowsHide: true }, () => {});
    } catch (e) { /* non-critical */ }
  }

  // warm the session in background (don't block startup; report via socket)
  let rReady = false;
  let rError = null;
  session.ensureStarted()
    .then(() => { rReady = true; })
    .catch((e) => { rError = e.message; });

  const io = new Server(app.server, { cors: { origin: true, credentials: true } });

  io.on('connection', (socket) => {
    app.log.info('client connected');

    const emitVariables = (variables) => socket.emit('variables', { variables });
    // initial state push
    const pushState = () => {
      socket.emit('state', {
        ready: rReady,
        rscript: session.rscriptPath,
        rError,
        ai: ai.available(settingsStore),
        settings: config.publicView(),
      });
    };
    pushState();
    // re-push once R warm-up settles so the top bar shows accurate status
    session.ensureStarted()
      .then(() => { rReady = true; rError = null; pushState(); })
      .catch((e) => { rError = e.message; pushState(); });
    // restore the current R workspace variables on (re)connect, so a browser
    // refresh doesn't blank the variables window
    const emitVars = () => {
      if (session.lastVariables && session.lastVariables.length) {
        socket.emit('variables', { variables: session.lastVariables });
      }
    };
    emitVars();
    session.ensureStarted().then(emitVars).catch(() => {});

    socket.on('execute', async (payload = {}) => {
      const id = payload.id;
      const wrap = (extra) => socket.emit('exec_result', { id, ...extra });
      try {
        const res = await session.submit(String(payload.code ?? ''));
        wrap({ ok: res.ok, error: res.error, output: res.output, plot: res.plot || null, variables: res.variables });
        if (res.variables) emitVariables(res.variables);
        // record manual run into the shared history so the AI can see it later
        if (agentHistory.length > 60) agentHistory.shift();
        agentHistory.push({
          type: 'code', code: String(payload.code ?? ''), output: res.output,
          ok: res.ok, source: 'user',
        });
      } catch (e) {
        wrap({ ok: false, error: e.message, output: '', variables: [] });
      }
    });

    // delete a variable from the shared R session
    socket.on('remove_var', async (payload = {}) => {
      const name = String(payload.name || '').trim();
      if (!/^[A-Za-z][A-Za-z0-9._]*$/.test(name) || name.startsWith('.')) {
        socket.emit('notice', { kind: 'error', message: `非法的变量名: "${name}"` });
        return;
      }
      try {
        const res = await session.submit(`rm(${JSON.stringify(name)})`);
        if (res.ok === false && res.error) {
          socket.emit('notice', { kind: 'error', message: `删除失败: ${res.error.split('\n')[0]}` });
        } else {
          socket.emit('variables', { variables: res.variables || session.lastVariables || [] });
          socket.emit('notice', { kind: 'info', message: `已删除变量 "${name}"` });
        }
      } catch (e) {
        socket.emit('notice', { kind: 'error', message: `删除失败: ${e.message}` });
      }
    });

    // clear all user variables from the shared R session
    socket.on('clear_vars', async () => {
      try {
        const res = await session.submit('rm(list = ls(.GlobalEnv, all.names = FALSE), envir = .GlobalEnv)');
        if (res.ok === false && res.error) {
          socket.emit('notice', { kind: 'error', message: `清除失败: ${res.error.split('\n')[0]}` });
        } else {
          socket.emit('variables', { variables: res.variables || [] });
          socket.emit('notice', { kind: 'info', message: '已清除全部变量。' });
        }
      } catch (e) {
        socket.emit('notice', { kind: 'error', message: `清除失败: ${e.message}` });
      }
    });

    // AI→R agent loop (streams events back out)
    socket.on('chat', async (payload = {}) => {
      const id = payload.id;
      const emit = (ev) => socket.emit('ai', { id, ...ev });
      const onEvent = (ev) => emit(ev);

      const avail = ai.available(settingsStore);
      if (!avail.ok) {
        emit({ type: 'error', message: avail.reason });
        return;
      }
      try {
        const result = await agentLoop.run(
          { ai, settings: settingsStore, session, history: agentHistory },
          payload.text,
          { onEvent, approval: approvalState, cells: payload.cells, lang: payload.lang,
            memory: payload.memory, plan: payload.plan === true, skill: payload.skill,
            skillList: payload.skillList }
        );
        if (result.status === 'done') emit({ type: 'done', step: result.step });
      } catch (e) {
        emit({ type: 'error', message: e.message });
      }
    });

    // user authorizes / skips a pending AI code segment
    socket.on('approve_code', (payload = {}) => {
      const token = String(payload.token || '').trim();
      const allowed = payload.allowed !== false;
      if (!token) return;
      const ok = agentLoop.approve(approvalState, token, allowed);
      if (!ok) socket.emit('notice', { kind: 'warn', message: '没有待授权的代码段（可能已超时）。' });
    });

    // toggle the "require authorization" mode (persisted per session)
    socket.on('set_approval_mode', (payload = {}) => {
      approvalState.enabled = payload.enabled !== false;
      socket.emit('approval_mode', { enabled: approvalState.enabled });
    });

    // AI rewrites / edits code in the script window (returns text, no R exec)
    socket.on('ai_edit', async (payload = {}) => {
      const id = payload.id;
      const avail = ai.available(settingsStore);
      const r = (type, extra) => socket.emit('ai_edit_result', { id, type, ...extra });
      if (!avail.ok) { r('error', { message: avail.reason }); return; }
      try {
        const res = await agentLoop.rewrite(
          { ai, settings: settingsStore },
          {
            code: String(payload.code || ''),
            instruction: String(payload.instruction || ''),
            onDelta: (d) => r('delta', { delta: d }),
          }
        );
        r('done', { ok: res.ok, content: res.content, explanation: res.explanation, error: res.error });
      } catch (e) {
        r('error', { message: e.message });
      }
    });

    socket.on('get_state', () => pushState());

    // ---- project persistence ----
    // save R workspace snapshot (.RData) to the given path
    socket.on('save_image', async (payload = {}) => {
      const p = String(payload.path || '').trim();
      if (!p) { socket.emit('notice', { kind: 'error', message: '保存路径为空' }); return; }
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const res = await session.submit(`save.image(file = ${JSON.stringify(p)})`);
        socket.emit('notice', { kind: res.ok ? 'info' : 'error', message: res.ok ? `已保存 R 环境：${p}` : `保存 R 失败: ${res.error}` });
        socket.emit('save_image_result', { ok: res.ok, error: res.error, path: p });
      } catch (e) {
        socket.emit('save_image_result', { ok: false, error: e.message, path: p });
      }
    });
    // restore R workspace snapshot
    socket.on('load_image', async (payload = {}) => {
      const p = String(payload.path || '').trim();
      if (!p) { socket.emit('notice', { kind: 'error', message: '载入路径为空' }); return; }
      try {
        const res = await session.submit(`if (file.exists(${JSON.stringify(p)})) load(${JSON.stringify(p)}, envir = .GlobalEnv) else cat("文件不存在")`);
        socket.emit('save_image_result', { ok: res.ok, error: res.error, path: p, load: true });
        socket.emit('variables', { variables: res.variables || session.lastVariables || [] });
        if (res.ok && !res.error) socket.emit('notice', { kind: 'info', message: `已恢复 R 环境：${p}` });
      } catch (e) {
        socket.emit('save_image_result', { ok: false, error: e.message, path: p });
      }
    });
    // write a text file to an explicit path (project.json etc.)
    // save R workspace to a temp file and return it as base64 (for browser save dialog)
    socket.on('save_image_b64', async () => {
      try {
        const tmp = path.join(os.tmpdir(), 'ra_env_' + Date.now() + '.RData');
        const res = await session.submit(`save.image(file = ${JSON.stringify(tmp)})`);
        if (res.ok === false) { socket.emit('save_image_result', { ok: false, error: res.error, b64: null }); return; }
        const read = fs.readFileSync(tmp);
        try { fs.unlinkSync(tmp); } catch (e) {}
        socket.emit('save_image_result', { ok: true, b64: read.toString('base64') });
      } catch (e) {
        socket.emit('save_image_result', { ok: false, error: e.message, b64: null });
      }
    });
    // restore R workspace from base64 (browser opened a .RData)
    socket.on('load_image_b64', async (payload = {}) => {
      const b64 = String(payload.b64 || '');
      try {
        const tmp = path.join(os.tmpdir(), 'ra_env_in_' + Date.now() + '.RData');
        fs.writeFileSync(tmp, Buffer.from(b64, 'base64'));
        const res = await session.submit(`if (file.exists(${JSON.stringify(tmp)})) { load(${JSON.stringify(tmp)}, envir = .GlobalEnv); unlink(${JSON.stringify(tmp)}) } else cat("nofile")`);
        socket.emit('variables', { variables: res.variables || session.lastVariables || [] });
        socket.emit('save_image_result', { ok: res.ok, load: true, error: res.error });
      } catch (e) {
        socket.emit('save_image_result', { ok: false, load: true, error: e.message });
      }
    });

    // project / file persistence reload anchor (kept for doc)
    socket.on('write_file', async (payload = {}) => {
      const p = String(payload.path || '').trim();
      if (!p) { socket.emit('notice', { kind: 'error', message: '路径为空' }); return; }
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, String(payload.content ?? ''), 'utf8');
        socket.emit('notice', { kind: 'info', message: `已写入：${p}` });
        socket.emit('write_file_result', { ok: true, path: p });
      } catch (e) {
        socket.emit('write_file_result', { ok: false, error: e.message, path: p });
      }
    });
    // read a text file (project.json)
    socket.on('read_file', async (payload = {}) => {
      const p = String(payload.path || '').trim();
      if (!p) { socket.emit('read_file_result', { ok: false, error: '路径为空' }); return; }
      try {
        const data = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
        socket.emit('read_file_result', { ok: data !== null, content: data });
      } catch (e) {
        socket.emit('read_file_result', { ok: false, error: e.message });
      }
    });

    // AI splits an R script into code blocks (import, no code change)
    socket.on('split_code', async (payload = {}) => {
      const id = payload.id;
      const avail = ai.available(settingsStore);
      const r = (type, extra) => socket.emit('split_result', { id, type, ...extra });
      if (!avail.ok) { r('error', { message: avail.reason }); return; }
      try {
        const res = await agentLoop.splitCode({ ai, settings: settingsStore }, String(payload.code || ''));
        r('done', { ok: res.ok, blocks: res.blocks, error: res.error });
      } catch (e) {
        r('error', { message: e.message });
      }
    });

    socket.on('save_settings', async (payload = {}) => {
      try {
        const saved = config.save(payload && payload.settings ? payload.settings : {});
        Object.assign(settingsStore.ai, saved.ai);
        settingsStore.rscript = saved.rscript;
        settingsStore.workDir = saved.workDir;
        settingsStore.projectName = saved.projectName;
        settingsStore.projectsRoot = saved.projectsRoot;
        settingsStore.activeProject = saved.activeProject;
        // If R hasn't started yet, apply the (possibly new) Rscript path so a
        // path fix takes effect without a restart.
        if (!rReady) {
          await session.setRscript(settingsStore.rscript || undefined);
          await session.ensureStarted().then(() => {
            rReady = true; rError = null;
          }).catch((e) => { rError = e.message; });
          pushState();
        }
        socket.emit('settings', { settings: config.publicView() });
        socket.emit('notice', { kind: 'info', message: '设置已保存。' });
      } catch (e) {
        socket.emit('notice', { kind: 'error', message: `保存失败: ${e.message}` });
      }
    });

    socket.on('disconnect', () => {});

    // export a file to the backend working directory (legacy helper; the frontend now
    // writes project files directly into the user's chosen folder via the browser)
    socket.on('export_file', async (payload = {}) => {
      const dir = process.cwd();
      const fname = String(payload.filename || 'export.txt').replace(/[\\/:*?"<>|]/g, '_');
      try {
        fs.mkdirSync(dir, { recursive: true });
        const full = path.join(dir, fname);
        fs.writeFileSync(full, String(payload.content ?? ''), 'utf8');
        revealFolder(full);
        socket.emit('notice', { kind: 'info', message: `已导出：${full}` });
      } catch (e) {
        socket.emit('notice', { kind: 'error', message: `导出失败：${e.message}` });
      }
    });

    // list AI "skills" from the skills/ folder.
    // structure: a folder per skill (skills/<name>/prompt.md); flat *.md files are also accepted.
    socket.on('get_skills', () => {
      const dir = path.join(__dirname, '..', 'skills');
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { entries = [] }
      const skills = [];
      const parseSkill = (name, txt) => {
        txt = String(txt || '').replace(/\r\n/g, '\n');
        const lines = txt.split('\n');
        const labelLine = lines.find((l) => /^\s*#\s*/.test(l)) || '';
        const label = labelLine.replace(/^\s*#\s*/, '').trim() || name;
        const prompt = lines.filter((l) => l !== labelLine).join('\n').trim();
        skills.push({ name, label, prompt });
      };
      entries.forEach((en) => {
        const p = path.join(dir, en.name);
        try {
          if (en.isDirectory()) {
            // a folder per skill; file is skill.md (fall back to any .md/.txt)
            const files = fs.readdirSync(p);
            const inner = files.includes('skill.md') ? 'skill.md' : files.find((f) => /\.(md|txt)$/i.test(f));
            if (inner) parseSkill(en.name, fs.readFileSync(path.join(p, inner), 'utf8'));
          } else if (/\.(md|txt)$/i.test(en.name)) {
            parseSkill(en.name.replace(/\.(md|txt)$/i, ''), fs.readFileSync(p, 'utf8'));
          }
        } catch (e) { /* skip unreadable */ }
      });
      socket.emit('skills_result', { ok: true, skills });
    });
  });

  return { app, io, base, rReady, session };
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error('启动失败:', e);
    process.exit(1);
  });
}
