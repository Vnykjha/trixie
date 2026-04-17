import * as THREE from 'three';

// ─── State ────────────────────────────────────────────────────────────────────
let currentState = 'idle';   // 'idle' | 'listening' | 'speaking' | 'thinking'
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

// ─── Scene group (micro-rotation drift) ──────────────────────────────────────
const sceneGroup = new THREE.Group();
sceneGroup.scale.setScalar(1.7);
scene.add(sceneGroup);

// ─── Lights ───────────────────────────────────────────────────────────────────
const ambientLight = new THREE.AmbientLight(0x1a0800, 0.4);
scene.add(ambientLight);

const coreLight = new THREE.PointLight(0xff6600, 1.2, 3);
coreLight.position.set(0, 0, 0);
scene.add(coreLight);

// ─── State Colors ─────────────────────────────────────────────────────────────
const COLOR_IDLE       = new THREE.Color(0xff6a00);
const COLOR_LISTENING  = new THREE.Color(0xffaa00);
const COLOR_THINKING   = new THREE.Color(0xff8800);
const COLOR_RING_IDLE  = new THREE.Color(0xff7700);
const COLOR_RING_THINK = new THREE.Color(0xffaa00);
const LIGHT_IDLE       = new THREE.Color(0xff6600);
const LIGHT_LISTENING  = new THREE.Color(0xffaa00);
const LIGHT_THINKING   = new THREE.Color(0xffaa00);
const LIGHT_SPEAKING   = new THREE.Color(0xff9944);

// ─── Outer Atmospheric Halo ───────────────────────────────────────────────────
// Large back-face sphere with additive blending — creates a soft halo bloom
const haloMat = new THREE.MeshBasicMaterial({
  color:       0xff5500,
  transparent: true,
  opacity:     0.10,
  side:        THREE.BackSide,
  blending:    THREE.AdditiveBlending,
  depthWrite:  false,
});
const haloMesh = new THREE.Mesh(new THREE.SphereGeometry(0.62, 32, 32), haloMat);
sceneGroup.add(haloMesh);

// ─── Inner Glow Sphere ────────────────────────────────────────────────────────
const glowMat = new THREE.MeshBasicMaterial({
  color:       0xff4400,
  transparent: true,
  opacity:     0.22,
  blending:    THREE.AdditiveBlending,
  depthWrite:  false,
});
const glowMesh = new THREE.Mesh(new THREE.SphereGeometry(0.44, 32, 32), glowMat);
sceneGroup.add(glowMesh);

// ─── Core Sphere ──────────────────────────────────────────────────────────────
const coreMat = new THREE.MeshStandardMaterial({
  color:             0xff6a00,
  emissive:          0xff6a00,
  emissiveIntensity: 1.2,
  roughness:         0.2,
  metalness:         0.1,
});
const coreMesh = new THREE.Mesh(new THREE.SphereGeometry(0.29, 32, 32), coreMat);
sceneGroup.add(coreMesh);

// ─── Equatorial Ring ──────────────────────────────────────────────────────────
// Glow backing ring (thicker, additive) rendered before the sharp ring
const equatorialGlowRingMat = new THREE.MeshBasicMaterial({
  color:       0xff8800,
  transparent: true,
  opacity:     0.28,
  blending:    THREE.AdditiveBlending,
  depthWrite:  false,
});
const equatorialGlowRing = new THREE.Mesh(
  new THREE.TorusGeometry(0.27, 0.032, 8, 64),
  equatorialGlowRingMat
);
sceneGroup.add(equatorialGlowRing);

const equatorialRingMat = new THREE.MeshBasicMaterial({
  color:       0xff7700,
  transparent: true,
  opacity:     0.85,
});
const equatorialRing = new THREE.Mesh(
  new THREE.TorusGeometry(0.27, 0.008, 8, 64),
  equatorialRingMat
);
sceneGroup.add(equatorialRing);

// ─── Orbit Particle Streams ───────────────────────────────────────────────────
// 5 elliptical orbits as point-particle beads — same planes as the old solid rings
const orbitStreamDefs = [
  { radius: 0.45, count: 70, tiltX:  0.20, tiltY:  0.00, tiltZ:  0.00, speed:  0.005, baseOpacity: 0.50 },
  { radius: 0.55, count: 65, tiltX:  1.10, tiltY:  0.40, tiltZ:  0.20, speed:  0.007, baseOpacity: 0.45 },
  { radius: 0.65, count: 75, tiltX:  0.60, tiltY:  1.20, tiltZ:  0.50, speed: -0.004, baseOpacity: 0.60 },
  { radius: 0.75, count: 60, tiltX:  1.70, tiltY:  0.30, tiltZ:  1.00, speed:  0.009, baseOpacity: 0.35 },
  { radius: 0.85, count: 70, tiltX:  0.90, tiltY:  1.80, tiltZ:  0.70, speed: -0.006, baseOpacity: 0.40 },
];

const orbitStreams = orbitStreamDefs.map(d => {
  const count     = d.count;
  const angles    = new Float32Array(count);
  const positions = new Float32Array(count * 3);

  // Evenly space particles with a small random angular offset each
  for (let i = 0; i < count; i++) {
    angles[i] = (i / count) * Math.PI * 2 + (Math.random() * 0.15 - 0.075);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const mat = new THREE.PointsMaterial({
    color:           0xff8822,
    size:            0.055,
    sizeAttenuation: true,
    transparent:     true,
    opacity:         d.baseOpacity,
    blending:        THREE.AdditiveBlending,
    depthWrite:      false,
  });

  const pts   = new THREE.Points(geo, mat);
  // Each stream lives in its own group so the Euler tilt is applied via Three.js transforms
  const group = new THREE.Group();
  group.rotation.set(d.tiltX, d.tiltY, d.tiltZ);
  group.add(pts);
  sceneGroup.add(group);

  return { angles, positions, geo, mat, group, ...d };
});

// ─── Scanline / Data Shell ────────────────────────────────────────────────────
// Sparse broken latitude-line arcs, faint warm orange, counter-rotating
const scanlineGroup = new THREE.Group();
sceneGroup.add(scanlineGroup);

const NUM_SCANLINES = 14;
for (let i = 0; i < NUM_SCANLINES; i++) {
  const lat   = (i / (NUM_SCANLINES - 1) - 0.5) * Math.PI;
  const r     = 0.95;
  const y     = r * Math.sin(lat);
  const ringR = r * Math.cos(lat);
  if (ringR < 0.08) continue;

  const segs = 2 + (i % 2);
  for (let s = 0; s < segs; s++) {
    const arcStart = (s / segs) * Math.PI * 2 + (i * 0.37);
    const arcLen   = (0.45 + (s * 0.23)) * (Math.PI * 2 / segs);
    const arcEnd   = arcStart + arcLen;
    const pts = [];
    for (let k = 0; k <= 24; k++) {
      const a = arcStart + (arcEnd - arcStart) * (k / 24);
      pts.push(new THREE.Vector3(ringR * Math.cos(a), y, ringR * Math.sin(a)));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({
      color:       0xff9933,
      transparent: true,
      opacity:     0.15,
    });
    scanlineGroup.add(new THREE.Line(geo, mat));
  }
}

// ─── Ambient Particle Field ───────────────────────────────────────────────────
// 80 drifting points at radius 1.0–1.4; flash on speaking
const PARTICLE_COUNT    = 80;
const particlePositions = new Float32Array(PARTICLE_COUNT * 3);
const particleTheta     = new Float32Array(PARTICLE_COUNT);
const particlePhi       = new Float32Array(PARTICLE_COUNT);
const particleSpeed     = new Float32Array(PARTICLE_COUNT);
const particleBase      = new Float32Array(PARTICLE_COUNT);

for (let i = 0; i < PARTICLE_COUNT; i++) {
  particleTheta[i] = Math.random() * Math.PI * 2;
  particlePhi[i]   = Math.acos(2 * Math.random() - 1);
  particleSpeed[i] = 0.002 + Math.random() * 0.004;
  particleBase[i]  = 1.0 + Math.random() * 0.4;
}

const particleGeo = new THREE.BufferGeometry();
particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));

const particleMat = new THREE.PointsMaterial({
  color:           0xffbb55,
  size:            0.012,
  sizeAttenuation: true,
  transparent:     true,
  opacity:         0.55,
});

const particles = new THREE.Points(particleGeo, particleMat);
sceneGroup.add(particles);

// ─── Lerp / smooth state ──────────────────────────────────────────────────────
const lerpFactor        = 0.05;
const lerpCoreColor     = new THREE.Color(0xff6a00);
const lerpLightColor    = new THREE.Color(0xff6600);
let   lerpRingScale     = 1.0;
let   smoothedAmplitude = 0;

// ─── Animation ────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

function updateParticles(t) {
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particleTheta[i] += particleSpeed[i];
    const r = particleBase[i] + 0.05 * Math.sin(t * 0.5 + i * 1.3);
    const sinPhi = Math.sin(particlePhi[i]);
    particlePositions[i * 3]     = r * sinPhi * Math.cos(particleTheta[i]);
    particlePositions[i * 3 + 1] = r * Math.cos(particlePhi[i]);
    particlePositions[i * 3 + 2] = r * sinPhi * Math.sin(particleTheta[i]);
  }
  particleGeo.attributes.position.needsUpdate = true;

  if (currentState === 'speaking') {
    particleMat.opacity = 0.35 + amplitude * 0.55;
  } else {
    particleMat.opacity = 0.45 + 0.1 * Math.sin(t * 0.7);
  }
}

function updateOrbitStreams(t) {
  const isListening = currentState === 'listening';
  const isSpeaking  = currentState === 'speaking';
  const isThinking  = currentState === 'thinking';

  // Smooth amplitude so speaking displacement fades gracefully
  smoothedAmplitude += (amplitude - smoothedAmplitude) * 0.1;

  const ringMul = isThinking ? 3.0 : (isSpeaking ? 1.5 : (isListening ? 0.5 : 1.0));

  // Thinking: slow breathing size pulse (0.012 – 0.032)
  const thinkSize = isThinking
    ? 0.030 + 0.03 * (0.5 + 0.5 * Math.sin(t * 4))
    : 0.045;

  // Listening: rings slowly expand to 1.15× over ~0.3 s
  const scaleTarget = isListening ? 1.15 : 1.0;
  lerpRingScale += (scaleTarget - lerpRingScale) * lerpFactor;

  orbitStreams.forEach(stream => {
    const { angles, positions, geo, mat, group, radius, count, speed, baseOpacity } = stream;

    // Color: lerp toward amber for thinking, idle orange otherwise
    mat.color.lerp(isThinking ? COLOR_RING_THINK : COLOR_RING_IDLE, lerpFactor);

    mat.size = thinkSize;

    // Opacity per state
    const tgtOp = isSpeaking
      ? Math.max(0.2, Math.min(0.9, 0.2 + smoothedAmplitude * 0.7))
      : isThinking ? baseOpacity * 0.8
      : baseOpacity;
    mat.opacity += (tgtOp - mat.opacity) * lerpFactor;

    // Listening expand via group scale
    group.scale.setScalar(lerpRingScale);

    // Update each particle's position in ring-local XZ space
    for (let i = 0; i < count; i++) {
      angles[i] += speed * ringMul;
      const θ    = angles[i];
      const cosθ = Math.cos(θ);
      const sinθ = Math.sin(θ);

      // Radial radius (base ± speaking displacement)
      let r = radius;
      if (isSpeaking) {
        r += Math.sin(t * 12 + i * 0.3) * smoothedAmplitude * 0.08;
      }

      // Idle: organic positional jitter ±0.005
      let jx = 0, jz = 0;
      if (!isSpeaking && !isThinking) {
        jx = (Math.random() - 0.5) * 0.01;
        jz = (Math.random() - 0.5) * 0.01;
      }

      // Speaking: tangential wobble driven by smoothed amplitude
      let tx = 0, tz = 0;
      if (isSpeaking) {
        const w = (Math.random() - 0.5) * smoothedAmplitude * 0.03;
        tx = w * (-sinθ);
        tz = w * cosθ;
      }

      positions[i * 3]     = r * cosθ + jx + tx;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = r * sinθ + jz + tz;
    }

    geo.attributes.position.needsUpdate = true;
  });
}

function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();

  const isListening = currentState === 'listening';
  const isSpeaking  = currentState === 'speaking';
  const isThinking  = currentState === 'thinking';

  // ── Micro-rotation drift — restless idle energy ──────────────────────────
  sceneGroup.rotation.x = 0.0008 * Math.sin(t * 0.3);
  sceneGroup.rotation.y = 0.0008 * Math.cos(t * 0.25);

  // ── Target colors per state ───────────────────────────────────────────────
  const tgtCore  = isListening ? COLOR_LISTENING : isThinking ? COLOR_THINKING : COLOR_IDLE;
  const tgtLight = isListening ? LIGHT_LISTENING : isThinking ? LIGHT_THINKING
                 : isSpeaking  ? LIGHT_SPEAKING  : LIGHT_IDLE;

  // ── Lerp colors (~0.3 s at 60 fps with factor 0.05) ──────────────────────
  lerpCoreColor.lerp(tgtCore, lerpFactor);
  lerpLightColor.lerp(tgtLight, lerpFactor);

  coreMat.color.copy(lerpCoreColor);
  coreMat.emissive.copy(lerpCoreColor);
  glowMat.color.copy(lerpCoreColor);
  haloMat.color.copy(lerpCoreColor);
  equatorialRingMat.color.copy(lerpCoreColor);
  equatorialGlowRingMat.color.copy(lerpCoreColor);
  coreLight.color.copy(lerpLightColor);

  // ── Core scale: slow idle breath or speaking pulse ────────────────────────
  let targetScale;
  if (isSpeaking) {
    targetScale = Math.min(1.6, 1.0 + 0.6 * amplitude * Math.abs(Math.sin(t * 12)));
  } else {
    targetScale = 1.0 + 0.04 * Math.sin((t * 2 * Math.PI) / 3);
  }
  coreMesh.scale.setScalar(targetScale);
  glowMesh.scale.setScalar(targetScale);
  haloMesh.scale.setScalar(targetScale);

  // ── Emissive intensity ────────────────────────────────────────────────────
  coreMat.emissiveIntensity = isSpeaking ? 1.2 + amplitude * 1.5
                            : isThinking  ? 1.0 + 0.5 * Math.sin(t * 6)
                            : 1.0 + 0.2 * Math.sin(t * 0.8);

  // ── Point light ───────────────────────────────────────────────────────────
  coreLight.intensity = 1.2 + (isSpeaking ? amplitude * 1.5 : 0.2 * Math.sin(t * 1.5));

  // ── Equatorial ring — faster when thinking, slower at idle ───────────────
  const ringDelta = isThinking ? 0.03 : (isSpeaking ? 0.02 : 0.01);
  equatorialRing.rotation.y      += ringDelta;
  equatorialGlowRing.rotation.y  += ringDelta;

  // ── Orbit particle streams ────────────────────────────────────────────────
  updateOrbitStreams(t);

  // ── Scanlines counter-rotate relative to orbit streams ───────────────────
  scanlineGroup.rotation.y -= 0.0015;
  scanlineGroup.rotation.x += 0.0004;

  // ── Ambient particles ─────────────────────────────────────────────────────
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
