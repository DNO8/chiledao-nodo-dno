import assert from 'node:assert/strict';
import test from 'node:test';
import { advancePhase, createWaveGrid, initParticleWave, projectWave, waveBudget, PAINT_INTERVAL } from '../src/lib/particle-wave.ts';

test('responsive budgets cap points and device pixel ratio', () => {
  for (const width of [320, 390, 767, 768, 1440, 100000]) {
    const { columns, rows, dpr } = waveBudget(width, 4);
    assert.equal(columns * rows, width < 768 ? 180 : 512);
    assert.equal(dpr, 1.5);
  }
  assert.equal(waveBudget(320, NaN).dpr, 1);
  assert.equal(waveBudget(320, .5).dpr, 1);
  assert.equal(PAINT_INTERVAL, 1000 / 30);
});

test('original perspective projection is bounded, deterministic and genuinely moves', () => {
  for (const width of [320, 390, 1440]) {
    const { columns, rows } = waveBudget(width, 1);
    const grid = createWaveGrid(columns, rows);
    const first = new Float32Array(grid.length), next = new Float32Array(grid.length);
    assert.equal(projectWave(grid, first, width, 779, 0), first, 'reuse output buffer');
    projectWave(grid, next, width, 779, .16);
    assert.equal(grid.length, columns * rows * 2);
    assert.ok([...first].every(Number.isFinite));
    assert.ok(first.filter((_, i) => i % 2).every(y => y >= 0 && y <= 779));
    assert.ok(next.some((y, i) => i % 2 && Math.abs(y - first[i]) > .1));
    assert.deepEqual(projectWave(grid, new Float32Array(grid.length), width, 779, 0), first);
    const topSpan = first[(columns - 1) * 2] - first[0];
    const bottomStart = (rows - 1) * columns * 2;
    const bottomSpan = first[bottomStart + (columns - 1) * 2] - first[bottomStart];
    assert.ok(bottomSpan > topSpan * 2, 'near rows spread with depth');
  }
});

test('phase follows elapsed time and never catches up after background suspension', () => {
  const at30 = Array.from({ length: 30 }).reduce(phase => advancePhase(phase, 1 / 30), 0);
  const at60 = Array.from({ length: 60 }).reduce(phase => advancePhase(phase, 1 / 60), 0);
  assert.ok(Math.abs(at30 - at60) < 1e-12);
  assert.ok(Math.abs(at30 - .32) < 1e-12);
  assert.equal(advancePhase(0, 600), .032);
  assert.equal(advancePhase(1, -1), 1);
  assert.ok(advancePhase(Math.PI * 2 - .01, .1) < .04);
});

test('owned frame reconciles reduced motion before delayed media callback delivery', { concurrency: false }, () => {
  const globals = new Map();
  const install = (name, value) => {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const frames = new Map();
  const motion = new EventTarget();
  motion.matches = false;
  const document = new EventTarget();
  document.hidden = false;
  const window = new EventTarget();
  window.matchMedia = () => motion;
  window.devicePixelRatio = 1;
  let intersection, serial = 0, disconnected = 0, lifecycle;
  const context = Object.fromEntries(['clearRect', 'beginPath', 'moveTo', 'arc', 'fill', 'setTransform']
    .map(name => [name, () => {}]));
  const canvas = { isConnected: true, dataset: {}, getContext: () => context };
  const owner = { isConnected: true, getBoundingClientRect: () => ({ width: 390, height: 844 }) };
  const button = new EventTarget();
  const attributes = new Map();
  button.setAttribute = (name, value) => attributes.set(name, value);
  class IntersectionObserver {
    constructor(callback) { intersection = callback; }
    observe() {}
    disconnect() { disconnected++; }
  }
  class ResizeObserver {
    observe() {}
    disconnect() { disconnected++; }
  }
  const runFrame = now => {
    assert.equal(frames.size, 1, 'one owned pending frame');
    const [id, callback] = frames.entries().next().value;
    frames.delete(id);
    callback(now);
  };
  try {
    install('window', Object.assign(window, { IntersectionObserver, ResizeObserver }));
    install('document', document);
    install('IntersectionObserver', IntersectionObserver);
    install('ResizeObserver', ResizeObserver);
    install('getComputedStyle', () => ({ getPropertyValue: name => name === '--paper' ? '#efeee8' : '#f31e32' }));
    install('localStorage', { getItem: () => null, setItem: () => {} });
    install('requestAnimationFrame', callback => { frames.set(++serial, callback); return serial; });
    install('cancelAnimationFrame', id => frames.delete(id));
    lifecycle = initParticleWave(canvas, owner, button);
    assert.ok(lifecycle);
    intersection([{ isIntersecting: true }]);
    runFrame(100);
    const before = { paints: canvas.dataset.wavePaints, phase: canvas.dataset.wavePhase };
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'Pausar fondo animado');

    // The real renderer observes the changed query on its next owned frame;
    // deliberately do not deliver the mocked native change callback yet.
    motion.matches = true;
    runFrame(150);
    assert.equal(canvas.dataset.waveQueued, '0');
    assert.equal(frames.size, 0);
    assert.equal(canvas.dataset.wavePaints, before.paints);
    assert.equal(canvas.dataset.wavePhase, before.phase);
    assert.equal(button.disabled, true, 'ineligible frame must synchronize the current control');
    assert.equal(button.textContent, 'Fondo estático por preferencia de movimiento');
    assert.equal(attributes.get('aria-pressed'), 'false');

    motion.dispatchEvent(new Event('change'));
    assert.equal(frames.size, 0, 'delayed callback cannot restart reduced motion');
    assert.equal(canvas.dataset.wavePhase, before.phase);
    motion.matches = false;
    motion.dispatchEvent(new Event('change'));
    assert.equal(frames.size, 1, 'native preference reversal resumes one frame');
    assert.equal(button.disabled, false);
    lifecycle.dispose();
    assert.equal(disconnected, 2);
    assert.equal(frames.size, 0);
    const disposedPaints = canvas.dataset.wavePaints;
    motion.matches = true;
    motion.dispatchEvent(new Event('change'));
    window.dispatchEvent(new Event('resize'));
    document.dispatchEvent(new Event('visibilitychange'));
    button.dispatchEvent(new Event('click'));
    assert.equal(canvas.dataset.wavePaints, disposedPaints, 'disposed listeners remain inactive');
    assert.equal(frames.size, 0);
  } finally {
    lifecycle?.dispose();
    frames.clear();
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
