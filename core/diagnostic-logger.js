'use strict';

const fs   = require('fs-extra');
const os   = require('os');
const path = require('path');

const DEFAULT_LOG_DIR = path.join(os.homedir(), '.mc-devkit', 'logs');
const LOG_FILE_RE = /^devkit-\d{4}-\d{2}-\d{2}\.log$/;

function redactText(value) {
  return String(value ?? '')
    .replace(/(--secret_key\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/((?:password|token|secret(?:_key)?|authorization|cookie|토큰|비밀번호)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(playit\.gg\/claim\/)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(data:image\/[^;]+;base64,)[a-z0-9+/=]+/gi, '$1[OMITTED]');
}

function sanitizeDetails(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      stack: redactText(value.stack || ''),
    };
  }
  if (typeof value === 'string') {
    const redacted = redactText(value);
    return redacted.length > 8000 ? `${redacted.slice(0, 8000)}…[truncated]` : redacted;
  }
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (depth >= 5) return '[max-depth]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeDetails(item, depth + 1));
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (/token|password|secret|authorization|cookie|image/i.test(key)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = sanitizeDetails(item, depth + 1);
      }
    }
    return result;
  }
  return redactText(value);
}

class DiagnosticLogger {
  constructor({ logDir = DEFAULT_LOG_DIR, retentionDays = 14, now = () => new Date() } = {}) {
    this.logDir = logDir;
    this.retentionDays = retentionDays;
    this.now = now;
    this._buffer = [];
    this._flushTimer = null;
    fs.ensureDirSync(this.logDir);
    this.prune();
  }

  _dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  _fileFor(date) {
    return path.join(this.logDir, `devkit-${this._dateKey(date)}.log`);
  }

  log(level, source, message, details) {
    const timestamp = this.now();
    const normalizedLevel = String(level || 'info').toUpperCase();
    const normalizedSource = redactText(source || 'app').replace(/[\r\n\[\]]/g, '_');
    const normalizedMessage = message instanceof Error
      ? redactText(message.stack || message.message)
      : redactText(message);
    let line = `[${timestamp.toISOString()}] [${normalizedLevel}] [${normalizedSource}] ${normalizedMessage}`;
    if (details !== undefined) {
      try { line += ` ${JSON.stringify(sanitizeDetails(details))}`; }
      catch { line += ' {"details":"[unserializable]"}'; }
    }
    this._buffer.push({ file: this._fileFor(timestamp), line: `${line}\n` });

    if (this._buffer.length >= 100) {
      this.flushSync();
    } else if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this.flushSync(), 100);
      this._flushTimer.unref?.();
    }
  }

  debug(source, message, details) { this.log('debug', source, message, details); }
  info(source, message, details)  { this.log('info', source, message, details); }
  warn(source, message, details)  { this.log('warn', source, message, details); }
  error(source, message, details) { this.log('error', source, message, details); }

  flushSync() {
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = null;
    if (!this._buffer.length) return;

    const pending = this._buffer.splice(0);
    const grouped = new Map();
    for (const entry of pending) grouped.set(entry.file, (grouped.get(entry.file) || '') + entry.line);
    try {
      fs.ensureDirSync(this.logDir);
      for (const [file, content] of grouped) fs.appendFileSync(file, content, 'utf8');
    } catch (error) {
      // Keep diagnostics best-effort and never crash the server because the log disk is unavailable.
      try { console.error(`[DevKit] diagnostic log write failed: ${error.message}`); } catch {}
    }
  }

  listFiles() {
    this.flushSync();
    try {
      return fs.readdirSync(this.logDir)
        .filter(name => LOG_FILE_RE.test(name))
        .map(name => {
          const file = path.join(this.logDir, name);
          const stat = fs.statSync(file);
          return { name, path: file, size: stat.size, modifiedAt: stat.mtime.toISOString() };
        })
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    } catch {
      return [];
    }
  }

  latestFile() {
    return this.listFiles()[0]?.path || null;
  }

  prune() {
    const cutoff = this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
    try {
      for (const name of fs.readdirSync(this.logDir)) {
        if (!LOG_FILE_RE.test(name)) continue;
        const file = path.join(this.logDir, name);
        if (fs.statSync(file).mtimeMs < cutoff) fs.removeSync(file);
      }
    } catch {}
  }
}

const logger = new DiagnosticLogger();

module.exports = { DiagnosticLogger, logger, redactText, sanitizeDetails };
