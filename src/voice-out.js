// voice-out.js — text-to-speech via ElevenLabs with Windows SAPI fallback
'use strict';

const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const { exec }  = require('child_process');
const fetch     = require('node-fetch');
const player    = require('play-sound')({});

// Injected by main.js so voice-out can push/receive IPC without a circular dep.
let _ipcSend = null; // (channel, data) => void
let _ipcOn   = null; // (channel, fn) => removeListener fn
function setIpc(sendFn, onFn) { _ipcSend = sendFn; _ipcOn = onFn; }

class VoiceOut {
  constructor() {
    this._speaking      = false;
    this._currentProc   = null;
    this._sapiProc      = null;
    this._elQuotaDead   = false; // true once ElevenLabs returns quota_exceeded
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  stop() {
    console.log('[VOICE-OUT] stop() called, speaking:', this._speaking);
    if (this._currentProc) {
      try { this._currentProc.kill('SIGKILL'); } catch (_) {}
      this._currentProc = null;
    }
    if (this._sapiProc) {
      try { exec(`taskkill /PID ${this._sapiProc.pid} /T /F`); } catch (_) {}
      this._sapiProc = null;
    }
    // Stop Web Audio playback in renderer (ElevenLabs path)
    if (_ipcSend) _ipcSend('audio-decode-stop', null);
    this._speaking = false;
  }

  async speak(text, onAmplitude) {
    if (this._speaking) return;
    this._speaking = true;

    try {
      const key      = process.env.ELEVENLABS_KEY;
      const voiceId  = process.env.ELEVENLABS_VOICE_ID;

      if (key && voiceId && !this._elQuotaDead) {
        try {
          await this._speakElevenLabs(text, key, voiceId, onAmplitude);
          return;
        } catch (err) {
          console.warn('[VOICE-OUT] ElevenLabs failed, falling back to SAPI:', err.message);
        }
      }

      await this._speakSAPI(text);
    } finally {
      this._speaking = false;
      if (onAmplitude) onAmplitude(0);
    }
  }

  // ── ElevenLabs ─────────────────────────────────────────────────────────────

  async _speakElevenLabs(text, key, voiceId, onAmplitude) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;

    const res = await fetch(url, {
      method:  'POST',
      headers: {
        'xi-api-key':   key,
        'Content-Type': 'application/json',
        'Accept':       'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability:       0.4,
          similarity_boost: 0.8,
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ElevenLabs ${res.status}: ${body}`);
    }

    // Stream response body into a temp .mp3 file
    const tmpPath = path.join(os.tmpdir(), `trixie_tts_${Date.now()}.mp3`);
    await new Promise((resolve, reject) => {
      const dest = fs.createWriteStream(tmpPath);
      res.body.pipe(dest);
      res.body.on('error', reject);
      dest.on('finish', resolve);
      dest.on('error', reject);
    });

    // Play file and pulse amplitude during playback — always clean up temp file
    try {
      await this._playWithAmplitude(tmpPath, onAmplitude);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  }

  // ── Playback + real amplitude via Web Audio API in renderer ──────────────

  _playWithAmplitude(filePath, onAmplitude) {
    return new Promise((resolve) => {
      if (!_ipcSend || !_ipcOn) {
        // No IPC available — nothing to play, just resolve
        resolve();
        return;
      }

      // Send raw MP3 bytes to renderer; Chromium plays it via Web Audio
      const audioBytes = fs.readFileSync(filePath);
      _ipcSend('audio-decode', audioBytes.buffer);

      // Forward RMS amplitude values back to the animation callback
      let removeAmplitude = null;
      if (onAmplitude) {
        removeAmplitude = _ipcOn('audio-amplitude', (rms) => {
          onAmplitude(rms);
        });
      }

      // Renderer fires 'audio-amplitude' with value -1 when playback ends
      const removeDone = _ipcOn('audio-amplitude', (rms) => {
        if (rms !== -1) return;
        cleanup();
        resolve();
      });

      const cleanup = () => {
        if (removeAmplitude) { removeAmplitude(); removeAmplitude = null; }
        if (removeDone)      { removeDone();      }
        if (_ipcSend)        { _ipcSend('audio-decode-stop', null); }
        if (onAmplitude)     { onAmplitude(0); }
      };
    });
  }

  // ── Windows SAPI fallback ──────────────────────────────────────────────────

  _speakSAPI(text) {
    // Pass text and voice name via env vars — no user content touches the command string.
    const selectVoice = process.env.SAPI_VOICE
      ? '$s.SelectVoice($env:SAPI_VOICE); '
      : '';
    const cmd = `powershell -Command "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ${selectVoice}$s.Speak($env:TRIXIE_TEXT)"`;

    return new Promise((resolve, reject) => {
      const proc = exec(cmd, { timeout: 30000, env: { ...process.env, TRIXIE_TEXT: text } }, () => {
        this._sapiProc = null;
        resolve(); // always resolve — stop() kills externally, errors here are non-critical
      });
      this._sapiProc = proc;
    });
  }
}

// ─── SAPI voice helpers ───────────────────────────────────────────────────────

// Returns an array of installed SAPI voice name strings.
function listSAPIVoices() {
  return new Promise((resolve) => {
    const cmd = `powershell -Command "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name } | Out-String"`;
    exec(cmd, { timeout: 10000 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      const voices = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      resolve(voices);
    });
  });
}

// Persist the chosen voice name to .env so it survives restarts.
function saveSAPIVoice(voiceName, envPath) {
  try {
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    if (/^SAPI_VOICE=/m.test(content)) {
      content = content.replace(/^SAPI_VOICE=.*/m, `SAPI_VOICE=${voiceName}`);
    } else {
      content += (content.endsWith('\n') || !content ? '' : '\n') + `SAPI_VOICE=${voiceName}\n`;
    }
    fs.writeFileSync(envPath, content, 'utf8');
    process.env.SAPI_VOICE = voiceName;
  } catch (err) {
    console.warn('[VOICE-OUT] Could not save SAPI_VOICE to .env:', err.message);
  }
}

// ─── Export singleton ─────────────────────────────────────────────────────────
const voiceOut = new VoiceOut();
module.exports = { voiceOut, listSAPIVoices, saveSAPIVoice, setIpc };
