// Redacting logger. All Universal Harness diagnostic output goes through here.
//
// Writes one JSONL line per record to data/logs/uh.log (portable, so the log
// travels with the workspace) and mirrors a compact form to the console. Every
// field is passed through the redactor; secrets never reach disk or screen.

import fs from 'node:fs';
import path from 'node:path';
import { redact, redactObject } from '../errors/mod.mjs';
import { findRoot } from '../paths/mod.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * @param {Object} opts
 * @param {string} [opts.logDir] override the log directory (tests)
 * @param {'debug'|'info'|'warn'|'error'} [opts.level] minimum console level
 * @param {boolean} [opts.console] mirror to stdout/stderr (default true)
 */
export function createLogger({ logDir, level = 'info', console: useConsole = true } = {}) {
  const dir = logDir || (() => {
    const root = findRoot();
    return root ? path.join(root, 'data', 'logs') : null;
  })();
  if (dir) fs.mkdirSync(dir, { recursive: true });

  const minLevel = LEVELS[level] ?? LEVELS.info;

  function write(levelName, msg, fields) {
    const rec = {
      ts: new Date().toISOString(),
      level: levelName,
      msg: redact(String(msg || '')),
      ...redactObject(fields || {}),
    };
    if (dir) {
      try { fs.appendFileSync(path.join(dir, 'uh.log'), JSON.stringify(rec) + '\n'); }
      catch { /* logging must never crash the caller */ }
    }
    if (useConsole && (LEVELS[levelName] >= minLevel)) {
      const text = rec.fields ? `${rec.msg} ${JSON.stringify(rec.fields)}` : rec.msg;
      const stream = levelName === 'error' || levelName === 'warn' ? process.stderr : process.stdout;
      stream.write(`[${levelName}] ${text}\n`);
    }
    return rec;
  }

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (bindings) => ({
      debug: (m, f) => write('debug', m, { ...bindings, ...f }),
      info: (m, f) => write('info', m, { ...bindings, ...f }),
      warn: (m, f) => write('warn', m, { ...bindings, ...f }),
      error: (m, f) => write('error', m, { ...bindings, ...f }),
    }),
  };
}

export const LEVEL_NAMES = Object.keys(LEVELS);
