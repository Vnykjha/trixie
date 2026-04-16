// tools.js — Trixie agent tools
'use strict';

const fs            = require('fs').promises;
const fsSync        = require('fs');
const path          = require('path');
const os            = require('os');
const { exec }      = require('child_process');
const fetch         = require('node-fetch');
const { saveFact, forgetFact: _forgetFact, listFacts } = require('./memory');
const { clipboard } = require('electron');

// ─── Tool 1: readFile ─────────────────────────────────────────────────────────
async function readFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    if (content.length > 8000) {
      return content.slice(0, 8000) + '\n(truncated)';
    }
    return content;
  } catch (err) {
    return `Could not read file: ${err.message}`;
  }
}

// ─── Tool 2: writeFile ────────────────────────────────────────────────────────
// Detect Desktop — may be under OneDrive on Windows 11
function _detectDesktop() {
  const candidates = [
    'C:\\Users\\vnykj\\OneDrive\\Desktop',
    path.join(os.homedir(), 'OneDrive', 'Desktop'),
    path.join(os.homedir(), 'Desktop'),
  ];
  for (const p of candidates) {
    try { if (fsSync.statSync(p).isDirectory()) return p; } catch (_) {}
  }
  return candidates[0]; // fallback to known path
}
const DESKTOP_PATH = _detectDesktop();
const INDEX_PATH   = path.join(DESKTOP_PATH, 'trixie-files.md');

async function _appendToIndex(filePath) {
  try {
    const name    = path.basename(filePath);
    const date    = new Date().toISOString().slice(0, 10);
    const entry   = `- [${name}](${filePath}) — saved ${date}\n`;
    const header  = '# Files Trixie Made For You\n\n';

    let existing = '';
    try { existing = await fs.readFile(INDEX_PATH, 'utf8'); } catch (_) {}

    if (!existing) {
      await fs.writeFile(INDEX_PATH, header + entry, 'utf8');
    } else if (!existing.includes(filePath)) {
      // Avoid duplicate entries for the same path
      await fs.appendFile(INDEX_PATH, entry, 'utf8');
    }
  } catch (_) {
    // Index update is best-effort; never fail the main write
  }
}

async function writeFile(filePath, content) {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');

    // Auto-index files written to the Desktop (but not the index itself)
    const abs = path.resolve(filePath);
    if (abs.startsWith(DESKTOP_PATH) && abs !== INDEX_PATH) {
      await _appendToIndex(abs);
    }

    return `File written to ${filePath}`;
  } catch (err) {
    return `Could not write file: ${err.message}`;
  }
}

// ─── Tool 3: runCode ──────────────────────────────────────────────────────────
async function runCode(language, code) {
  const ext = (language === 'python') ? '.py' : '.js';
  const cmd = (language === 'python') ? 'python' : 'node';
  const tmpFile = path.join(os.tmpdir(), `trixie_run_${Date.now()}${ext}`);

  try {
    fsSync.writeFileSync(tmpFile, code, 'utf8');

    const output = await new Promise((resolve) => {
      const child = exec(
        `${cmd} "${tmpFile}"`,
        { timeout: 10000, env: {} },
        (err, stdout, stderr) => {
          if (err && err.killed) {
            resolve('Code execution timed out after 10 seconds');
            return;
          }
          const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
          resolve(combined || '(no output)');
        }
      );
      // Belt-and-suspenders timeout
      setTimeout(() => {
        try { child.kill(); } catch (_) {}
      }, 10000);
    });

    const result = output.slice(0, 2000);
    return output.length > 2000 ? result + '\n(truncated)' : result;
  } catch (err) {
    return `Could not run code: ${err.message}`;
  } finally {
    try { fsSync.unlinkSync(tmpFile); } catch (_) {}
  }
}

// ─── Tool 4: webSearch ────────────────────────────────────────────────────────
async function webSearch(query) {
  try {
    const key = process.env.TAVILY_KEY;
    if (!key) return 'Search failed: TAVILY_KEY env var not set';

    const res = await fetch('https://api.tavily.com/search', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        api_key:      key,
        query,
        max_results:  3,
        search_depth: 'basic',
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return `Search failed: HTTP ${res.status} — ${body}`;
    }

    const data = await res.json();
    const results = (data.results || []).slice(0, 3);
    if (!results.length) return 'No results found.';

    return results
      .map((r, i) => `${i + 1}. ${r.title}: ${r.content || r.snippet || ''}`.trim())
      .join('\n');
  } catch (err) {
    return `Search failed: ${err.message}`;
  }
}

// ─── Tool 5: openApp ──────────────────────────────────────────────────────────
// UWP/Store apps use Windows URI schemes; traditional apps use their exe name.
const APP_MAP = {
  // Traditional apps
  chrome:        'chrome',
  firefox:       'firefox',
  notepad:       'notepad',
  vscode:        'code',
  code:          'code',
  explorer:      'explorer',
  terminal:      'wt',
  wordpad:       'wordpad',
  paint:         'mspaint',
  // UWP apps — opened via Windows URI scheme (start <uri>)
  camera:        'microsoft.windows.camera:',
  calculator:    'ms-calculator:',
  calc:          'ms-calculator:',
  photos:        'ms-photos:',
  settings:      'ms-settings:',
  store:         'ms-windows-store:',
  maps:          'bingmaps:',
  mail:          'ms-outlook:',
  calendar:      'outlookcal:',
  clock:         'ms-clock:',
  weather:       'msnweather:',
  news:          'msn-news:',
  spotify:       'spotify:',
  teams:         'msteams:',
  whatsapp:      'whatsapp:',
  discord:       'discord:',
  xbox:          'xbox:',
  // Snipping tool / screen snip
  snip:          'ms-screensketch:',
  'snipping tool': 'ms-screensketch:',
};

// Common websites — opened in Chrome
const WEBSITE_MAP = {
  youtube:    'https://www.youtube.com',
  gmail:      'https://mail.google.com',
  google:     'https://www.google.com',
  github:     'https://www.github.com',
  stackoverflow: 'https://stackoverflow.com',
  reddit:     'https://www.reddit.com',
  twitter:    'https://www.twitter.com',
  x:          'https://www.x.com',
  instagram:  'https://www.instagram.com',
  facebook:   'https://www.facebook.com',
  linkedin:   'https://www.linkedin.com',
  whatsapp:   'https://web.whatsapp.com',
  netflix:    'https://www.netflix.com',
  amazon:     'https://www.amazon.in',
  chatgpt:    'https://chat.openai.com',
  drive:      'https://drive.google.com',
  docs:       'https://docs.google.com',
  maps:       'https://maps.google.com',
  meet:       'https://meet.google.com',
};

async function _openInChrome(url) {
  return new Promise((resolve, reject) => {
    // Try Chrome executable paths common on Windows
    const chromePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `C:\\Users\\vnykj\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`,
    ];
    const chromePath = chromePaths.find(p => {
      try { require('fs').accessSync(p); return true; } catch (_) { return false; }
    }) || 'chrome';
    exec(`"${chromePath}" "${url}"`, { shell: true }, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

async function openApp(nameOrUrl) {
  try {
    // Check website map first — open in Chrome
    const siteUrl = WEBSITE_MAP[nameOrUrl.toLowerCase()];
    if (siteUrl) {
      await _openInChrome(siteUrl);
      return `Opened ${nameOrUrl} in Chrome`;
    }

    if (nameOrUrl.startsWith('http://') || nameOrUrl.startsWith('https://')) {
      await _openInChrome(nameOrUrl);
      return `Opened ${nameOrUrl} in Chrome`;
    }

    // Handle "code filepath" — open a file in VS Code
    if (nameOrUrl.toLowerCase().startsWith('code ')) {
      const filePath = nameOrUrl.slice(5).trim().replace(/^"|"$/g, '');
      await new Promise((resolve, reject) => {
        exec(`code "${filePath}"`, { shell: true }, (err) => {
          if (err) reject(err); else resolve();
        });
      });
      return `Opened ${filePath} in VS Code`;
    }

    const cmd = APP_MAP[nameOrUrl.toLowerCase()] || nameOrUrl;
    await new Promise((resolve, reject) => {
      let shellCmd;
      if (process.platform === 'win32') {
        shellCmd = `start "" "${cmd}"`;
      } else if (process.platform === 'darwin') {
        shellCmd = `open -a "${cmd}"`;
      } else {
        shellCmd = `xdg-open "${cmd}"`;
      }
      exec(shellCmd, { shell: true }, (err) => {
        if (err) reject(err); else resolve();
      });
    });
    return `Opened ${nameOrUrl}`;
  } catch (err) {
    return `Could not open ${nameOrUrl}: ${err.message}`;
  }
}

// 'open' is an ESM-only package; load it via dynamic import
let _openCache = null;
async function loadOpen() {
  if (_openCache) return _openCache;
  const mod = await import('open');
  _openCache = mod.default;
  return _openCache;
}

// ─── Tool 6: listDirectory ────────────────────────────────────────────────────
async function listDirectory(dirPath) {
  const target = dirPath || process.cwd();
  try {
    const entries = await fs.readdir(target, { withFileTypes: true });
    if (!entries.length) return `(empty directory: ${target})`;

    const lines = entries.map((e) => {
      const type = e.isDirectory() ? 'folder' : 'file';
      return `  [${type}] ${e.name}`;
    });

    return `Contents of ${target}:\n${lines.join('\n')}`;
  } catch (err) {
    return `Could not list directory: ${err.message}`;
  }
}

// ─── Tool definitions (JSON Schema for LLM) ───────────────────────────────────
const TOOL_DEFINITIONS = [
  {
    name:        'readFile',
    description: 'Read the contents of a file at the given path. Returns up to 8000 characters.',
    parameters:  {
      type:       'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute or relative path to the file.' },
      },
      required: ['filePath'],
    },
  },
  {
    name:        'writeFile',
    description: 'Write a string to a file, creating parent directories as needed.',
    parameters:  {
      type:       'object',
      properties: {
        filePath: { type: 'string', description: 'Destination file path.' },
        content:  { type: 'string', description: 'Text content to write.' },
      },
      required: ['filePath', 'content'],
    },
  },
  {
    name:        'runCode',
    description: 'Execute a snippet of Python or JavaScript code and return stdout/stderr (max 2000 chars, 10s timeout).',
    parameters:  {
      type:       'object',
      properties: {
        language: {
          type:        'string',
          enum:        ['python', 'javascript', 'node'],
          description: 'The programming language to use.',
        },
        code: { type: 'string', description: 'The source code to execute.' },
      },
      required: ['language', 'code'],
    },
  },
  {
    name:        'webSearch',
    description: 'Search the web via Tavily and return the top 3 results with titles and snippets.',
    parameters:  {
      type:       'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
      },
      required: ['query'],
    },
  },
  {
    name:        'openApp',
    description: 'Open a website or launch any application. For websites, pass the site name (e.g. "youtube", "gmail", "github", "reddit", "netflix", "chatgpt") — they open in Chrome. For URLs pass the full http/https link. For apps pass the name: camera, calculator, spotify, discord, whatsapp, teams, terminal, notepad, paint, vscode, explorer, and more.',
    parameters:  {
      type:       'object',
      properties: {
        nameOrUrl: {
          type:        'string',
          description: 'A URL (starting with http/https) or a common app name (e.g. "camera", "calculator", "spotify", "notepad").',
        },
      },
      required: ['nameOrUrl'],
    },
  },
  {
    name:        'listDirectory',
    description: 'List files and folders in a directory. Defaults to the current working directory.',
    parameters:  {
      type:       'object',
      properties: {
        dirPath: {
          type:        'string',
          description: 'Path to the directory to list. Omit to use the current working directory.',
        },
      },
      required: [],
    },
  },
];

// ─── Tool 7: rememberFact ─────────────────────────────────────────────────────
async function rememberFact(key, value) {
  const slug = saveFact(key, value);
  return `Remembered: "${value}" (saved as "${slug}")`;
}

// ─── Tool 8: forgetFact ───────────────────────────────────────────────────────
async function forgetFact(key) {
  const removed = _forgetFact(key);
  return removed ? `Forgot: "${key}"` : `No memory found for "${key}"`;
}

// ─── Tool 9: recallMemory ─────────────────────────────────────────────────────
async function recallMemory() {
  const facts = listFacts();
  const entries = Object.entries(facts);
  if (!entries.length) return 'No memories saved yet.';
  return entries.map(([k, v]) => `${k}: ${v.value}`).join('\n');
}

// Patch TOOL_DEFINITIONS with new tools
TOOL_DEFINITIONS.push(
  {
    name:        'rememberFact',
    description: 'Save a fact about the student to persistent memory so Trixie can recall it in future sessions.',
    parameters:  {
      type:       'object',
      properties: {
        key:   { type: 'string', description: 'Short identifier slug, e.g. "os_exam_date".' },
        value: { type: 'string', description: 'The fact to remember, e.g. "OS exam is on Thursday".' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name:        'forgetFact',
    description: 'Remove a previously saved memory fact by its key.',
    parameters:  {
      type:       'object',
      properties: {
        key: { type: 'string', description: 'The key slug of the fact to forget.' },
      },
      required: ['key'],
    },
  },
  {
    name:        'recallMemory',
    description: 'List all facts currently saved in the student memory store.',
    parameters:  { type: 'object', properties: {}, required: [] },
  },
);

// ─── Tool 10: readClipboard ───────────────────────────────────────────────────
async function readClipboard() {
  try {
    const text = clipboard.readText();
    if (!text) return '(clipboard is empty)';
    return text.length > 4000 ? text.slice(0, 4000) + '\n(truncated)' : text;
  } catch (err) {
    return `Could not read clipboard: ${err.message}`;
  }
}

// ─── Tool 11: writeClipboard ──────────────────────────────────────────────────
async function writeClipboard(text) {
  try {
    clipboard.writeText(text);
    return `Copied to clipboard (${text.length} chars)`;
  } catch (err) {
    return `Could not write clipboard: ${err.message}`;
  }
}

TOOL_DEFINITIONS.push(
  {
    name:        'readClipboard',
    description: 'Read the current text content of the system clipboard. Use this when the student says "explain what I just copied" or "look at my clipboard".',
    parameters:  { type: 'object', properties: {}, required: [] },
  },
  {
    name:        'writeClipboard',
    description: 'Write text to the system clipboard so the student can paste it.',
    parameters:  {
      type:       'object',
      properties: {
        text: { type: 'string', description: 'The text to copy to clipboard.' },
      },
      required: ['text'],
    },
  },
);

// ─── Tool 12: setReminder ─────────────────────────────────────────────────────
// main.js injects the speak callback so tools.js doesn't import voice-out directly.
let _speakFn = null;
function setSpeakCallback(fn) { _speakFn = fn; }

async function setReminder(message, delayMinutes) {
  const ms = Math.max(1, Number(delayMinutes) || 1) * 60 * 1000;
  setTimeout(async () => {
    if (_speakFn) {
      await _speakFn(`Reminder: ${message}`).catch(() => {});
    } else {
      console.log(`[REMINDER] ${message}`);
    }
  }, ms);
  const when = delayMinutes === 1 ? 'in 1 minute' : `in ${delayMinutes} minutes`;
  return `Got it! I'll remind you ${when}: "${message}"`;
}

TOOL_DEFINITIONS.push({
  name:        'setReminder',
  description: 'Set a spoken reminder that fires after a delay. Use when the student says "remind me to X in Y minutes".',
  parameters:  {
    type:       'object',
    properties: {
      message:      { type: 'string',  description: 'What to remind the student about.' },
      delayMinutes: { type: 'number',  description: 'How many minutes from now to fire the reminder.' },
    },
    required: ['message', 'delayMinutes'],
  },
});

// ─── Tool 13: captureScreen ───────────────────────────────────────────────────
// The actual capture happens in the renderer (desktopCapturer is renderer-only).
// main.js wires up the callback via setScreenCaptureRequester below.
let _screenCaptureRequester = null;

function setScreenCaptureRequester(fn) {
  _screenCaptureRequester = fn;
}

async function captureScreen(question) {
  if (!_screenCaptureRequester) {
    return 'Screen capture not yet initialised — try again in a moment.';
  }
  try {
    const dataURL = await _screenCaptureRequester();
    // dataURL is a base64 PNG data URL; pass the raw base64 + the question to Gemini vision
    return JSON.stringify({ type: 'screenshot', dataURL, question: question || 'Describe what is on screen.' });
  } catch (err) {
    return `Screen capture failed: ${err.message}`;
  }
}

TOOL_DEFINITIONS.push({
  name:        'captureScreen',
  description: 'Take a screenshot of the student\'s screen and answer a visual question about it. Use when they say "explain what\'s on my screen", "what does this error say", or "look at my screen".',
  parameters:  {
    type:       'object',
    properties: {
      question: { type: 'string', description: 'The visual question to answer about the screenshot.' },
    },
    required: [],
  },
});

// ─── Tool 14: listMyFiles ─────────────────────────────────────────────────────
async function listMyFiles() {
  try {
    const raw = await fs.readFile(INDEX_PATH, 'utf8');
    const lines = raw
      .split('\n')
      .filter((l) => l.startsWith('- ['))
      .map((l) => {
        // Extract filename from markdown link: - [name](path) — saved DATE
        const m = l.match(/^- \[([^\]]+)\]\(([^)]+)\) — saved (.+)$/);
        return m ? `${m[1]} (saved ${m[3]})` : l;
      });
    if (!lines.length) return 'No files saved yet.';
    return `I've saved these files to your Desktop:\n${lines.join('\n')}`;
  } catch (_) {
    return "I haven't saved any files to your Desktop yet.";
  }
}

TOOL_DEFINITIONS.push({
  name:        'listMyFiles',
  description: "List all files Trixie has previously saved to the student's Desktop. Use when they ask 'what files have you made for me?' or 'show me my cheat sheets'.",
  parameters:  { type: 'object', properties: {}, required: [] },
});

// ─── Tool 15: openInVSCode ────────────────────────────────────────────────────
async function openInVSCode(fileName) {
  try {
    // If it's just a filename (no path), look on Desktop first
    let filePath = fileName;
    if (!path.isAbsolute(fileName) && !fileName.includes('/') && !fileName.includes('\\')) {
      filePath = path.join(DESKTOP_PATH, fileName);
    }
    await new Promise((resolve, reject) => {
      exec(`code "${filePath}"`, { shell: true }, (err) => {
        if (err) reject(err); else resolve();
      });
    });
    return `Opened ${filePath} in VS Code`;
  } catch (err) {
    return `Could not open in VS Code: ${err.message}`;
  }
}

TOOL_DEFINITIONS.push({
  name:        'openInVSCode',
  description: 'Open a file in Visual Studio Code. Use when the student says "open [file] in VS Code" or "open [file] in visual studio". Pass just the filename if it is on the Desktop.',
  parameters:  {
    type:       'object',
    properties: {
      fileName: { type: 'string', description: 'The filename (e.g. "DFS_in_C.txt") or full path to open in VS Code.' },
    },
    required: ['fileName'],
  },
});

// ─── Browser (Playwright) ─────────────────────────────────────────────────────
let _browser = null;
let _page    = null;

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `C:\\Users\\vnykj\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`,
];

async function _getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  const { chromium } = require('playwright-core');
  const executablePath = CHROME_PATHS.find(p => {
    try { fsSync.accessSync(p); return true; } catch (_) { return false; }
  });
  _browser = await chromium.launch({
    headless:   false,
    executablePath,
    args:       ['--start-maximized'],
  });
  _browser.on('disconnected', () => { _browser = null; _page = null; });
  return _browser;
}

async function _getPage() {
  const browser = await _getBrowser();
  if (!_page || _page.isClosed()) {
    const ctx = await browser.newContext({ viewport: null });
    _page = await ctx.newPage();
  }
  return _page;
}

async function browserNavigate(url) {
  try {
    // Resolve site names to full URLs
    const siteUrl = WEBSITE_MAP[url.toLowerCase()] || url;
    const finalUrl = siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`;
    const page = await _getPage();
    await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const title = await page.title();
    return `Opened ${title} (${finalUrl})`;
  } catch (err) {
    return `Browser navigate failed: ${err.message}`;
  }
}

async function browserAction(action, selector, value) {
  try {
    const page = await _getPage();
    if (action === 'click') {
      await page.click(selector, { timeout: 8000 });
      return `Clicked ${selector}`;
    }
    if (action === 'type') {
      await page.fill(selector, value || '', { timeout: 8000 });
      return `Typed into ${selector}`;
    }
    if (action === 'search') {
      // Smart search: detect current site and use its search URL
      const currentUrl = page.url();
      let searchUrl;
      if (currentUrl.includes('youtube.com')) {
        searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(value)}`;
      } else if (currentUrl.includes('github.com')) {
        searchUrl = `https://github.com/search?q=${encodeURIComponent(value)}`;
      } else if (currentUrl.includes('reddit.com')) {
        searchUrl = `https://www.reddit.com/search/?q=${encodeURIComponent(value)}`;
      } else {
        searchUrl = `https://www.google.com/search?q=${encodeURIComponent(value)}`;
      }
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const title = await page.title();
      return `Searched for "${value}" — page: ${title}`;
    }
    if (action === 'read') {
      const text = await page.innerText('body');
      return text.slice(0, 3000);
    }
    if (action === 'screenshot') {
      const buf = await page.screenshot({ type: 'png' });
      return `Screenshot taken (${buf.length} bytes)`;
    }
    return `Unknown action: ${action}`;
  } catch (err) {
    return `Browser action failed: ${err.message}`;
  }
}

TOOL_DEFINITIONS.push({
  name:        'browserNavigate',
  description: 'Open a URL or website name in Chrome using Playwright. Use this instead of openApp for any website. Pass a site name like "youtube", "gmail", "github" or a full URL. Always use this when the user wants to open a website.',
  parameters:  {
    type:       'object',
    properties: {
      url: { type: 'string', description: 'A website name (e.g. "youtube", "gmail") or full URL (e.g. "https://example.com").' },
    },
    required: ['url'],
  },
});

TOOL_DEFINITIONS.push({
  name:        'browserAction',
  description: 'Control the browser: click elements, type text, search Google, or read page content. Use after browserNavigate. Actions: "click" (pass selector), "type" (pass selector + value), "search" (pass value = search query), "read" (returns page text).',
  parameters:  {
    type:       'object',
    properties: {
      action:   { type: 'string', enum: ['click', 'type', 'search', 'read', 'screenshot'], description: 'What to do in the browser.' },
      selector: { type: 'string', description: 'CSS selector or text selector for click/type actions. E.g. "input[name=q]" or "text=Sign in".' },
      value:    { type: 'string', description: 'Text to type, or search query for the "search" action.' },
    },
    required: ['action'],
  },
});

// ─── Tool 16: githubCli ───────────────────────────────────────────────────────
// Runs safe, read-only (and open-in-browser) gh CLI subcommands.
// Write/destructive commands are blocked by allowlist.

const GH_ALLOWED = new Set([
  'repo list', 'repo view', 'pr list', 'pr view', 'pr status',
  'issue list', 'issue view', 'commit list', 'run list', 'run view',
  'release list', 'release view', 'browse',
]);

function _ghAllowed(subcommand) {
  // subcommand is e.g. "repo list", "pr list --limit 5", "browse"
  const base = subcommand.trim().split(/\s+/).slice(0, 2).join(' ');
  const baseSingle = subcommand.trim().split(/\s+/)[0];
  return GH_ALLOWED.has(base) || GH_ALLOWED.has(baseSingle);
}

async function githubCli(subcommand) {
  // Check gh is installed
  const ghAvailable = await new Promise(resolve => {
    exec('gh --version', { shell: true }, (err) => resolve(!err));
  });
  if (!ghAvailable) {
    return 'GitHub CLI (gh) is not installed. Download it from https://cli.github.com and run "gh auth login".';
  }

  if (!_ghAllowed(subcommand)) {
    return `Command "gh ${subcommand}" is not permitted — only read/browse commands are allowed.`;
  }

  return new Promise(resolve => {
    exec(`gh ${subcommand}`, { shell: true, timeout: 15000 }, (err, stdout, stderr) => {
      const out = (stdout || '').trim();
      const errOut = (stderr || '').trim();
      if (err && !out) {
        // Common: not authenticated
        if (errOut.includes('auth') || errOut.includes('login')) {
          resolve('Not authenticated with GitHub. Run "gh auth login" in a terminal first.');
        } else {
          resolve(`gh error: ${errOut || err.message}`);
        }
        return;
      }
      const result = out || errOut;
      resolve(result.length > 3000 ? result.slice(0, 3000) + '\n(truncated)' : result);
    });
  });
}

TOOL_DEFINITIONS.push({
  name:        'githubCli',
  description: `Run a GitHub CLI command to answer questions about the user's repos, PRs, commits, issues, and releases.
Examples of subcommands to pass:
- "repo list --limit 5" → list recent repos
- "repo view OWNER/REPO" → repo details
- "commit list --repo OWNER/REPO --limit 10" → recent commits
- "pr list --repo OWNER/REPO" → open pull requests
- "issue list --repo OWNER/REPO" → open issues
- "browse --repo OWNER/REPO" → open repo in browser
- "run list --repo OWNER/REPO" → CI/CD workflow runs
Use when the user asks about their GitHub repos, commits, PRs, issues, or wants to open a repo in the browser.`,
  parameters: {
    type:       'object',
    properties: {
      subcommand: {
        type:        'string',
        description: 'The gh subcommand and flags to run, e.g. "repo list --limit 5" or "commit list --repo owner/repo --limit 10".',
      },
    },
    required: ['subcommand'],
  },
});

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  readFile,
  writeFile,
  runCode,
  webSearch,
  openApp,
  openInVSCode,
  listDirectory,
  rememberFact,
  forgetFact,
  recallMemory,
  readClipboard,
  writeClipboard,
  setReminder,
  listMyFiles,
  captureScreen,
  browserNavigate,
  browserAction,
  githubCli,
  setScreenCaptureRequester,
  setSpeakCallback,
  TOOL_DEFINITIONS,
  _DESKTOP_PATH: DESKTOP_PATH,
};
