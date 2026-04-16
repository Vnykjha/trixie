// session-log.js — tracks viva sessions and writes session-log.md
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DESKTOP      = path.join(os.homedir(), 'Desktop');
const SESSION_FILE = path.join(DESKTOP, 'trixie-session-log.md');

// ─── In-memory session state ──────────────────────────────────────────────────

let _active    = false;
let _topic     = '';
let _startedAt = null;
let _turns     = [];   // { q: string, a: string }
let _score     = null; // e.g. "7/10"
let _weakAreas = [];   // string[]

// ─── Lifecycle ────────────────────────────────────────────────────────────────

function startSession(topic) {
  _active    = true;
  _topic     = topic || 'General';
  _startedAt = new Date();
  _turns     = [];
  _score     = null;
  _weakAreas = [];
  console.log(`[SESSION] Started viva on "${_topic}"`);
}

function recordTurn(question, answer) {
  if (!_active) return;
  _turns.push({ q: question, a: answer });
}

function endSession(score, weakAreas) {
  if (!_active) return null;
  _active    = false;
  _score     = score     || null;
  _weakAreas = weakAreas || [];

  const logPath = _writeLog();
  console.log(`[SESSION] Ended. Log written to ${logPath}`);
  return logPath;
}

function isActive() {
  return _active;
}

function getTopic() {
  return _topic;
}

// ─── Log writer ───────────────────────────────────────────────────────────────

function _writeLog() {
  const now   = _startedAt || new Date();
  const date  = now.toLocaleDateString('en-IE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const time  = now.toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' });

  const scoreLine  = _score     ? `**Score:** ${_score}` : '**Score:** not recorded';
  const weakLine   = _weakAreas.length
    ? `**Weak areas:** ${_weakAreas.join(', ')}`
    : '**Weak areas:** none identified';

  const qaSection = _turns.length
    ? _turns.map((t, i) =>
        `### Q${i + 1}\n**Trixie:** ${t.q}\n\n**You:** ${t.a}`
      ).join('\n\n')
    : '*No questions recorded.*';

  const entry = `\n---\n\n## ${date} · ${time} — ${_topic}\n\n${scoreLine}  \n${weakLine}\n\n### Questions & Answers\n\n${qaSection}\n`;

  // Append to the running log file
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.appendFileSync(SESSION_FILE, entry, 'utf8');
  } catch (err) {
    console.error('[SESSION] Could not write log:', err.message);
  }

  return SESSION_FILE;
}

// ─── Read history summary (for injecting into system prompt) ──────────────────

function getHistorySummary() {
  try {
    const content = fs.readFileSync(SESSION_FILE, 'utf8');
    // Return last ~1500 chars so it doesn't bloat the prompt
    if (content.length > 1500) {
      return '(earlier sessions omitted)\n' + content.slice(-1500);
    }
    return content;
  } catch (_) {
    return null;
  }
}

module.exports = { startSession, recordTurn, endSession, isActive, getTopic, getHistorySummary };
