// agent.js — Trixie agent brain
'use strict';

const fetch            = require('node-fetch');
const toolsModule      = require('./tools');
const { TOOL_DEFINITIONS, readFile, writeFile, runCode, webSearch, openApp, openInVSCode, listDirectory,
        rememberFact, forgetFact, recallMemory,
        readClipboard, writeClipboard, setReminder, listMyFiles, captureScreen } = toolsModule;
const DESKTOP_PATH     = toolsModule._DESKTOP_PATH;
const { formatMemoryForPrompt } = require('./memory');
const sessionLog = require('./session-log');

// ─── Tool executor map ────────────────────────────────────────────────────────
const TOOLS = { readFile, writeFile, runCode, webSearch, openApp, openInVSCode, listDirectory,
                rememberFact, forgetFact, recallMemory,
                readClipboard, writeClipboard, setReminder, listMyFiles, captureScreen };

// Explicit parameter order per tool — LLM may return args in any key order.
const TOOL_PARAM_ORDER = {
  readFile:      ['filePath'],
  writeFile:     ['filePath', 'content'],
  runCode:       ['language', 'code'],
  webSearch:     ['query'],
  openApp:       ['nameOrUrl'],
  openInVSCode:  ['fileName'],
  listDirectory: ['dirPath'],
  rememberFact:  ['key', 'value'],
  forgetFact:    ['key'],
  recallMemory:  [],
  readClipboard: [],
  writeClipboard: ['text'],
  setReminder:   ['message', 'delayMinutes'],
  listMyFiles:   [],
  captureScreen: ['question'],
};

const MAX_TOOL_LOOPS = 6; // safety cap on chained tool calls per turn

// ─── Persistent history path ──────────────────────────────────────────────────
const fs_sync      = require('fs');
const path_module  = require('path');
const os_module    = require('os');
const HISTORY_PATH = path_module.join(os_module.homedir(), '.trixie_history.json');
const MAX_HISTORY  = 4;

// ─── System prompt ────────────────────────────────────────────────────────────
const BASE_SYSTEM_PROMPT = `You are Trixie, a witty AI assistant on a student's Windows desktop.
Speak concisely — no markdown, no bullet points, natural sentences only.
You have tools: readFile, writeFile, runCode, webSearch, openApp, listDirectory, captureScreen, readClipboard, writeClipboard, setReminder, rememberFact, forgetFact, recallMemory, listMyFiles.

Key behaviours:
- "start viva on X" / "quiz me on X": become a strict professor, ask 4-5 questions one at a time, then score out of 10 and name weak areas.
- "explain code" / "explain [file]": use readFile first, then teach conversationally.
- "summarise my notes" / "cheat sheet for X": read files, write summary to Desktop as [topic]-cheatsheet.md.
- "explain my screen" / "what's on my screen": call captureScreen.
- "explain what I copied": call readClipboard.
- "remind me to X in Y minutes": call setReminder.
- "remember that X": call rememberFact. "forget X": call forgetFact.
- "what files have you made": call listMyFiles.
Always be brief. Offer to write long answers to a file.

IMPORTANT: The user's Desktop is at "${DESKTOP_PATH}". Always use this exact path when saving files to the Desktop. Never use ~, C:\\Users\\User, or any other guessed path.
Save code files with correct extensions: C code → .c, Python → .py, JavaScript → .js. Never save code as .txt.
To open a file in VS Code, call openApp with nameOrUrl set to: code "full_file_path" (e.g. code "${DESKTOP_PATH}\\\\DFS.c").`;

// ─── Gemini tool format conversion ───────────────────────────────────────────
function toGeminiTools(defs) {
  return [{
    functionDeclarations: defs.map((t) => ({
      name:        t.name,
      description: t.description,
      parameters:  t.parameters,
    })),
  }];
}

// ─── OpenAI tool format (Groq) ────────────────────────────────────────────────
function toOpenAITools(defs) {
  return defs.map((t) => ({
    type:     'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// ─── Agent ────────────────────────────────────────────────────────────────────
class Agent {
  constructor() {
    this.conversationHistory = [];
    this.isProcessing        = false;
    this._contextSnapshot    = null; // cached directory listing for session
    this._loadHistory();
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  async processMessage(userText, onStateChange) {
    if (this.isProcessing) return 'Still thinking — give me a moment!';
    this.isProcessing = true;

    try {
      // Lazily populate directory context on first message of the session
      if (!this._contextSnapshot) {
        await this._refreshContext();
      }

      // ── Viva session tracking (start) ─────────────────────────────────────
      const vivaStartMatch = userText.match(/(?:start viva|quiz me)\s+(?:on\s+)?(.+)/i);
      if (vivaStartMatch) {
        sessionLog.startSession(vivaStartMatch[1].trim());
      }

      this._addHistory('user', userText);
      if (onStateChange) onStateChange('thinking');

      let response;
      const skipGemini = process.env.GEMINI_DISABLED === 'true';
      try {
        if (skipGemini) throw new Error('Gemini disabled via GEMINI_DISABLED=true');
        response = await this._callGemini(onStateChange);
      } catch (geminiErr) {
        if (!skipGemini) console.warn('[AGENT] Gemini failed, falling back to Groq:', geminiErr.message);
        try {
          response = await this._callGroq(onStateChange);
        } catch (groqErr) {
          console.error('[AGENT] Groq also failed:', groqErr.message);
          response = "My thinking is a bit slow right now — try again in a moment.";
        }
      }

      // ── Viva session tracking (record + end) ──────────────────────────────
      if (sessionLog.isActive()) {
        // Record each Q (Trixie) / A (student) turn
        if (this.conversationHistory.length >= 2) {
          const last = this.conversationHistory[this.conversationHistory.length - 1];
          if (last?.role === 'user') {
            const prev = this.conversationHistory[this.conversationHistory.length - 2];
            if (prev?.role === 'assistant') {
              sessionLog.recordTurn(prev.content, last.content);
            }
          }
        }

        // Detect end-of-viva: look for a score pattern in the response
        const scoreMatch = response.match(/\b(\d{1,2})\s*\/\s*10\b/);
        if (scoreMatch) {
          const score = `${scoreMatch[1]}/10`;
          // Extract weak areas — look for "weak area" or "work on" mentions
          const weakMatch = response.match(/(?:weak\s+areas?|you\s+should\s+(?:work|review)\s+on)[:\s]+([^.]+)/i);
          const weakAreas = weakMatch
            ? weakMatch[1].split(/,|and/).map((s) => s.trim()).filter(Boolean)
            : [];
          const logPath = sessionLog.endSession(score, weakAreas);
          if (logPath) {
            response += `\n\nI've saved this session to your Desktop in trixie-session-log.md.`;
          }
        }
      }

      this._addHistory('assistant', response);
      this._trimHistory();
      this._saveHistory();
      return response;
    } finally {
      this.isProcessing = false;
    }
  }

  // Refresh the working-directory snapshot (call on session start or on demand)
  async _refreshContext() {
    try {
      const listing = await listDirectory('.');
      this._contextSnapshot = listing;
      console.log('[AGENT] Context snapshot:\n', listing);
    } catch (err) {
      this._contextSnapshot = '(could not list working directory)';
    }
  }

  // Build the full system prompt, injecting memory facts, session history, and directory
  _buildSystemPrompt() {
    const ctx     = this._contextSnapshot || '(directory context not yet loaded)';
    const memory  = formatMemoryForPrompt();
    const history = sessionLog.getHistorySummary();
    const parts   = [BASE_SYSTEM_PROMPT];
    if (memory)  parts.push(memory);
    if (history) parts.push(`PAST VIVA SESSIONS (use to tailor follow-up questions):\n${history}`);
    parts.push(`CURRENT WORKING DIRECTORY:\n${ctx}`);
    return parts.join('\n\n');
  }

  // ── Gemini ─────────────────────────────────────────────────────────────────

  async _callGemini(onStateChange) {
    const key = process.env.GOOGLE_AI_STUDIO_KEY;
    if (!key) throw new Error('GOOGLE_AI_STUDIO_KEY not set');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;

    const baseBody = {
      systemInstruction: { parts: [{ text: this._buildSystemPrompt() }] },
      tools: toGeminiTools(TOOL_DEFINITIONS),
      generationConfig: { maxOutputTokens: 500, temperature: 0.7 },
    };

    let contents = this._toGeminiContents();

    for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ...baseBody, contents }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Gemini ${res.status}: ${text}`);
      }

      const data      = await res.json();
      const candidate = data.candidates?.[0];
      const part      = candidate?.content?.parts?.[0];

      if (part?.functionCall) {
        const { name, args } = part.functionCall;
        console.log(`[AGENT] Gemini tool call: ${name}`, args);
        if (onStateChange) onStateChange('thinking', this._toolLabel(name, args));
        const toolResult = await this._executeTool(name, args);
        contents = [
          ...contents,
          { role: 'model', parts: [{ functionCall: { name, args } }] },
          { role: 'user',  parts: [{ functionResponse: { name, response: { output: toolResult } } }] },
        ];
        continue;
      }

      const text = part?.text?.trim();
      if (!text) throw new Error('Empty Gemini response');
      return text;
    }

    throw new Error('Gemini tool loop exceeded max iterations');
  }

  // ── Groq fallback ──────────────────────────────────────────────────────────

  async _callGroq(onStateChange) {
    const key = process.env.GROQ_KEY;
    if (!key) throw new Error('GROQ_KEY not set');

    const baseBody = {
      model:       'llama-3.3-70b-versatile',
      tools:       toOpenAITools(TOOL_DEFINITIONS),
      tool_choice: 'auto',
      max_tokens:  800,
      temperature: 0.7,
    };

    let messages = [
      { role: 'system', content: this._buildSystemPrompt() },
      ...this.conversationHistory,
    ];

    for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({ ...baseBody, messages }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // On rate limit, wait the suggested retry delay then try once more
        if (res.status === 429) {
          const retryMatch = text.match(/Please try again in ([\d.]+)s/);
          const waitMs = retryMatch ? Math.ceil(parseFloat(retryMatch[1]) * 1000) + 500 : 5000;
          console.warn(`[AGENT] Groq 429 — retrying in ${waitMs}ms`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        throw new Error(`Groq ${res.status}: ${text}`);
      }

      const data    = await res.json();
      const choice  = data.choices?.[0];
      const message = choice?.message;

      if (message?.tool_calls?.length) {
        // Process all parallel tool calls in this turn
        const toolMessages = [];
        for (const tc of message.tool_calls) {
          const toolName   = tc.function.name;
          const toolArgs   = JSON.parse(tc.function.arguments || '{}');
          console.log(`[AGENT] Groq tool call: ${toolName}`, toolArgs);
          if (onStateChange) onStateChange('thinking', this._toolLabel(toolName, toolArgs));
          const toolResult = await this._executeTool(toolName, toolArgs);
          toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
        }
        messages = [...messages, message, ...toolMessages];
        continue;
      }

      const text = message?.content?.trim();
      if (!text) throw new Error('Empty Groq response');
      return text;
    }

    throw new Error('Groq tool loop exceeded max iterations');
  }

  // ── Tool execution ─────────────────────────────────────────────────────────

  // Human-readable label for the tool-use indicator in the UI
  _toolLabel(name, args) {
    const labels = {
      readFile:       (a) => 'reading ' + (a.filePath ? path_module.basename(a.filePath) : 'file') + '\u2026',
      writeFile:      (a) => 'writing ' + (a.filePath ? path_module.basename(a.filePath) : 'file') + '\u2026',
      runCode:        (a) => 'running ' + (a.language || 'code') + '\u2026',
      webSearch:      ()  => 'searching web\u2026',
      openApp:        (a) => 'opening ' + (a.nameOrUrl || 'app') + '\u2026',
      listDirectory:  ()  => 'listing directory\u2026',
      captureScreen:  ()  => 'reading screen\u2026',
      readClipboard:  ()  => 'reading clipboard\u2026',
      writeClipboard: ()  => 'copying to clipboard\u2026',
      setReminder:    ()  => 'setting reminder\u2026',
      rememberFact:   ()  => 'saving to memory\u2026',
      forgetFact:     ()  => 'forgetting\u2026',
    };
    const fn = labels[name];
    return fn ? fn(args) : 'using ' + name + '\u2026';
  }

  async _executeTool(name, args) {
    const fn = TOOLS[name];
    if (!fn) return `Unknown tool: ${name}`;
    try {
      // Map args by declared parameter order so LLM key order doesn't matter
      const order  = TOOL_PARAM_ORDER[name] || [];
      const params = order.map((k) => args[k]);
      const result = await fn(...params);
      const resultStr = String(result);

      // If captureScreen returned a screenshot blob, send it to Gemini vision
      if (name === 'captureScreen' && resultStr.startsWith('{"type":"screenshot"')) {
        try {
          const blob = JSON.parse(resultStr);
          return await this._describeScreenshot(blob.dataURL, blob.question);
        } catch (visionErr) {
          return `Screenshot captured but vision failed: ${visionErr.message}`;
        }
      }

      return resultStr;
    } catch (err) {
      return `Tool error: ${err.message}`;
    }
  }

  // Send a screenshot (data URL) to Gemini vision and return the description
  async _describeScreenshot(dataURL, question) {
    const key = process.env.GOOGLE_AI_STUDIO_KEY;
    if (!key) throw new Error('GOOGLE_AI_STUDIO_KEY not set for vision');

    // Strip the data URI prefix to get raw base64
    const base64 = dataURL.replace(/^data:image\/\w+;base64,/, '');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;
    const body = {
      contents: [{
        parts: [
          { text: question || 'Describe what is on screen in 2-3 sentences. Focus on anything relevant to studying.' },
          { inline_data: { mime_type: 'image/png', data: base64 } },
        ],
      }],
      generationConfig: { maxOutputTokens: 300, temperature: 0.4 },
    };

    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gemini vision ${res.status}: ${text}`);
    }

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '(no vision response)';
  }

  // ── History helpers ────────────────────────────────────────────────────────

  _addHistory(role, content) {
    this.conversationHistory.push({ role, content });
  }

  _trimHistory() {
    if (this.conversationHistory.length > MAX_HISTORY) {
      this.conversationHistory = this.conversationHistory.slice(-MAX_HISTORY);
    }
  }

  _loadHistory() {
    try {
      const raw  = fs_sync.readFileSync(HISTORY_PATH, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        this.conversationHistory = data;
        console.log(`[AGENT] Loaded ${data.length} messages from history`);
      }
    } catch (_) {
      // No history file yet — start fresh
    }
  }

  _saveHistory() {
    try {
      fs_sync.writeFileSync(HISTORY_PATH, JSON.stringify(this.conversationHistory), 'utf8');
    } catch (err) {
      console.warn('[AGENT] Could not save history:', err.message);
    }
  }

  // Convert OpenAI-style history to Gemini contents format
  _toGeminiContents() {
    return this.conversationHistory
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role:  m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────
const agent = new Agent();
module.exports = { agent };
