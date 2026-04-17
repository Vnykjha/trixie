// agent.js — Trixie agent brain
'use strict';

const fetch            = require('node-fetch');
const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const toolsModule      = require('./tools');
const { TOOL_DEFINITIONS, readFile, writeFile, runCode, webSearch, openApp, closeApp, openInVSCode, listDirectory,
        rememberFact, forgetFact, recallMemory,
        readClipboard, writeClipboard, setReminder, listMyFiles, captureScreen,
        browserNavigate, browserAction, githubCli } = toolsModule;
const DESKTOP_PATH     = toolsModule._DESKTOP_PATH;
const { formatMemoryForPrompt } = require('./memory');
const sessionLog = require('./session-log');

// ─── Tool executor map ────────────────────────────────────────────────────────
const TOOLS = { readFile, writeFile, runCode, webSearch, openApp, closeApp, openInVSCode, listDirectory,
                rememberFact, forgetFact, recallMemory,
                readClipboard, writeClipboard, setReminder, listMyFiles, captureScreen,
                browserNavigate, browserAction, githubCli };

// Explicit parameter order per tool — LLM may return args in any key order.
const TOOL_PARAM_ORDER = {
  readFile:      ['filePath'],
  writeFile:     ['filePath', 'content'],
  runCode:       ['language', 'code'],
  webSearch:     ['query'],
  openApp:       ['nameOrUrl'],
  closeApp:      ['name'],
  openInVSCode:  ['fileName'],
  listDirectory: ['dirPath'],
  rememberFact:  ['key', 'value'],
  forgetFact:    ['key'],
  recallMemory:  [],
  readClipboard: [],
  writeClipboard: ['text'],
  setReminder:   ['message', 'delayMinutes'],
  listMyFiles:      [],
  captureScreen:    ['question'],
  browserNavigate:  ['url'],
  browserAction:    ['action', 'selector', 'value'],
  githubCli:        ['subcommand'],
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
You have tools: readFile, writeFile, runCode, webSearch, openApp, closeApp, listDirectory, captureScreen, readClipboard, writeClipboard, setReminder, rememberFact, forgetFact, recallMemory, listMyFiles, browserNavigate, browserAction, githubCli.

CRITICAL RULE — TOOL-FIRST: For ANY request that involves an action (opening, launching, searching, writing, reading, navigating, clicking), you MUST call the appropriate tool BEFORE generating a text response. It is strictly forbidden to claim you have done something without first calling the tool. If you say "I've opened X" or "I've saved X" without having called a tool in this turn, that is a hallucination and an error.

Key behaviours:
- "start viva on X" / "quiz me on X": become a strict professor, ask 4-5 questions one at a time, then score out of 10 and name weak areas.
- "explain code" / "explain [file]": CALL readFile first, then teach conversationally.
- "summarise my notes" / "cheat sheet for X": CALL readFile, then CALL writeFile to Desktop as [topic]-cheatsheet.md.
- "explain my screen" / "what's on my screen": CALL captureScreen.
- "explain what I copied": CALL readClipboard.
- "remind me to X in Y minutes": CALL setReminder.
- "remember that X": CALL rememberFact. "forget X": CALL forgetFact.
- "what files have you made": CALL listMyFiles.
- "open X" / "go to X" / any website: CALL browserNavigate with the site name (e.g. "youtube", "gmail", "github", "netflix", "reddit", "chatgpt").
- "search for X on [site]" / "click X" / "type X": CALL browserAction after browserNavigate.
- "close X" / "quit X" / "kill X": CALL closeApp immediately with the app name. Never say you cannot close apps.
- "open camera" / "open calculator" / "launch [app]" / any desktop app: CALL openApp immediately. Camera → openApp("camera"). Calculator → openApp("calculator"). Spotify → openApp("spotify"). Discord → openApp("discord"). Do not say you opened it — call the tool first, then confirm.
- GitHub questions ("my repos", "latest repo", "what did I commit", "open my repo", "my PRs", "my issues", "did CI pass"): CALL githubCli. Examples: "repo list --limit 5", "commit list --repo OWNER/REPO --limit 10", "browse --repo OWNER/REPO". If the user doesn't specify a repo, call "repo list --limit 5" first to find it.
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
      const hasBedrock = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY;
      const skipGemini = process.env.GEMINI_DISABLED === 'true';

      if (hasBedrock) {
        // Bedrock is primary when AWS credentials are present
        try {
          response = await this._callBedrock(onStateChange);
        } catch (bedrockErr) {
          console.warn('[AGENT] Bedrock failed, falling back to Groq:', bedrockErr.message);
          try {
            response = await this._callGroq(onStateChange);
          } catch (groqErr) {
            console.error('[AGENT] Groq also failed:', groqErr.message);
            response = "My thinking is a bit slow right now — try again in a moment.";
          }
        }
      } else {
        // Original Gemini → Groq fallback chain
        try {
          if (skipGemini) throw new Error('Gemini disabled');
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

  // ── Bedrock (Claude 3.5 Haiku) ────────────────────────────────────────────

  async _callBedrock(onStateChange) {
    const region = process.env.AWS_REGION || 'us-east-1';
    const client = new BedrockRuntimeClient({
      region,
      credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const modelId = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

    // Convert TOOL_DEFINITIONS to Bedrock tool format
    const bedrockTools = TOOL_DEFINITIONS.map(t => ({
      toolSpec: {
        name:        t.name,
        description: t.description,
        inputSchema: { json: t.parameters },
      },
    }));

    // Convert history to Bedrock message format
    let messages = this.conversationHistory
      .filter(m => m.role !== 'system')
      .map(m => ({
        role:    m.role === 'assistant' ? 'assistant' : 'user',
        content: [{ text: m.content }],
      }));

    for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
      const cmd = new ConverseCommand({
        modelId,
        system:   [{ text: this._buildSystemPrompt() }],
        messages,
        toolConfig: { tools: bedrockTools },
        inferenceConfig: { maxTokens: 800, temperature: 0.7 },
      });

      const res  = await client.send(cmd);
      const stop = res.stopReason;
      const content = res.output?.message?.content || [];

      if (stop === 'tool_use') {
        const assistantMsg = { role: 'assistant', content };
        const toolResults  = [];

        for (const block of content) {
          if (block.toolUse) {
            const { toolUseId, name, input } = block.toolUse;
            console.log(`[AGENT] Bedrock tool call: ${name}`, input);
            if (onStateChange) onStateChange('thinking', this._toolLabel(name, input));
            const result = await this._executeTool(name, input);
            toolResults.push({
              toolResult: {
                toolUseId,
                content: [{ text: String(result) }],
              },
            });
          }
        }

        messages = [...messages, assistantMsg, { role: 'user', content: toolResults }];
        continue;
      }

      const text = content.find(b => b.text)?.text?.trim();
      if (!text) throw new Error('Empty Bedrock response');
      return text;
    }

    // All iterations used tool calls — return whatever the last tool result was
    const lastUserMsg = messages[messages.length - 1];
    const lastResult  = lastUserMsg?.content?.find?.(b => b.toolResult)?.toolResult?.content?.[0]?.text;
    if (lastResult) return lastResult;
    throw new Error('Bedrock tool loop exceeded max iterations');
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

    // Send a reduced tool set to Groq to stay under the 6k TPM free limit.
    // Tools are grouped: core (always sent) + extras (sent only when keywords match).
    const lastMsg = this.conversationHistory[this.conversationHistory.length - 1]?.content?.toLowerCase() || '';
    const needsExtras = /viva|quiz|remind|clipboard|screen|capture|memory|remember|forget|session|cheat sheet|report|my files|github|repo|commit|pull request|issue|pr|ci/i.test(lastMsg);
    const toolsToSend = needsExtras
      ? toOpenAITools(TOOL_DEFINITIONS)
      : toOpenAITools(TOOL_DEFINITIONS.filter(t =>
          ['readFile','writeFile','runCode','webSearch','openApp','openInVSCode','listDirectory','listMyFiles'].includes(t.name)
        ));

    const baseBody = {
      model:       'llama-3.3-70b-versatile',
      tools:       toolsToSend,
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
        // On rate limit, wait the suggested retry delay then retry (doesn't count as a loop iteration)
        if (res.status === 429) {
          const secMatch = text.match(/try again in ([\d.]+)s/);
          const msMatch  = text.match(/try again in ([\d.]+)ms/);
          let waitMs = 5000;
          if (secMatch) waitMs = Math.ceil(parseFloat(secMatch[1]) * 1000) + 500;
          else if (msMatch) waitMs = Math.ceil(parseFloat(msMatch[1])) + 200;
          console.warn(`[AGENT] Groq 429 — retrying in ${waitMs}ms`);
          await new Promise(r => setTimeout(r, waitMs));
          i--; // don't count this as a tool loop iteration
          continue;
        }
        // On tool_use_failed, try to parse the malformed generation and execute the tool directly
        if (res.status === 400 && text.includes('tool_use_failed')) {
          try {
            const errData = JSON.parse(text);
            const raw = errData?.error?.failed_generation || '';
            // Format: <function=toolName{"arg": "val"}> or <function=toolName {"arg": "val"}>
            const match = raw.match(/<function=(\w+)\s*(\{.*?\})/s);
            if (match) {
              const toolName = match[1];
              const toolArgs = JSON.parse(match[2]);
              console.warn(`[AGENT] tool_use_failed — manually executing ${toolName}`, toolArgs);
              if (onStateChange) onStateChange('thinking', this._toolLabel(toolName, toolArgs));
              const toolResult = await this._executeTool(toolName, toolArgs);
              messages = [...messages, {
                role: 'user',
                content: `Tool ${toolName} returned: ${toolResult}. Now give the user a natural response.`
              }];
              continue;
            }
          } catch (_) {}
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
      githubCli:      ()  => 'checking GitHub\u2026',
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

      console.log(`[AGENT] Tool result (${name}):`, resultStr.slice(0, 200));
      return resultStr;
    } catch (err) {
      console.error(`[AGENT] Tool error (${name}):`, err.message);
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
