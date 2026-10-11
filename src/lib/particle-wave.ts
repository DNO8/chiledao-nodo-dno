/** Original two-frequency sine surface; no renderer or component dependencies. */
export const WAVE_STORAGE_KEY = 'chiledao.hero-wave.paused';
export const PAINT_INTERVAL = 1000 / 30;

export function waveBudget(width: number, dpr: number) {
  return { columns: width < 768 ? 18 : 32, rows: width < 768 ? 10 : 16,
    dpr: Math.min(1.5, Math.max(1, Number.isFinite(dpr) ? dpr : 1)) };
}

export function advancePhase(phase: number, elapsedSeconds: number) {
  // Frequencies 1 and .8 complete five and four cycles together at 10π.
  return (phase + Math.min(.1, Math.max(0, elapsedSeconds)) * .32) % (Math.PI * 10);
}

// Grid and output buffers are allocated only when the geometry budget changes.
export function createWaveGrid(columns: number, rows: number) {
  const grid = new Float32Array(columns * rows * 2);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const index = (row * columns + column) * 2;
      grid[index] = column / (columns - 1) * 2 - 1;
      grid[index + 1] = row / (rows - 1);
    }
  }
  return grid;
}

export function projectWave(grid: Float32Array, output: Float32Array, width: number, height: number, phase: number) {
  const amplitude = width < 768 ? 12 : 20;
  for (let index = 0; index < grid.length; index += 2) {
    const x = grid[index], depth = grid[index + 1];
    const perspective = 1 / (1.8 - depth * 1.1);
    const wave = Math.sin(x * 3.8 + depth * 5 + phase) * .68
      + Math.sin(x * 6.3 - depth * 3.2 - phase * .8) * .32;
    output[index] = width * (.5 + x * .44 * perspective);
    output[index + 1] = height * (.08 + Math.pow(depth, 1.5) * .85)
      + wave * amplitude * (.4 + depth * .6);
  }
  return output;
}

export function initParticleWave(canvas: HTMLCanvasElement, owner: HTMLElement, button: HTMLButtonElement | null, onDispose?: () => void) {
  const context = canvas.getContext('2d');
  if (!context || !window.IntersectionObserver || !window.ResizeObserver) return null;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const colors = getComputedStyle(canvas);
  const paper = colors.getPropertyValue('--paper').trim();
  const red = colors.getPropertyValue('--red').trim();
  let paused = false;
  try { paused = localStorage.getItem(WAVE_STORAGE_KEY) === 'true'; } catch { /* Storage is optional. */ }
  let disposed = false, visible = false, frame = 0, lastPaint = 0, phase = 0, paints = 0;
  let width = 0, height = 0, dpr = 1;
  let grid = new Float32Array(0), points = new Float32Array(0);

  const alive = () => {
    if (disposed) return false;
    if (!canvas.isConnected || !owner.isConnected) { dispose(); return false; }
    return true;
  };
  const syncButton = () => {
    if (disposed || !button) return;
    button.hidden = false;
    button.disabled = motion.matches;
    button.setAttribute('aria-pressed', String(paused));
    button.textContent = motion.matches ? 'Fondo estático por preferencia de movimiento'
      : paused ? 'Activar fondo animado' : 'Pausar fondo animado';
  };
  const paint = () => {
    if (!alive() || !width || !height) return;
    context.clearRect(0, 0, width, height);
    projectWave(grid, points, width, height, phase);
    // Eight grouped paths avoid allocating per-point objects or changing style per dot.
    for (let group = 0; group < 8; group++) {
      context.fillStyle = group < 4 ? paper : red;
      context.globalAlpha = .12 + (group % 4) * .06;
      context.beginPath();
      for (let point = 0; point < grid.length / 2; point++) {
        const bucket = point % 4 + (point % 7 === 0 ? 4 : 0);
        if (bucket !== group) continue;
        const index = point * 2, radius = .6 + grid[index + 1] * 1.1;
        context.moveTo(points[index] + radius, points[index + 1]);
        context.arc(points[index], points[index + 1], radius, 0, Math.PI * 2);
      }
      context.fill();
    }
    context.globalAlpha = 1;
    canvas.dataset.wavePaints = String(++paints);
    canvas.dataset.wavePhase = String(phase);
  };
  const eligible = () => alive() && visible && !document.hidden && !paused && !motion.matches;
  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastPaint = 0;
    canvas.dataset.waveQueued = '0';
  };
  const schedule = () => {
    frame = requestAnimationFrame(tick);
    canvas.dataset.waveQueued = '1';
  };
  const tick = (now: number) => {
    frame = 0;
    canvas.dataset.waveQueued = '0';
    if (!eligible()) { reconcile(); return; }
    if (!lastPaint || now - lastPaint >= PAINT_INTERVAL) {
      phase = advancePhase(phase, lastPaint ? (now - lastPaint) / 1000 : 0);
      lastPaint = now;
      paint();
    }
    schedule();
  };
  const reconcile = () => {
    if (eligible()) { if (!frame) schedule(); }
    else stop();
    syncButton();
  };
  const resize = () => {
    if (!alive()) return;
    const rect = owner.getBoundingClientRect();
    const budget = waveBudget(rect.width, window.devicePixelRatio);
    if (width === rect.width && height === rect.height && dpr === budget.dpr) return;
    width = rect.width; height = rect.height; dpr = budget.dpr;
    if (grid.length !== budget.columns * budget.rows * 2) {
      grid = createWaveGrid(budget.columns, budget.rows);
      points = new Float32Array(grid.length);
    }
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    canvas.dataset.wavePoints = String(grid.length / 2);
    canvas.dataset.waveDpr = String(dpr);
    paint();
  };
  const toggle = () => {
    if (!alive() || motion.matches) return;
    paused = !paused;
    try { localStorage.setItem(WAVE_STORAGE_KEY, String(paused)); } catch { /* Keep the session control functional. */ }
    reconcile();
  };
  const preference = () => { reconcile(); if (motion.matches) paint(); };
  const intersection = new IntersectionObserver(entries => {
    if (!alive()) return;
    visible = entries.some(entry => entry.isIntersecting);
    reconcile();
  });
  const size = new ResizeObserver(resize);
  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    intersection.disconnect();
    size.disconnect();
    document.removeEventListener('visibilitychange', reconcile);
    motion.removeEventListener('change', preference);
    window.removeEventListener('resize', resize);
    button?.removeEventListener('click', toggle);
    if (button) { button.hidden = true; button.disabled = true; }
    onDispose?.();
  }
  intersection.observe(owner);
  size.observe(owner);
  document.addEventListener('visibilitychange', reconcile);
  motion.addEventListener('change', preference);
  window.addEventListener('resize', resize, { passive: true });
  button?.addEventListener('click', toggle);
  resize();
  reconcile();

  return { dispose };
}
