// voice-in.js — microphone capture + Whisper transcription
'use strict';

const { EventEmitter } = require('events');
const Mic              = require('mic');
const fs               = require('fs');
const path             = require('path');
const os               = require('os');
const FormData         = require('form-data');
const fetch            = require('node-fetch');

// ─── WAV helpers ──────────────────────────────────────────────────────────────

// Amplify 16-bit PCM by a gain factor (clamped to prevent clipping)
function amplifyPcm(buf, gain) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const sample = Math.max(-32768, Math.min(32767, Math.round(buf.readInt16LE(i) * gain)));
    out.writeInt16LE(sample, i);
  }
  return out;
}

// Writes raw 16-bit signed PCM + a minimal WAV header so Whisper accepts it.
function buildWav(pcmBuffer, sampleRate = 16000, channels = 1, bitDepth = 16) {
  const dataSize   = pcmBuffer.length;
  const byteRate   = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const header     = Buffer.alloc(44);

  header.write('RIFF',                  0);
  header.writeUInt32LE(36 + dataSize,   4);
  header.write('WAVE',                  8);
  header.write('fmt ',                 12);
  header.writeUInt32LE(16,             16); // PCM chunk size
  header.writeUInt16LE(1,              20); // PCM format
  header.writeUInt16LE(channels,       22);
  header.writeUInt32LE(sampleRate,     24);
  header.writeUInt32LE(byteRate,       28);
  header.writeUInt16LE(blockAlign,     32);
  header.writeUInt16LE(bitDepth,       34);
  header.write('data',                 36);
  header.writeUInt32LE(dataSize,       40);

  return Buffer.concat([header, pcmBuffer]);
}

// RMS energy of a 16-bit PCM chunk
function rms(chunk) {
  let sum = 0;
  for (let i = 0; i + 1 < chunk.length; i += 2) {
    const sample = chunk.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / (chunk.length / 2));
}

// ─── Constants ────────────────────────────────────────────────────────────────
const SILENCE_THRESHOLD   = 500;   // RMS below this = silence
const SILENCE_DURATION_MS = 1500;  // auto-stop after 1.5 s continuous silence
const MAX_RECORD_MS       = 15000; // hard cap

const WAKE_PHRASE         = 'hey trixie';

// Energy-gate wake-word tuning (pure JS, no native deps)
const WAKE_SPEECH_FRAMES  = 3;    // consecutive loud frames before we start recording
const WAKE_SILENCE_FRAMES = 12;   // consecutive quiet frames after speech = end of utterance
const WAKE_MAX_MS         = 3000; // hard cap on a single wake-word utterance
const WAKE_THRESHOLD      = 400;  // RMS threshold — same scale as SILENCE_THRESHOLD

const OPENAI_WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const GROQ_WHISPER_URL   = 'https://api.groq.com/openai/v1/audio/transcriptions';

// ─── VoiceInput ───────────────────────────────────────────────────────────────
class VoiceInput extends EventEmitter {
  constructor() {
    super();
    this._recording  = false;
    this._mic        = null;
    this._chunks     = [];
    this._silenceMs  = 0;
    this._lastChunkT = 0;
    this._maxTimer   = null;
    this._silTimer   = null;
  }

  // ── public API ───────────────────────────────────────────────────────────

  startListening() {
    if (this._recording) return;
    this._recording  = true;
    this._chunks     = [];
    this._silenceMs  = 0;
    this._lastChunkT = Date.now();

    this._mic = new Mic({
      rate:     '16000',
      channels: '1',
      encoding: 'signed-integer',
      bitwidth: '16',
      device:   'default',
    });

    const micStream = this._mic.getAudioStream();

    micStream.on('data', (chunk) => {
      if (!this._recording) return;

      this._chunks.push(Buffer.from(chunk));

      const energy = rms(chunk);
      const now    = Date.now();
      const dt     = now - this._lastChunkT;
      this._lastChunkT = now;

      if (energy < SILENCE_THRESHOLD) {
        this._silenceMs += dt;
        if (this._silenceMs >= SILENCE_DURATION_MS) {
          this._autoStop();
        }
      } else {
        this._silenceMs = 0;
      }
    });

    micStream.on('error', (err) => this.emit('error', err.message || String(err)));

    this._mic.start();
    this.emit('listening-start');

    // Hard cap
    this._maxTimer = setTimeout(() => this._autoStop(), MAX_RECORD_MS);
  }

  stopListening() {
    this._stop();
  }

  // ── internal ─────────────────────────────────────────────────────────────

  _autoStop() {
    if (!this._recording) return;
    this._stop();
  }

  _stop() {
    if (!this._recording) return;
    this._recording = false;
    clearTimeout(this._maxTimer);
    this._maxTimer = null;

    if (this._mic) {
      try { this._mic.stop(); } catch (_) {}
      this._mic = null;
    }

    const buf = Buffer.concat(this._chunks);
    this._chunks = [];
    this.onTranscript(buf);
  }

  async onTranscript(audioBuffer) {
    if (!audioBuffer.length) return;

    // Discard recordings that are too short (< 0.5s) or too quiet — these produce hallucinations
    const MIN_BYTES   = 16000 * 0.5 * 2; // 0.5s at 16kHz 16-bit
    const MIN_ENERGY  = 300;
    const energy = rms(audioBuffer);
    console.log(`[VOICE-IN] Recording: ${(audioBuffer.length / 32000).toFixed(1)}s, RMS energy: ${Math.round(energy)}`);
    if (audioBuffer.length < MIN_BYTES || energy < MIN_ENERGY) {
      console.log('[VOICE-IN] Discarding low-energy recording (likely silence)');
      return;
    }

    // Amplify quiet recordings so Whisper can understand them
    const TARGET_ENERGY = 3000;
    const gain = Math.min(8, TARGET_ENERGY / energy); // cap at 8x to avoid distortion
    const amplified = gain > 1.2 ? amplifyPcm(audioBuffer, gain) : audioBuffer;
    console.log(`[VOICE-IN] Amplifying by ${gain.toFixed(1)}x`);

    const wavBuf  = buildWav(amplified);
    const tmpPath = path.join(os.tmpdir(), `trixie_${Date.now()}.wav`);

    try {
      fs.writeFileSync(tmpPath, wavBuf);
      const text = await this._whisper(tmpPath);
      if (!text) return;
      // Discard hallucinations: Whisper often outputs short nonsense on noise
      if (text.split(/\s+/).length < 2) {
        console.log('[VOICE-IN] Discarding short transcript (likely hallucination):', text);
        return;
      }
      this.emit('transcript', text);
    } catch (err) {
      this.emit('transcription-error', err.message || String(err));
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  }

  async _whisper(wavPath, prompt = 'Computer science, programming, algorithms, data structures, binary tree, linked list, recursion, Python, JavaScript') {
    const openaiKey = process.env.OPENAI_KEY;
    const groqKey   = process.env.GROQ_KEY;

    if (groqKey) {
      return this._whisperRequest(wavPath, prompt, groqKey, 'whisper-large-v3', GROQ_WHISPER_URL, 'Groq');
    }
    if (openaiKey) {
      return this._whisperRequest(wavPath, prompt, openaiKey, 'whisper-1', OPENAI_WHISPER_URL, 'OpenAI');
    }
    throw new Error('No STT key set — add OPENAI_KEY or GROQ_KEY to your .env');
  }

  async _whisperRequest(wavPath, prompt, key, model, url, provider) {
    const form = new FormData();
    form.append('file',  fs.createReadStream(wavPath), {
      filename:    path.basename(wavPath),
      contentType: 'audio/wav',
    });
    form.append('model', model);
    form.append('language', 'en');
    if (prompt) form.append('prompt', prompt);

    const res = await fetch(url, {
      method:  'POST',
      headers: { Authorization: `Bearer ${key}`, ...form.getHeaders() },
      body:    form,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${provider} Whisper ${res.status}: ${body}`);
    }

    const json = await res.json();
    return (json.text || '').trim();
  }
}

// ─── Wake-word detection (streaming energy-gate + Whisper) ───────────────────
// Pure JS — no native addons needed. A single mic stream runs continuously.
// Each incoming PCM chunk is checked for energy. When enough loud chunks arrive
// consecutively we start collecting audio; when silence follows we send the
// utterance to Whisper and check for "hey trixie".
//
// vs old approach   | Old (poll)      | New (streaming)
// API calls idle    | 1 per 2 s       | 0
// Detection lag     | ~2 s            | ~200 ms
// Dependencies      | none extra      | none extra
class WakeWordDetector extends EventEmitter {
  constructor() {
    super();
    this._active       = false;
    this._mic          = null;
    this._helper       = new VoiceInput(); // reuses _whisper()
    this._speechFrames = 0;
    this._silFrames    = 0;
    this._collecting   = false;
    this._chunks       = [];
    this._maxTimer     = null;
  }

  start() {
    if (this._active) return;
    this._active = true;

    this._mic = new Mic({
      rate:     '16000',
      channels: '1',
      encoding: 'signed-integer',
      bitwidth: '16',
      device:   'default',
    });

    const stream = this._mic.getAudioStream();

    stream.on('data', (chunk) => {
      if (!this._active) return;
      this._processFrame(Buffer.from(chunk));
    });

    stream.on('error', (err) => {
      console.warn('[WAKE] Mic stream error:', err.message);
    });

    this._mic.start();
    console.log('[WAKE] Streaming energy-gate wake word detection started');
  }

  stop() {
    this._active = false;
    clearTimeout(this._maxTimer);
    this._maxTimer = null;
    if (this._mic) {
      try { this._mic.stop(); } catch (_) {}
      this._mic = null;
    }
    this._reset();
  }

  // ── Per-frame energy classification ──────────────────────────────────────

  _processFrame(chunk) {
    const energy   = rms(chunk);
    const isSpeech = energy >= WAKE_THRESHOLD;

    if (!this._collecting) {
      if (isSpeech) {
        this._speechFrames++;
        if (this._speechFrames >= WAKE_SPEECH_FRAMES) {
          // Enough consecutive loud frames — begin collecting the utterance
          this._collecting = true;
          this._silFrames  = 0;
          this._chunks     = [chunk];
          this._maxTimer   = setTimeout(() => this._finishUtterance(), WAKE_MAX_MS);
        }
      } else {
        this._speechFrames = 0;
      }
    } else {
      // Already collecting — keep buffering
      this._chunks.push(chunk);

      if (!isSpeech) {
        this._silFrames++;
        if (this._silFrames >= WAKE_SILENCE_FRAMES) {
          // Trailing silence — utterance is done
          this._finishUtterance();
        }
      } else {
        this._silFrames = 0;
      }
    }
  }

  // ── Send collected audio to Whisper ──────────────────────────────────────

  async _finishUtterance() {
    clearTimeout(this._maxTimer);
    this._maxTimer = null;

    const chunks = this._chunks.slice();
    this._reset();

    if (!chunks.length) return;

    const pcm     = Buffer.concat(chunks);
    const wavBuf  = buildWav(pcm);
    const tmpPath = path.join(os.tmpdir(), `trixie_wake_${Date.now()}.wav`);

    try {
      fs.writeFileSync(tmpPath, wavBuf);
      const text = await this._helper._whisper(tmpPath, WAKE_PHRASE);
      if (text.toLowerCase().includes('hey trixie')) {
        this.emit('wake');
      }
    } catch (_) {
      // Swallow — keep the mic running
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  }

  _reset() {
    this._collecting   = false;
    this._speechFrames = 0;
    this._silFrames    = 0;
    this._chunks       = [];
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────
const voiceInput       = new VoiceInput();
const wakeWordDetector = new WakeWordDetector();

module.exports = {
  voiceInput,
  startWakeWordDetection: () => wakeWordDetector.start(),
  stopWakeWordDetection:  () => wakeWordDetector.stop(),
};
