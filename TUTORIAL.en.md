# AideR Step-by-Step Tutorial (English)

> This tutorial walks you from opening the page to finishing a full R analysis — covering the UI, code blocks, the AI assistant, projects, skills, and memory.

## Contents
1. [The interface](#1-the-interface)
2. [First analysis in ~10 minutes](#2-first-analysis-in-10-minutes)
3. [Understanding code blocks](#3-understanding-code-blocks)
4. [Using the AI assistant](#4-using-the-ai-assistant)
5. [Projects / save / memory](#5-projects--save--memory)
6. [Skills & system prompt](#6-skills--system-prompt)
7. [Common analysis examples](#7-common-analysis-examples)
8. [Tips & troubleshooting](#8-tips--troubleshooting)

---

## 1. The interface

Open **http://127.0.0.1:8787**. The main view is two columns:

**Left (top) — Code area**
- Toolbar: `Clear code`, `Import R`, `Import ipynb`, `Save ipynb`, `Add block`, `▶ Run all`, `▶ Run current`.
- Below that are **code windows** (tabs: Code 1, Code 2, …). Each window holds **code blocks**, id'd like `code1-1`, `code1-2` (scratch window uses `scratch-1`).
- Each block: number at top-left; tool buttons at top-right: `▶` run, `＋` insert below, `↑↓` move, `🤖` ask AI to rewrite, `✕` delete. The middle is the editor (R highlighting + autocomplete). Output/plot/error appears below after running.

**Left (bottom) — Scratch**
- A free whiteboard for quick experiments (doesn’t clutter your real windows).

**Right (top) — Variables**
- Shows objects in the current R session; expand to see type/dim/content, delete or clear individually.

**Right (bottom) — AI Assistant**
- A chat box at the bottom; controls above: approval toggle, font size, `AI→中/EN`, `Plan`, `Skill`, Clear chat.

**Top bar** — brand + `New Project` / `Open` / `Save`; right: Settings, light/dark theme, interface `中/EN`. Status bar shows project name, Rscript path, AI engine.

---

## 2. First analysis in ~10 minutes

1. **Run** it (Node + R installed; `npm start`), open the URL above.
2. **New Project** (recommended): top → **New Project** → pick a folder (optionally fill the full path) → OK. The folder gets a `skills/` dir auto-created; saves, memory `memory.md`, and skills live here.
3. **Write your first block** in Code 1:
   ```r
   set.seed(1)
   age <- rnorm(30, mean = 55, sd = 10)
   summary(age)
   ```
4. **Run**: press **Ctrl+Enter** in the block (or click `▶`). Result shows below; `age` appears in Variables.
5. **Plot**: add a block `hist(age, col = "steelblue")` and run — the image shows under the block.
6. **Ask the AI** (optional): type *“give a descriptive summary of age and interpret it”* → AI writes, runs, and explains.

> Done — a full create-variable → stats → plot flow.

---

## 3. Understanding code blocks

### Three ways to run
| Action | Effect |
|---|---|
| Block **`▶`** | Run the **whole block** |
| **Ctrl+Enter** or toolbar **`▶ Run current`** | Run the **logical expression at the cursor**: selected code if any; otherwise auto-expands to the full expression (handles multi-line calls, `+` and `%>%` continuations); cursor jumps to the next expression |
| Toolbar **`▶ Run all`** | Run all blocks top-to-bottom (shared variables; pauses on error) |

- **All blocks share one R session**: variables from block A are usable in block B — that’s the notebook value.
- To have AI edit one block: click its `🤖` and describe the change; the rewrite lands back in that block (and can be run).

### Add / delete
`＋` inserts below; `✕` deletes; toolbar `Clear code` clears the whole window; `Clear all` (Variables) clears all variables.

---

## 4. Using the AI assistant

### Basic
Type a request at bottom-right and send. The AI decides what to run, then **runs it in your session block by block**, then gives a textual conclusion. Examples:
- *“Read the data and give descriptive statistics”*
- *“Test if the two groups differ (t-test if appropriate) and boxplot them”*
- *“Fit a logistic regression and give OR with 95% CI”*

### Target a specific block
Include the block id in your message — AI writes and runs it there:
- *“Write the normalization step into code2-1 and run it”*
- *“Put the PCA plot into scratch-2”*

### Plan
Tick **Plan** — AI first produces a `<r_plan>` step list, then works through it, reporting progress each turn. Good for long tasks.

### Approval
By default AI runs automatically. Turn on **Require approval** to review each block before it runs.

### AI output language
`AI→中 / AI→EN` changes only how the AI *talks*, not the UI.

### Memory
When AI decides something is worth remembering, it writes it into the project’s `memory.md`. You can also say *“remember: data cutoff 2026-06, group by <60/≥60”*.

---

## 5. Projects / save / memory

- **New Project**: choose/enter a folder as the project folder.
- **Save**: writes the current code list + R environment snapshot into the folder (`project.json` + `<name>.RData`).
- **Open**: loads the project from that folder.
- **`memory.md`**: real file in the project for AI cross-session memory; travels with the folder.
- **`skills/` inside project**: project-local skills only for that project.

> The browser can’t reveal the picked folder’s absolute path (a security restriction); if you want the exact path recorded, fill the optional “Full path” box when creating the project.

---

## 6. Skills & system prompt

- **Skill menu (AI window)**: preset `Descriptive statistics`, `Compare two groups`, `Regression / model`, `Write a report`, etc. Pick one and the AI follows that standardized flow.
- **No skill selected**: AI picks the best fit itself.
- **Add your own**: in `skills/<name>/skill.md` put `# Display name` on the first line and the analysis workflow below; or put it in a project’s `skills/` (project-local). Refresh to see it in the menu.
- **System prompt** (`server/prompt/*.md`): the AI’s role/rules; edit and **restart the backend** to apply.

---

## 7. Common analysis examples

### 1. Import Excel / CSV
```r
library(readxl)                # install.packages("readxl") if missing
dat <- read_excel("data/clinical.xlsx")   # or read.csv("data/clinical.csv", check.names=F)
head(dat); str(dat); dim(dat)
```
### 2. Descriptive stats & group comparison
```r
summary(dat)
library(dplyr)
dat %>% group_by(group) %>% summarise(n=n(), mean=mean(age), sd=sd(age))
t.test(age ~ group, data=dat)        # normal -> t
wilcox.test(age ~ group, data=dat)   # skewed -> wilcoxon
chisq.test(table(dat$sex, dat$group))
```
### 3. Box / bar / scatter
```r
boxplot(age ~ group, data=dat, col=c("lightblue","salmon"))
barplot(table(dat$sex))
plot(dat$age, dat$bmi, col=as.factor(dat$group))
```
### 4. Lienar / logistic regression
```r
m1 <- lm(age ~ bmi + group, data=dat); summary(m1); confint(m1)
m2 <- glm(outcome ~ age + group, data=dat, family="binomial")
exp(coef(m2)); exp(confint(m2))   # OR + 95% CI
```
### 5. Bioinformatics (sketch: differential expression / volcano)
```r
# after limma/edgeR etc., a volcano-style plot:
plot(sc$logFC, -log10(sc$P.Value), col="grey", pch=20)
```
### 6. Output to the project folder
Save the project to keep figures/tables there, or in R: `pdf("figure1.pdf", width=6, height=4); plot(x); dev.off()`.

---

## 8. Tips & troubleshooting

- **Shared session**: fix one block and rerun; other blocks’ variables usually stay.
- **Ctrl+Enter step-through**: cursor auto-jumps to the next line — great for debugging.
- **AI says “need API key”**: use local Ollama (data never leaves your machine).
- **AI says fetch failed**: Ollama not running or wrong URL/model; run `ollama serve`.
- **R not ready**: set the full Rscript path in Settings (e.g. `C:/Program Files/R/R-4.4.1/bin/Rscript.exe`).
- **System prompt edits not applying**: it’s a backend file — restart the backend.
- **Switch UI vs AI language**: interface uses top-bar `中/EN`; AI output uses `AI→中/EN` — independent.

---

*If you hit a specific issue, share the error text, what you clicked, and what you expected.*
