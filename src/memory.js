// memory.js — persistent student memory for Trixie
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const MEMORY_FILE = path.join(os.homedir(), 'trixie-memory.json');

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _load() {
  try {
    const raw = fs.readFileSync(MEMORY_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function _save(data) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Save a key/value fact. key is a short slug, value is the full fact string.
 * e.g. saveFact('os_exam', 'OS exam is on Thursday')
 */
function saveFact(key, value) {
  const data = _load();
  const slug = key.toLowerCase().replace(/\s+/g, '_').slice(0, 40);
  data[slug] = { value, savedAt: new Date().toISOString() };
  _save(data);
  return slug;
}

/**
 * Remove a fact by key slug. Returns true if it existed.
 */
function forgetFact(key) {
  const data = _load();
  const slug = key.toLowerCase().replace(/\s+/g, '_').slice(0, 40);
  if (slug in data) {
    delete data[slug];
    _save(data);
    return true;
  }
  return false;
}

/**
 * Returns all facts as a block of text to inject into the system prompt.
 * Returns empty string if no facts.
 */
function formatMemoryForPrompt() {
  const data = _load();
  const entries = Object.values(data);
  if (!entries.length) return '';
  const lines = entries.map((e) => `- ${e.value}`).join('\n');
  return `WHAT I REMEMBER ABOUT THIS STUDENT:\n${lines}`;
}

/**
 * List all saved facts (returns the raw object).
 */
function listFacts() {
  return _load();
}

module.exports = { saveFact, forgetFact, formatMemoryForPrompt, listFacts };
