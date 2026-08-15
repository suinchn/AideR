'use strict';
/**
 * config.js — read/write user settings.
 *
 * Settings live in settings.json at project root (gitignored). Fields:
 *   {
 *     ai: {
 *       provider: 'ollama' | 'openai' | 'groq' | 'openrouter' | 'anthropic' | 'off',
 *       baseUrl:  'http://localhost:11434/v1',   // for OpenAI-compat providers
 *       apiKey:   '',                             // leave empty for local Ollama
 *       model:    'qwen2.5:7b',                   // per-provider default
 *     },
 *     rscript: 'C:/Program Files/R/R-x.x.x/bin/Rscript.exe' | ''
 *   }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_PATH = path.join(__dirname, '..', 'settings.json');

// sensible per-provider defaults
const PROVIDER_DEFAULTS = {
  ollama:     { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b',        key: false },
  custom:     { baseUrl: '', model: '', key: false },  // user-defined OpenAI-compatible API
  openai:     { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini',       key: true },
  groq:       { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', key: true },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', key: true },
  anthropic:  { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', key: true },
};

const DEFAULT_SETTINGS = {
  ai: {
    provider: 'ollama',
    baseUrl: PROVIDER_DEFAULTS.ollama.baseUrl,
    apiKey: '',
    model: PROVIDER_DEFAULTS.ollama.model,
  },
  rscript: '',
  workDir: '',   // legacy "export-to-folder" directory (no longer shown in UI; kept for compat)
  projectName: '', // optional project name for save (default 'project')
  projectsRoot: path.join(os.homedir(), 'Documents', 'R医学分析工程'), // 工程根目录（兼容字段；新流程以 activeProject 的绝对路径为准）
  activeProject: '', // 当前工程的文件夹绝对路径（R 工作目录；存完整路径）
};

function load() {
  let s = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai } };
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      s = { ...s, ...raw, ai: { ...s.ai, ...(raw.ai || {}) } };
    }
  } catch (e) {
    /* ignore malformed, fall back to defaults */
  }
  return s;
}

function save(next) {
  const merged = load();
  const out = {
    ai: { ...merged.ai, ...(next.ai || {}) },
    rscript: next.rscript !== undefined ? next.rscript : merged.rscript,
    workDir: next.workDir !== undefined ? next.workDir : merged.workDir,
    projectName: next.projectName !== undefined ? next.projectName : merged.projectName,
    projectsRoot: next.projectsRoot !== undefined ? next.projectsRoot : merged.projectsRoot,
    activeProject: next.activeProject !== undefined ? next.activeProject : merged.activeProject,
  };
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(out, null, 2), 'utf8');
  return out;
}

/** Return public (safe) view — strips nothing sensitive, local tool only. */
function publicView() {
  return load();
}

module.exports = { load, save, publicView, PROVIDER_DEFAULTS, SETTINGS_PATH };
