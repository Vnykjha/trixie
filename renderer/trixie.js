import * as THREE from 'three';

// ─── State ────────────────────────────────────────────────────────────────────
let currentState = 'idle';   // 'idle' | 'listening' | 'speaking'
let amplitude = 0;           // 0–1, used during 'speaking'

// ─── Renderer ─────────────────────────────────────────────────────────────────
const container = document.getElementById('canvas-container');
const W = container.clientWidth  || 320;
const H = container.clientHeight || 280;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(W, H);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x000000, 0);
container.appendChild(renderer.domElement);

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, W / H, 0.1, 100);
camera.position.z = 4;

// ─── Lights ───────────────────────────────────────────────────────────────────
const ambientLight = new THREE.AmbientLight(0x331100, 1.2);
scene.add(ambientLight);

const coreLight = new THREE.PointLight(0xFFB830, 2, 5);
coreLight.position.set(0, 0, 0);
scene.add(coreLight);

// ─── Orbital Rings ────────────────────────────────────────────────────────────
const ringMat = new THREE.MeshStandardMaterial({
  color:             0xFFB830,
  emissive:          0xFFB830,
  emissiveIntensity: 0.8,
  roughness:         0.2,
  metalness:         0.9,
});

const ringGeo = new THREE.TorusGeometry(1.2, 0.012, 12, 120);

const ring1 = new THREE.Mesh(ringGeo, ringMat);
scene.add(ring1);

const ring2 = new THREE.Mesh(ringGeo, ringMat);
ring2.rotation.x = THREE.MathUtils.degToRad(60);
scene.add(ring2);

const ring3 = new THREE.Mesh(ringGeo, ringMat);
ring3.rotation.x = THREE.MathUtils.degToRad(120);
scene.add(ring3);

// ─── Particle Sparks ──────────────────────────────────────────────────────────
const PARTICLE_COUNT = 200;
const particlePositions = new Float32Array(PARTICLE_COUNT * 3);
// Store each particle's spherical coords for drift animation
const particleTheta = new Float32Array(PARTICLE_COUNT);
const particlePhi   = new Float32Array(PARTICLE_COUNT);
const particleSpeed = new Float32Array(PARTICLE_COUNT);
const particleBase  = new Float32Array(PARTICLE_COUNT); // base radius 1.0–1.4

for (let i = 0; i < PARTICLE_COUNT; i++) {
  particleTheta[i] = Math.random() * Math.PI * 2;
  particlePhi[i]   = Math.acos(2 * Math.random() - 1);
  particleSpeed[i] = 0.003 + Math.random() * 0.004;
  particleBase[i]  = 1.0 + Math.random() * 0.4;
}

const particleGeo = new THREE.BufferGeometry();
particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));

const particleMat = new THREE.PointsMaterial({
  color:       0xFFC84A,
  size:        0.015,
  sizeAttenuation: true,
  transparent: true,
  opacity:     0.9,
});

const particles = new THREE.Points(particleGeo, particleMat);
scene.add(particles);

// ─── Core Sphere ──────────────────────────────────────────────────────────────
const coreMat = new THREE.MeshStandardMaterial({
  color:             0xFF9500,
  emissive:          0xFF6000,
  emissiveIntensity: 1.5,
  roughness:         0.3,
  metalness:         0.4,
});
const coreMesh = new THREE.Mesh(new THREE.SphereGeometry(0.25, 32, 32), coreMat);
scene.add(coreMesh);

// ─── Colour helpers ───────────────────────────────────────────────────────────
const GOLD_COLOR   = new THREE.Color(0xFF9500);
const GOLD_EMIT    = new THREE.Color(0xFF6000);
const BLUE_COLOR   = new THREE.Color(0x00AAFF);
const BLUE_EMIT    = new THREE.Color(0x0055AA);
const AMBER_COLOR  = new THREE.Color(0xFF8C00);
const AMBER_EMIT   = new THREE.Color(0xFF5500);

// ─── Animation ────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

function updateParticles(t) {
  const isListening = currentState === 'listening';
  const isSpeaking  = currentState === 'speaking';
  const isThinking  = currentState === 'thinking';

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const speedMul = isListening ? 3.0 : (isSpeaking ? 2.0 : (isThinking ? 1.5 : 1.0));
    particleTheta[i] += particleSpeed[i] * speedMul;

    let r = particleBase[i];
    if (isListening) {
      r = particleBase[i] * (1.0 + 0.15 * Math.sin(t * 3 + i));
    } else if (isSpeaking) {
      r = particleBase[i] * (1.0 + amplitude * 0.3 * Math.sin(t * 8 + i * 0.5));
    } else if (isThinking) {
      // Particles contract inward to ~0.6 radius
      r = 0.6 + (particleBase[i] - 0.6) * (0.3 + 0.3 * Math.sin(t * 4 + i * 0.3));
    }

    const sinPhi = Math.sin(particlePhi[i]);
    particlePositions[i * 3]     = r * sinPhi * Math.cos(particleTheta[i]);
    particlePositions[i * 3 + 1] = r * Math.cos(particlePhi[i]);
    particlePositions[i * 3 + 2] = r * sinPhi * Math.sin(particleTheta[i]);
  }

  particleGeo.attributes.position.needsUpdate = true;
}

function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();

  // Ring speed multipliers
  const ringMul = currentState === 'listening' ? 2.0
                : currentState === 'speaking'  ? 1.5
                : currentState === 'thinking'  ? 3.0
                : 1.0;

  ring1.rotation.y += 0.003 * ringMul;
  ring2.rotation.z += 0.005 * ringMul;
  ring3.rotation.y -= 0.004 * ringMul;

  // Core breathing
  let coreScale;
  if (currentState === 'speaking') {
    coreScale = 1.0 + 0.1 * amplitude * Math.sin(t * 12);
  } else {
    coreScale = 0.95 + 0.05 * (0.5 + 0.5 * Math.sin(t * Math.PI)); // 2s period
  }
  coreMesh.scale.setScalar(coreScale);

  // Core colour blend per state
  if (currentState === 'listening') {
    const blend = 0.5 + 0.5 * Math.sin(t * 3);
    coreMat.color.lerpColors(GOLD_COLOR, BLUE_COLOR, blend * 0.6);
    coreMat.emissive.lerpColors(GOLD_EMIT, BLUE_EMIT, blend * 0.5);
    coreMat.emissiveIntensity = 1.8;
  } else if (currentState === 'speaking') {
    coreMat.color.copy(GOLD_COLOR);
    coreMat.emissive.copy(GOLD_EMIT);
    coreMat.emissiveIntensity = 1.5 + amplitude * 1.5;
  } else if (currentState === 'thinking') {
    // Rapid amber pulse
    const pulse = 0.5 + 0.5 * Math.sin(t * 8);
    coreMat.color.copy(AMBER_COLOR);
    coreMat.emissive.lerpColors(AMBER_EMIT, AMBER_COLOR, pulse);
    coreMat.emissiveIntensity = 1.8 + pulse * 1.2;
  } else {
    coreMat.color.copy(GOLD_COLOR);
    coreMat.emissive.copy(GOLD_EMIT);
    coreMat.emissiveIntensity = 1.5;
  }

  // Core light pulse
  coreLight.intensity = 2 + (currentState === 'speaking' ? amplitude * 3 : 0.5 * Math.sin(t * 2));

  updateParticles(t);

  renderer.render(scene, camera);
}

animate();

// ─── Resize ───────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  const W2 = container.clientWidth;
  const H2 = container.clientHeight;
  camera.aspect = W2 / H2;
  camera.updateProjectionMatrix();
  renderer.setSize(W2, H2);
});

// ─── Public state API ─────────────────────────────────────────────────────────
function setTrixieState(state, amp = 0) {
  currentState = state;
  amplitude    = Math.max(0, Math.min(1, amp));
}

window.setTrixieState = setTrixieState;

// ─── IPC listeners ────────────────────────────────────────────────────────────
if (window.trixie) {
  window.trixie.on('state-change', ({ state, amplitude: amp }) => {
    setTrixieState(state, amp);
  });

  // ── Real amplitude via Web Audio API ──────────────────────────────────────
  // Main process sends the raw MP3 ArrayBuffer; we decode it, then stream
  // RMS energy frames back at ~80 ms intervals while the orb is speaking.
  const RMS_INTERVAL_MS  = 80;
  const SAMPLES_PER_TICK = 2048;

  let _audioCtx         = null;
  let _audioBuffer      = null;
  let _ampTimer         = null;
  let _sampleOffset     = 0;
  let _channelData      = null;

  function _stopAmplitudeStream() {
    clearInterval(_ampTimer);
    _ampTimer     = null;
    _audioBuffer  = null;
    _channelData  = null;
    _sampleOffset = 0;
  }

  function _computeRms(data, offset, count) {
    let sum = 0;
    const end = Math.min(offset + count, data.length);
    for (let i = offset; i < end; i++) sum += data[i] * data[i];
    const n = end - offset;
    return n > 0 ? Math.sqrt(sum / n) : 0;
  }

  let _sourceNode = null;

  window.trixie.on('audio-decode', async (arrayBuffer) => {
    _stopAmplitudeStream();
    if (_sourceNode) { try { _sourceNode.stop(); } catch (_) {} _sourceNode = null; }
    try {
      if (!_audioCtx) _audioCtx = new AudioContext();
      _audioBuffer  = await _audioCtx.decodeAudioData(arrayBuffer);
      _channelData  = _audioBuffer.getChannelData(0);
      _sampleOffset = 0;

      // Play the audio through Chromium's Web Audio API
      _sourceNode = _audioCtx.createBufferSource();
      _sourceNode.buffer = _audioBuffer;
      _sourceNode.connect(_audioCtx.destination);
      _sourceNode.onended = () => {
        _sourceNode = null;
        _stopAmplitudeStream();
        window.trixie.send('audio-amplitude', -1); // signal done to main process
      };
      _sourceNode.start();

      const sampleRate      = _audioBuffer.sampleRate;
      const samplesPerTick  = Math.round(sampleRate * RMS_INTERVAL_MS / 1000);

      _ampTimer = setInterval(() => {
        if (!_channelData || _sampleOffset >= _channelData.length) {
          _stopAmplitudeStream();
          return;
        }
        const rms = _computeRms(_channelData, _sampleOffset, samplesPerTick);
        _sampleOffset += samplesPerTick;
        window.trixie.send('audio-amplitude', Math.min(1, rms * 4));
      }, RMS_INTERVAL_MS);
    } catch (err) {
      console.warn('[TRIXIE] Web Audio decode failed:', err);
      window.trixie.send('audio-amplitude', -1); // signal done even on error
    }
  });

  window.trixie.on('audio-decode-stop', () => {
    if (_sourceNode) { try { _sourceNode.stop(); } catch (_) {} _sourceNode = null; }
    _stopAmplitudeStream();
  });
}
