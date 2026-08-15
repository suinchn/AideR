# AideR — AI that actually runs your R

> 一个**本地运行**的 R 数据分析工作台。它的 AI **不只是给建议，而是真的在你的 R 会话里写代码、运行、看结果，再继续**——逐块执行，看得见、摸得着。

![AideR 示例输出](age_distribution.png)

## 它和别的 AI 工具有什么不同

大多数"帮写 R 的 AI"只会在对话框里**建议代码**，你还得复制、粘贴、自己跑。AideR 跨过了这一步：

- 🔁 **AI 真的运行你的 R。** AI 写的每段代码都被送进你的常驻 R 会话执行，产生输出/图形后，结果再回喂给 AI。
- 🧱 **AI 逐块操作你的代码。** 代码窗里有编号的代码块（`code1-1`、`code2-3`，临时窗用 `scratch-1`）。你说"写到 code2-3 并运行"，它就真的落到那个块、在那里运行、结果显示在块下方。
- 🪞 **共享你的环境。** 因为用的是你同一个 R 会话，AI 看得见你的变量、你之前跑过什么，并在此基础上继续——不是空对空。
- 🪢 **先探查再动手。** 不确定时，它会先 `<r_inspect>` 只读地看一眼变量，再写下一步代码。

一句话：**你面对的不是一个"代码评审员"，而是一个会动手替你分析的助手，一步步做给你看。**

## ✨ 亮点

- **常驻共享 R 会话** —— 多个代码块之间变量/结果/图互相衔接，像 Jupyter 之于 R。
- **多步 agent 循环** ——"想 → 运行 → 观察 → 继续"（最多 20 步），可选 **Plan** 先列步骤再逐步执行。
- **能定位任意代码块** —— 你说 `codeN-M` / `scratch-N`，AI 就写进那一块并就地运行。
- **跨会话记忆** —— AI 会把值得记的结论写进工程文件夹的 `memory.md`，下次打开同一工程自动想起。
- **文件化技能** —— 一个技能一个文件夹（`skills/<名字>/skill.md`）；你没指定时，AI 自己挑最合适的。
- **智能编辑** —— R 语法高亮、自动补全（常用 R 函数 + 你当前的变量）、一键运行"当前块 / 光标处表达式"（能识别跨行的函数调用与 `+`、`%>%` 续行）。
- **中 / 英双语** —— 界面语言与 AI 输出语言**分别切换**。
- **隐私优先** —— 默认连本地 Ollama，数据不出机；也可接任意 OpenAI 兼容或云端服务。
- **零门槛安装** —— 装好 Node 和 R，`npm start` 即用；Windows 还带一键脚本。

## 🖥 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Vue 3 · Vite · CodeMirror 6 · Socket.IO |
| 后端 | Fastify · Socket.IO |
| R 引擎 | Node 常驻 Rscript 子进程 + base64 帧协议 |
| AI | OpenAI 兼容通道（Ollama / LM Studio / OpenAI / Groq / OpenRouter / 自定义）+ Anthropic |

## 📦 安装

### 需要
- **Node.js** ≥ 18（LTS）
- **R** ≥ 4.0（加入 PATH，或到设置填 Rscript 路径）
- （可选，要用 AI 才装）**Ollama** — https://ollama.com/download

### 步骤
```bash
git clone <你的仓库地址>
cd AideR
npm install
npm start        # 构建前端并启动 → http://127.0.0.1:8787
```
- 开发模式：`npm run dev`
- Windows：先双击 `FirstInstall.bat`（装依赖+构建），之后用 `LaunchAssistant.bat`。

## 🚀 快速上手
1. 左边写 R 代码块，点 ▶ 运行——变量/结果在共享会话里保留。
2. 右下对 AI 提需求（例：*"读取数据，做个汇总，并按分组画箱线图"*）。
3. AI 自己拆块、运行、看图、给结论。
4. 点「New Project」选个文件夹当工程，保存/记忆/技能都在那。

## ⚙️ 配置（`settings.json` / 界面「设置」）
`ai.provider`（`ollama` 默认 / `custom` / `openai` / `groq` / `openrouter` / `anthropic` / `off`）、`ai.baseUrl`、`ai.apiKey`、`ai.model`、`rscript`（Rscript 路径）。

## 🧠 AI 是怎么"真的运行"你的 R 的
- 输出 `<r_code>…</r_code>` → 在共享会话执行 → 结果/图回馈。
- 用 `<r_inspect>…</r_inspect>` 探查变量（只读）。
- 可写入指定块 `codeN-M` / `scratch-N` 并运行。
- 用 `<r_memory>…</r_memory>` 把笔记写进 `memory.md`。
- 开启 **Plan** 时先给 `<r_plan>` 步骤清单，再逐步执行。

## 🗂 目录结构
```
client/           Vue 前端
server/           Fastify + Socket.IO 后端
  r-engine.js    常驻 R 会话引擎
  agent-loop.js  AI 多步 agent
  ai/            provider 适配
  prompt/        可编辑的系统提示词（md）
skills/          AI 技能模板（一个技能一个文件夹）
scripts/         自测脚本（npm test）
```

## 🧰 技能：全局的 vs 工程内的
技能其实就是**给 AI 读的文本文件夹**，分**两层**，会合并：

- **全局技能**：放在项目自带的 `skills/` 目录 → 对**所有工程**可用。
- **工程内技能**：放在**某个工程文件夹里**的 `skills/` 目录 → 只对该工程可用。新建工程时会自动创建这个 `skills/` 目录。

同名时**工程内技能覆盖全局**。结构是一个技能一个文件夹：
```
skills/<技能名>/skill.md
```
`skill.md`：**第一行**是显示名（如 `# 描述性统计`），**其余**就是你想让 AI 遵循的分析流程：
- **添加**：新建一个 `skills/<名字>/skill.md`（放在项目自带 `skills/` 或某个工程的 `skills/`）。
- **删除**：删掉这个技能文件夹。
- 刷新后，AI 窗口的「Skill」下拉会自动出现/消失。

## 🧪 测试
```
npm test          # 自测
npm run test:env  # 检查 R / AI 环境
```

## ❓ 常见问题
- **R 未就绪** → 装 R 或在设置填 Rscript 路径。
- **AI 提示"需要 API Key"** → 用本地 Ollama，或填对应 Key。
- **AI "fetch failed"** → Ollama 没启动/URL 错；先 `ollama serve`。
- **浏览器选文件夹拿不到磁盘绝对路径** → Windows 安全限制；可在「完整路径」字段手动填。

## 📄 许可
MIT。供个人或机构科研使用。

---
*浏览器的标签页标题、顶栏名称在 `client/index.html` 与 `client/src/i18n/strings.js` 的 `brand` 处可改。*
