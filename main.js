require('dotenv').config();
const { app, BrowserWindow, globalShortcut, screen, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const { voiceInput, startWakeWordDetection } = require('./src/voice-in');
const { agent } = require('./src/agent');
const { voiceOut, listSAPIVoices, saveSAPIVoice, setIpc } = require('./src/voice-out');
const { setScreenCaptureRequester, setSpeakCallback } = require('./src/tools');

let win;

// ─── Window position persistence ─────────────────────────────────────────────
const POS_FILE = path.join(app.getPath('userData'), 'window-pos.json');

function loadPos(sw, sh, winWidth, winHeight, margin) {
  try {
    const saved = JSON.parse(fs.readFileSync(POS_FILE, 'utf8'));
    const x = Math.max(0, Math.min(saved.x, sw - winWidth));
    const y = Math.max(0, Math.min(saved.y, sh - winHeight));
    return { x, y };
  } catch (_) {
    return { x: sw - winWidth - margin, y: sh - winHeight - margin };
  }
}

function savePos() {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  try { fs.writeFileSync(POS_FILE, JSON.stringify({ x, y })); } catch (_) {}
}


function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  const winWidth = 320;
  const winHeight = 420;
  const margin = 16;

  const { x, y } = loadPos(sw, sh, winWidth, winHeight, margin);

  win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x,
    y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('moved', savePos);
}

// ─── Renderer IPC helpers ─────────────────────────────────────────────────────
function sendToRenderer(channel, data) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}

// ─── Agent ────────────────────────────────────────────────────────────────────
async function processWithAgent(transcript) {
  sendToRenderer('state-change', { state: 'thinking', amplitude: 0 });

  try {
    const response = await agent.processMessage(transcript, (state, label) => {
      sendToRenderer('state-change', { state, amplitude: 0, label });
    });

    console.log('[TRIXIE RESPONSE]', response);
    sendToRenderer('agent-response', { text: response });

    // Speak the response
    sendToRenderer('state-change', { state: 'speaking', amplitude: 0 });
    await voiceOut.speak(response, (amplitude) => {
      sendToRenderer('state-change', { state: 'speaking', amplitude });
    });
    sendToRenderer('state-change', { state: 'idle', amplitude: 0 });
  } catch (err) {
    console.error('[AGENT ERROR]', err.message);
    const errMsg = "My thinking is a bit slow right now — try again in a moment.";
    sendToRenderer('state-change', { state: 'error', amplitude: 0 });
    sendToRenderer('agent-response', { text: errMsg });
    await voiceOut.speak(errMsg).catch(() => {});
    sendToRenderer('state-change', { state: 'idle', amplitude: 0 });
  }
}

// ─── Voice event wiring ───────────────────────────────────────────────────────
function triggerListening() {
  voiceOut.stop();
  sendToRenderer('state-change', { state: 'listening', amplitude: 0 });
  voiceInput.startListening();
}

voiceInput.on('wake', () => {
  triggerListening();
});

voiceInput.on('transcript', (text) => {
  console.log('[TRANSCRIPT]', text);
  sendToRenderer('state-change', { state: 'idle', amplitude: 0 });
  sendToRenderer('transcript', text);
  processWithAgent(text);
});

voiceInput.on('error', (msg) => {
  console.error('[MIC ERROR]', msg);
  sendToRenderer('state-change', { state: 'error', amplitude: 0 });
  sendToRenderer('transcript', 'Mic not available — check SoX install');
});

voiceInput.on('transcription-error', async (msg) => {
  console.error('[WHISPER ERROR]', msg);
  const retryMsg = "I didn't catch that — could you try again?";
  sendToRenderer('state-change', { state: 'error', amplitude: 0 });
  sendToRenderer('agent-response', { text: retryMsg });
  await voiceOut.speak(retryMsg).catch(() => {});
  sendToRenderer('state-change', { state: 'idle', amplitude: 0 });
});

// ─── Window toggle ────────────────────────────────────────────────────────────
function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
  }
}

// ─── SAPI voice picker ────────────────────────────────────────────────────────
// Runs once at startup when ElevenLabs is not configured and no SAPI_VOICE is saved.
async function maybePickSAPIVoice() {
  if (process.env.ELEVENLABS_KEY && process.env.ELEVENLABS_VOICE_ID) return; // EL configured
  if (process.env.SAPI_VOICE) return;                                          // already picked

  const voices = await listSAPIVoices();
  if (!voices.length) return; // no SAPI voices found — nothing to pick

  const { response } = await dialog.showMessageBox(win, {
    type:     'question',
    title:    'Pick a Trixie voice',
    message:  'No ElevenLabs voice is set. Which SAPI voice should Trixie use?',
    buttons:  [...voices.slice(0, 9), 'Cancel'], // dialog max ~9 buttons
    defaultId: 0,
    cancelId: voices.slice(0, 9).length,
  });

  if (response < voices.slice(0, 9).length) {
    const chosen = voices[response];
    const envPath = path.join(__dirname, '.env');
    saveSAPIVoice(chosen, envPath);
    console.log('[VOICE-OUT] SAPI voice set to:', chosen);
  }
}

app.whenReady().then(async () => {
  createWindow();

  // Wait for window to finish loading before showing any dialogs
  win.webContents.once('did-finish-load', () => {
    maybePickSAPIVoice().catch((e) => console.warn('[VOICE PICKER]', e.message));
  });

  startWakeWordDetection();

  globalShortcut.register('Control+Space', () => {
    if (win && win.isVisible()) {
      triggerListening();
    } else {
      toggleWindow();
    }
  });

  // Ctrl+Shift+S — stop / interrupt current audio output
  const stopRegistered = globalShortcut.register('Control+Shift+S', () => {
    console.log('[SHORTCUT] Ctrl+Shift+S fired — stopping audio');
    voiceOut.stop();
    sendToRenderer('state-change', { state: 'idle', amplitude: 0 });
  });
  console.log('[SHORTCUT] Ctrl+Shift+S registered:', stopRegistered);

  // Ctrl+D — demo mode: explain main.js
  globalShortcut.register('Control+D', () => {
    console.log('[DEMO] Demo mode triggered');
    sendToRenderer('transcript', 'explain the main.js file');
    setTimeout(() => {
      processWithAgent('explain the main.js file');
    }, 1000);
  });

  // Ctrl+B — bypass mode: hardcoded demo question
  globalShortcut.register('Control+B', () => {
    const demoQ = 'What is a binary search tree?';
    console.log('[BYPASS] Sending hardcoded question:', demoQ);
    sendToRenderer('transcript', demoQ);
    processWithAgent(demoQ);
  });

  // Chat message from renderer text input
  ipcMain.on('chat-message', (_event, text) => {
    console.log('[CHAT]', text);
    sendToRenderer('transcript', text);
    processWithAgent(text);
  });

  // Forward toggle-window IPC from renderer to the toggle logic
  ipcMain.on('toggle-window', () => toggleWindow());

  // ── Real amplitude bridge ───────────────────────────────────────────────────
  // Give voice-out.js the ability to push audio bytes to the renderer and
  // receive computed RMS values back, without a circular require.
  setIpc(
    (channel, data) => sendToRenderer(channel, data),
    (channel, fn) => {
      ipcMain.on(channel, (_event, value) => fn(value));
      return () => ipcMain.removeListener(channel, fn);
    },
  );

  // ── Reminder speak bridge ──────────────────────────────────────────────────
  // setReminder in tools.js needs to speak — give it a callback that goes through
  // the full speak pipeline (state-change + voiceOut) without a circular require.
  setSpeakCallback(async (text) => {
    sendToRenderer('state-change', { state: 'speaking', amplitude: 0 });
    sendToRenderer('agent-response', { text });
    await voiceOut.speak(text, (amplitude) => {
      sendToRenderer('state-change', { state: 'speaking', amplitude });
    });
    sendToRenderer('state-change', { state: 'idle', amplitude: 0 });
  });

  // ── Screen capture bridge ───────────────────────────────────────────────────
  // Tools run in the main process but desktopCapturer only works in renderer.
  // We give tools.js a callback that sends 'do-capture' to the renderer and
  // waits (with a 10s timeout) for the 'capture-result' reply.
  setScreenCaptureRequester(() => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Screen capture timed out')), 10000);

    ipcMain.once('capture-result', (_event, payload) => {
      clearTimeout(timer);
      if (payload.error) {
        reject(new Error(payload.error));
      } else {
        resolve(payload.dataURL);
      }
    });

    sendToRenderer('do-capture', {});
  }));
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  savePos();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
