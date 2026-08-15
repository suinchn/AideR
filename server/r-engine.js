'use strict';
/**
 * r-engine.js — Stateful R session engine.
 *
 * Spawns ONE persistent Rscript process and keeps it alive across every code
 * submission (from the user OR the AI). Because evaluation happens in the same
 * process, earlier assignments remain visible to later code — the core
 * requirement that lets the AI reference the variables it created a step ago.
 *
 * Wire protocol
 * -------------
 * User code runs inside a wrapper. After evaluation the wrapper serializes a
 * result object and emits it to stdout as a single cleanly-delimited frame:
 *
 *     <<<RJSON_START>>> <base64> <<<RJSON_END>>>
 *
 * base64 keeps the frame collision-free and binary-safe no matter what bytes
 * the user's own code prints (dataframes, cat(), plot messages, warnings).
 *
 * Result object:
 *   {
 *     "ok":        bool,
 *     "error":     string|null,
 *     "value":     string,     // visible last-expression output
 *     "captured":  string,     // everything the user's code printed
 *     "variables": [ {name,class,type,dim,size,head} ... ]
 *   }
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const START_MARKER = '<<<RJSON_START>>>';
const END_MARKER = '<<<RJSON_END>>>';

// Pure-R base64 + JS used in the frame; NO third-party R package required.
const R_BOOTSTRAP = `
options(width = 200)
options(warn = 1)

# ---- make user library writable + default CRAN mirror so install.packages works ----
.ulib <- Sys.getenv("R_LIBS_USER")
if (nzchar(.ulib)) {
  dir.create(.ulib, recursive = TRUE, showWarnings = FALSE)
  if (!(.ulib %in% .libPaths())) .libPaths(c(.ulib, .libPaths()))
}
options(repos = c(CRAN = "https://cloud.r-project.org"))

# ---- tiny self-contained base64 encoder (no package dependency) ----
.b64_lut <- "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
.b64_enc_char <- function(x) { charToRaw(x) }
.b64_core <- function(rv) {
  n <- length(rv)
  out <- raw(ceiling(n / 3) * 4)
  i <- 1L; j <- 1L
  while (i <= n) {
    b1 <- as.integer(rv[i])
    b2 <- if (i + 1 <= n) as.integer(rv[i + 1]) else NA
    b3 <- if (i + 2 <= n) as.integer(rv[i + 2]) else NA
    c1 <- bitwShiftR(b1, 2)
    c2 <- bitwOr(bitwShiftL(bitwAnd(b1, 3L), 4), bitwShiftR(if (is.na(b2)) 0L else b2, 4))
    out[j]     <- charToRaw(substr(.b64_lut, c1 + 1, c1 + 1))
    out[j + 1] <- charToRaw(substr(.b64_lut, c2 + 1, c2 + 1))
    if (is.na(b2)) {
      out[j + 2] <- charToRaw("="); out[j + 3] <- charToRaw("=")
    } else {
      c3 <- bitwOr(bitwShiftL(bitwAnd(b2, 15L), 2), bitwShiftR(if (is.na(b3)) 0L else b3, 6))
      out[j + 2] <- charToRaw(substr(.b64_lut, c3 + 1, c3 + 1))
      if (is.na(b3)) {
        out[j + 3] <- charToRaw("=")
      } else {
        c4 <- bitwAnd(b3, 63L)
        out[j + 3] <- charToRaw(substr(.b64_lut, c4 + 1, c4 + 1))
      }
    }
    i <- i + 3; j <- j + 4
  }
  rawToChar(out)
}
.b64_enc <- function(x) .b64_core(charToRaw(x))    # string -> base64
.b64_enc_raw <- function(rv) .b64_core(rv)          # raw vector -> base64


.run_submission <- function(code) {
  capf <- tempfile("rcap")
  con <- file(capf, "w")
  sink(con)
  # open a PNG device so plot()/ggplot writes to a capturable file
  plotf <- tempfile("rplot", fileext = ".png")
  .pending_plot <- plotf
  try(png(plotf, width = 800, height = 520, res = 96), silent = TRUE)

  expr <- tryCatch(parse(text = code), error = function(e) e)
  if (inherits(expr, "error")) {
    try(dev.off(), silent = TRUE)
    sink(); close(con)
    captured <- suppressWarnings(paste(readLines(capf, warn = FALSE), collapse = "\\n"))
    unlink(capf); unlink(plotf)
    return(list(ok = FALSE, error = conditionMessage(expr), captured = captured))
  }
  val <- ""; ok <- TRUE; err <- ""
  tryCatch(
    withCallingHandlers({
        n <- length(expr)
        if (n >= 1L) {
          for (i in seq_len(n)) {
            ans <- withVisible(eval(expr[[i]], envir = .GlobalEnv))
            if (i == n && ans$visible) {
              val <- paste(capture.output(print(ans$value), width = options()$width),
                collapse = "\\n")
            }
          }
        }
      },
      warning = function(w) {
        err <- paste(err, "Warning:", conditionMessage(w), sep = "\\n")
        invokeRestart("muffleWarning")
      }
    ),
    error = function(e) { ok <<- FALSE; err <<- conditionMessage(e); NULL }
  )
  try(dev.off(), silent = TRUE)
  sink(); close(con)
  captured <- suppressWarnings(paste(readLines(capf, warn = FALSE), collapse = "\\n"))
  unlink(capf)
  plots <- list()
  if (file.exists(plotf) && file.info(plotf)$size > 1500) {  # skip near-blank device
    cn <- file(plotf, "rb")
    rawbytes <- readBin(cn, "raw", n = file.info(plotf)$size)
    close(cn)
    plots[[1]] <- .b64_enc_raw(rawbytes)  # binary-safe base64 of PNG
  }
  if (file.exists(plotf)) unlink(plotf)
  list(ok = ok, error = err, value = val, captured = captured, plot = if (length(plots)) plots[[1]] else NULL)
}

.snapshot <- function(limit = 250) {
  nms <- ls(envir = .GlobalEnv, all.names = TRUE)
  nms <- nms[!startsWith(nms, ".")]
  nms <- head(nms, limit)
  out <- lapply(nms, function(nm) {
    obj <- tryCatch(get(nm, envir = .GlobalEnv), error = function(e) NULL)
    if (is.null(obj)) return(NULL)
    cl <- paste(class(obj), collapse = ", ")
    ty <- tryCatch(typeof(obj), error = function(e) "?")
    dm <- tryCatch({
      d <- dim(obj); if (!is.null(d)) paste(d, collapse = " x ") else length(obj)
    }, error = function(e) "?")
    sz <- tryCatch(paste(round(as.numeric(object.size(obj)) / 1024, 1), "KB"), error = function(e) "?")
    hd <- tryCatch({
      # For tables/data.frames, show structure (column names + types + dims),
      # NOT the full data (RStudio Environment style).
      pv <- capture.output(str(obj))
      if (inherits(obj, "data.frame") || inherits(obj, "tibble") || (is.matrix(obj) && length(dim(obj)) == 2)) {
        paste(pv, collapse = "\\n")
      } else {
        paste(capture.output(head(obj)), collapse = "\\n")
      }
    }, error = function(e) "")
    list(name = nm, class = cl, type = ty, dim = as.character(dm), size = sz,
         head = substr(hd, 1, 500))
  })
  out[!vapply(out, is.null, logical(1))]
}

.emit <- function(obj) {
  cat("\\n", .START_MDTAG, " ", sep = "")
  js <- tryCatch(.json_encode(obj), error = function(e) "{}")
  cat(.b64_enc(js))
  cat(" ", .END_MDTAG, "\\n", sep = "")
}

# ---- dependency-free recursive JSON encoder (no package dependency) ----
.json_esc <- function(s) {
  s <- as.character(s)
  s <- gsub('\\\\', '\\\\\\\\', s, fixed = TRUE)
  s <- gsub('"', '\\\\"', s, fixed = TRUE)
  s <- gsub('\n', '\\\\n', s, fixed = TRUE)
  s <- gsub('\r', '\\\\r', s, fixed = TRUE)
  s <- gsub('\t', '\\\\t', s, fixed = TRUE)
  s <- gsub('\b', '\\\\b', s, fixed = TRUE)
  s <- gsub('\f', '\\\\f', s, fixed = TRUE)
  s <- gsub('[[:cntrl:]]', '', s)
  s
}
.json_str <- function(s) paste0('"', .json_esc(s), '"')
.json_join <- function(v) if (length(v)) paste(v, collapse = ",") else ""

.json_encode <- function(obj) {
  if (is.null(obj)) return("null")
  if (is.logical(obj)) {
    vals <- ifelse(is.na(obj), "null", ifelse(obj, "true", "false"))
    return(.json_join(vals))
  }
  if (is.numeric(obj) || is.integer(obj)) {
    vals <- ifelse(is.na(obj), "null", as.character(obj))
    return(.json_join(vals))
  }
  if (is.character(obj)) {
    # atomic character vector -> if length 1, string; else array of strings
    if (length(obj) == 1L) return(.json_str(obj))
    return(paste0("[", .json_join(vapply(obj, function(x) .json_str(x), character(1))), "]"))
  }
  if (is.factor(obj)) return(.json_str(paste(as.character(obj), collapse = "\\n")))
  if (is.list(obj)) {
    nms <- names(obj)
    if (is.null(nms) || all(nms == "")) {
      # unnamed list -> JSON array
      parts <- lapply(obj, function(v) .json_encode(v))
      return(paste0("[", .json_join(parts), "]"))
    }
    # named list -> JSON object
    parts <- lapply(seq_along(obj), function(i) {
      paste0(.json_str(nms[i]), ":", .json_encode(obj[[i]]))
    })
    return(paste0("{", .json_join(parts), "}"))
  }
  if (is.null(obj)) return("null")
  .json_str(toString(obj))
}

.START_MDTAG <- "<<<RJSON_START>>>"
.END_MDTAG <- "<<<RJSON_END>>>"

.submit <- function(code) {
  r <- .run_submission(code)
  vars <- .snapshot()
  .emit(list(
    ok = r$ok, error = r$error, value = r$value,
    captured = if (is.null(r$captured)) "" else r$captured,
    variables = vars,
    plot = if (is.null(r$plot)) "" else r$plot
  ))
}
`;

const R_SEND = `.submit(<JSON>)`; // redefined per call, see below

function findRscript(customPath) {
  if (customPath && fs.existsSync(customPath)) return customPath;
  if (process.env.R_HOME) {
    const cand = path.join(process.env.R_HOME, 'bin', 'Rscript' + (os.platform() === 'win32' ? '.exe' : ''));
    if (fs.existsSync(cand)) return cand;
  }
  return 'Rscript' + (os.platform() === 'win32' ? '.exe' : '');
}

function looksExisting(p) {
  if (path.isAbsolute(p) || p.includes(path.sep) || p.includes('/')) {
    return fs.existsSync(p);
  }
  return true; // bare name -> rely on PATH
}

/** Encode a JS string as a JSON string literal safe to embed in R code. */
function toRscalar(s) {
  return JSON.stringify(String(s)); // JSON string literals are valid R char literals too
}

class RSession {
  constructor(opts = {}) {
    this.rscript = findRscript(opts.rscript);
    this.proc = null;
    this.closed = false;
    this.running = false;
    this.started = false;
    this.bootstrapDone = false;
    this.queue = [];          // FIFO of {resolve, reject, code, seenByDrain}
    this._buffer = '';
    this._onReady = null;
    this.lastVariables = [];
    this.sessionError = null;
  }

  async ensureStarted() {
    // memoize: never double-spawn
    if (this._startPromise) return this._startPromise;
    if (this.proc && !this.closed) {
      this._startPromise = Promise.resolve(this);
      return this._startPromise;
    }
    if (!looksExisting(this.rscript)) {
      throw new Error(
        `未找到 R/Rscript。尝试路径: "${this.rscript}"\n` +
        `请安装 R (https://cran.r-project.org/)，或确保 Rscript 在 PATH，` +
        `或在设置里填写 Rscript 完整路径。`);
    }
    this._startPromise = new Promise((resolve, reject) => {
      // Reserve a queue slot for the readiness handshake so its frame maps to
      // this resolve() and the queue stays aligned with real submissions.
      const readyEntry = { code: '', ready: true, resolve, reject };
      this.queue.push(readyEntry);

      this.proc = spawn(this.rscript, ['--no-save', '--no-restore', '--vanilla', '-'],
        { stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc.stdout.setEncoding('utf8');
      this.proc.stderr.setEncoding('utf8');
      this.proc.stdout.on('data', (d) => this._onData(d));
      this.proc.stderr.on('data', (d) => { this._stderrBuf = (this._stderrBuf || '') + d; });
      this.proc.on('error', (e) => {
        this.closed = true;
        const friendly = new Error(
          `无法启动 Rscript: "${this.rscript}" (${e.message})\n` +
          `请安装 R (https://cran.r-project.org/)，或确保 Rscript 在 PATH，` +
          `或在设置里填写 Rscript 完整路径。`);
        // reject the reserved ready entry
        readyEntry.reject(friendly);
        reject(friendly);
        this.closed = true;
      });
      this.proc.on('exit', (c) => {
        this.closed = true;
        if (this._poisoned) return;
        this.sessionError = new Error(`R 进程退出 (code ${c})`);
        for (const q of this.queue) q.reject && q.reject(this.sessionError);
        this.queue = [];
      });
      // feed bootstrap + readiness probe
      this.proc.stdin.write(R_BOOTSTRAP);
      this.proc.stdin.write('\n.submit("\\"__ready__\\"")\n');
    });
    return this._startPromise;
  }

  _onData(chunk) {
    this._buffer += chunk;
    let open;
    while ((open = this._buffer.indexOf(START_MARKER)) !== -1) {
      const close = this._buffer.indexOf(END_MARKER, open);
      if (close === -1) break;
      const b64 = this._buffer.slice(open + START_MARKER.length, close).trim();
      this._buffer = this._buffer.slice(close + END_MARKER.length);
      let result;
      try {
        result = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      } catch (e) {
        result = { ok: false, error: '无法解析 R 输出帧', value: '', captured: '', variables: [] };
      }
      this._frameReceived(result);
    }
  }

  _frameReceived(result) {
    const q = this.queue[0];
    this.running = false;
    if (q) {
      this.queue.shift();
      if (this._onReady) { this._onReady(); this._onReady = null; }
      if (result.variables) this.lastVariables = result.variables;
      // combine captured + value for display
      const output = [result.captured, result.value].filter(Boolean).join('\n');
      q.resolve({
        ok: result.ok !== false,
        error: result.error || null,
        output: output,
        plot: result.plot || null,
        variables: result.variables && result.variables.length ? result.variables : this.lastVariables,
      });
    }
    this._drain();
  }

  /**
   * Evaluate `code` in the shared session.
   * @returns {Promise<{ok:boolean,error:null|string,output:string,variables:any[]}>}
   */
  submit(code) {
    return new Promise((resolve, reject) => {
      // If the session is poisoned (process failed to start) or permanently
      // closed, reject immediately instead of hanging in the queue.
      if (this._poisoned || (this.closed && !this.proc)) {
        reject(this.sessionError || new Error('R 会话不可用。'));
        return;
      }
      this.queue.push({ resolve, reject, code });
      this._drain();
    });
  }

  _drain() {
    if (this.closed || this.running || !this.queue.length) return;
    const q = this.queue[0];
    if (!this.bootstrapDone) {
      this.ensureStarted()
        .then(() => {
          this.bootstrapDone = true;
          this._drain();
        })
        .catch((e) => {
          q.reject(e);
          this.queue.shift();
          this._drain();
        });
      return;
    }
    this.running = true;
    this.proc.stdin.write('.submit(' + toRscalar(q.code) + ')\n');
  }

  async getVariables() {
    if (this.lastVariables.length) return this.lastVariables;
    await this.ensureStarted();
    return this.lastVariables;
  }

  get rscriptPath() { return this.rscript; }
  get isClosed() { return this.closed; }

  /**
   * Update the Rscript path to use. Only effective if the process has not yet
   * been spawned (i.e. before first successful start). After the session is
   * alive with state, changing the path is not possible without losing state.
   */
  async setRscript(p) {
    if (this.proc && !this.closed && !this._poisoned) {
      throw new Error('R 会话已在运行（含变量状态），请重启程序后再修改 Rscript 路径。');
    }
    this.rscript = findRscript(p || undefined);
    // unlock a poisoned (failed-to-start) session for retry
    this.closed = false;
    this._poisoned = false;
  }

  /** Reset start-related state after a failed spawn, so retry works. */
  _poison(err) {
    this._poisoned = true;
    this.proc = null;
    this.bootstrapDone = false;
    this.running = false;
    this._buffer = '';
    this.sessionError = err;
    for (const q of this.queue) q.reject && q.reject(err);
    this.queue = [];
  }
}

module.exports = { RSession, findRscript };
