/**
 * Canvas board renderer: warm wood texture, sprite-cached stones,
 * placement / capture animations, last-move pulse, hover previews
 * and pointer input (with a two-tap confirm flow on touch screens).
 */

import { BLACK, WHITE, EMPTY, STAR_POINTS } from './engine.js';

const COL_LETTERS = 'ABCDEFGHJKLMNOPQRST'; // no "I", Go convention

const DROP_MS = 260;
const FADE_MS = 420;

const easeOutBack = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

export class BoardRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.boardSize = 19;
    this.grid = new Uint8Array(19 * 19);
    this.lastMove = null;
    this.showNumbers = false;
    this.moveNumbers = new Map(); // "x,y" -> move number
    this.bookmarks = new Set();   // "x,y" of bookmarked stones currently on board

    this.stoneAnims = new Map();  // "x,y" -> start time (drop animation)
    this.dying = [];              // { x, y, color, start }
    this.particles = [];          // ink particles from captures
    this.ghost = null;            // { x, y, color }
    this.pendingTap = null;       // { x, y } awaiting confirm on touch

    this.onPlay = null;           // (x, y) => void
    this.interactive = true;
    this.active = false;
    this._raf = null;

    this.woodCache = null;
    this.sprites = null;

    this._bindInput();
    this._observer = new ResizeObserver(() => this.resize());
    this._observer.observe(canvas);
    this.resize();
  }

  // ----- geometry ---------------------------------------------------

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 10) return;
    const dpr = window.devicePixelRatio || 1;
    this.cssSize = rect.width;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._computeGeometry();
    this.woodCache = null;
    this.sprites = null;
    this.draw();
  }

  _computeGeometry() {
    const n = this.boardSize;
    // margin leaves room for coordinate labels plus half a stone
    this.cell = this.cssSize / (n - 1 + 2.3);
    this.margin = this.cell * 1.15;
    this.stoneRadius = this.cell * 0.47;
  }

  px(i) { return this.margin + i * this.cell; }

  pointAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.round((clientX - rect.left - this.margin) / this.cell);
    const y = Math.round((clientY - rect.top - this.margin) / this.cell);
    if (x < 0 || y < 0 || x >= this.boardSize || y >= this.boardSize) return null;
    const dx = clientX - rect.left - this.px(x);
    const dy = clientY - rect.top - this.px(y);
    if (Math.hypot(dx, dy) > this.cell * 0.55) return null;
    return { x, y };
  }

  setBoardSize(size) {
    this.boardSize = size;
    this.grid = new Uint8Array(size * size);
    this.lastMove = null;
    this.stoneAnims.clear();
    this.dying = [];
    this.particles = [];
    this._computeGeometry();
    this.woodCache = null;
    this.sprites = null;
    this.draw();
  }

  // ----- position updates -------------------------------------------

  /**
   * Update the displayed position. When `animate` is true the diff is
   * animated (new stones drop in, removed stones dissolve away).
   */
  setPosition(grid, lastMove, { animate = false } = {}) {
    const now = performance.now();
    if (animate) {
      for (let i = 0; i < grid.length; i++) {
        const x = i % this.boardSize;
        const y = Math.floor(i / this.boardSize);
        const key = `${x},${y}`;
        if (grid[i] !== EMPTY && this.grid[i] === EMPTY) {
          this.stoneAnims.set(key, now);
        } else if (grid[i] === EMPTY && this.grid[i] !== EMPTY) {
          this.dying.push({ x, y, color: this.grid[i], start: now });
          this._spawnInkParticles(x, y, this.grid[i]);
          this.stoneAnims.delete(key);
        }
      }
    } else {
      this.stoneAnims.clear();
      this.dying = [];
      this.particles = [];
    }
    this.grid = grid.slice();
    this.lastMove = lastMove && !lastMove.pass ? lastMove : null;
    this.pendingTap = null;
    this.draw();
  }

  setMoveNumbers(map) {
    this.moveNumbers = map || new Map();
    this.draw();
  }

  setBookmarks(set) {
    this.bookmarks = set || new Set();
    this.draw();
  }

  setGhost(point) {
    this.ghost = point;
    this.draw();
  }

  _spawnInkParticles(x, y, color) {
    const cx = this.px(x);
    const cy = this.px(y);
    const count = 9;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 12 + Math.random() * 34;
      this.particles.push({
        x: cx + (Math.random() - 0.5) * this.stoneRadius,
        y: cy + (Math.random() - 0.5) * this.stoneRadius,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 26,
        r: 1.5 + Math.random() * 3,
        life: 0,
        max: 0.6 + Math.random() * 0.5,
        color,
      });
    }
  }

  // ----- animation loop ----------------------------------------------

  setActive(active) {
    this.active = active;
    if (active && !this._raf) {
      this._lastTick = performance.now();
      this._raf = requestAnimationFrame((t) => this._tick(t));
    }
  }

  _tick(now) {
    this._raf = null;
    if (!this.active) return;
    const dt = Math.min((now - this._lastTick) / 1000, 0.1);
    this._lastTick = now;

    // particles physics
    if (this.particles.length) {
      for (const p of this.particles) {
        p.life += dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy -= 12 * dt; // gentle upward drift, like smoke
        p.vx *= 0.98;
      }
      this.particles = this.particles.filter((p) => p.life < p.max);
    }
    // expire finished animations
    for (const [key, start] of this.stoneAnims) {
      if (now - start > DROP_MS) this.stoneAnims.delete(key);
    }
    this.dying = this.dying.filter((d) => now - d.start < FADE_MS);

    this.draw(now);
    this._raf = requestAnimationFrame((t) => this._tick(t));
  }

  // ----- drawing ------------------------------------------------------

  draw(now = performance.now()) {
    const { ctx } = this;
    if (!this.cssSize) return;
    ctx.clearRect(0, 0, this.cssSize, this.cssSize);
    this._drawWood();
    this._drawGridLines();
    this._drawCoordinates();
    if (!this.sprites) this._buildSprites();

    // dissolving captured stones
    for (const d of this.dying) {
      const t = Math.min((now - d.start) / FADE_MS, 1);
      const alpha = 1 - t;
      const scale = 1 - t * 0.25;
      this._drawStone(d.x, d.y, d.color, { alpha, scale, shadow: alpha });
    }

    // live stones
    for (let i = 0; i < this.grid.length; i++) {
      const color = this.grid[i];
      if (color === EMPTY) continue;
      const x = i % this.boardSize;
      const y = Math.floor(i / this.boardSize);
      const key = `${x},${y}`;
      const start = this.stoneAnims.get(key);
      if (start !== undefined) {
        const t = Math.min((now - start) / DROP_MS, 1);
        const scale = 1.35 - 0.35 * easeOutBack(t);
        const alpha = Math.min(t * 3, 1);
        this._drawStone(x, y, color, { alpha, scale, shadow: t });
      } else {
        this._drawStone(x, y, color, {});
      }
    }

    this._drawAnnotations(now);
    this._drawGhost();
    this._drawParticles();
  }

  _drawWood() {
    if (!this.woodCache) {
      const c = document.createElement('canvas');
      const dpr = window.devicePixelRatio || 1;
      c.width = this.canvas.width;
      c.height = this.canvas.height;
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const s = this.cssSize;

      const base = g.createLinearGradient(0, 0, s, s);
      base.addColorStop(0, '#e3b966');
      base.addColorStop(0.5, '#d9ab54');
      base.addColorStop(1, '#caa04e');
      g.fillStyle = base;
      g.fillRect(0, 0, s, s);

      // wavy grain lines
      const seedRand = mulberry32(42);
      g.lineWidth = 1;
      for (let i = 0; i < 32; i++) {
        const y0 = seedRand() * s;
        const amp = 2 + seedRand() * 6;
        const freq = 0.004 + seedRand() * 0.01;
        const phase = seedRand() * 10;
        g.strokeStyle = `rgba(130, 86, 30, ${0.05 + seedRand() * 0.07})`;
        g.beginPath();
        for (let x = 0; x <= s; x += 6) {
          const y = y0 + Math.sin(x * freq * Math.PI * 2 + phase) * amp;
          if (x === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
      }
      // soft vignette so the board feels lit from above
      const vig = g.createRadialGradient(s / 2, s / 2.4, s * 0.2, s / 2, s / 2, s * 0.78);
      vig.addColorStop(0, 'rgba(255, 240, 200, 0.10)');
      vig.addColorStop(1, 'rgba(80, 50, 10, 0.16)');
      g.fillStyle = vig;
      g.fillRect(0, 0, s, s);
      this.woodCache = c;
    }
    this.ctx.drawImage(this.woodCache, 0, 0, this.cssSize, this.cssSize);
  }

  _drawGridLines() {
    const { ctx } = this;
    const n = this.boardSize;
    const lo = this.px(0);
    const hi = this.px(n - 1);
    ctx.strokeStyle = 'rgba(60, 38, 12, 0.78)';
    ctx.lineWidth = Math.max(this.cell * 0.035, 0.7);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const p = this.px(i);
      ctx.moveTo(lo, p); ctx.lineTo(hi, p);
      ctx.moveTo(p, lo); ctx.lineTo(p, hi);
    }
    ctx.stroke();

    // border slightly heavier
    ctx.lineWidth = Math.max(this.cell * 0.07, 1.2);
    ctx.strokeRect(lo, lo, hi - lo, hi - lo);

    const stars = STAR_POINTS[n] || [];
    ctx.fillStyle = 'rgba(50, 32, 10, 0.85)';
    for (const [x, y] of stars) {
      ctx.beginPath();
      ctx.arc(this.px(x), this.px(y), Math.max(this.cell * 0.1, 2), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawCoordinates() {
    const { ctx } = this;
    const n = this.boardSize;
    ctx.fillStyle = 'rgba(70, 45, 15, 0.55)';
    ctx.font = `${Math.max(this.cell * 0.34, 8)}px 'Noto Serif', Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const off = this.margin * 0.45;
    for (let i = 0; i < n; i++) {
      const p = this.px(i);
      ctx.fillText(COL_LETTERS[i], p, off);
      ctx.fillText(COL_LETTERS[i], p, this.cssSize - off);
      ctx.fillText(String(n - i), off, p);
      ctx.fillText(String(n - i), this.cssSize - off, p);
    }
  }

  _buildSprites() {
    const make = (color, alpha = 1) => {
      const dpr = window.devicePixelRatio || 1;
      const r = this.stoneRadius;
      const pad = r * 0.6;
      const size = (r + pad) * 2;
      const c = document.createElement('canvas');
      c.width = Math.ceil(size * dpr);
      c.height = Math.ceil(size * dpr);
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.globalAlpha = alpha;
      const cx = size / 2;
      const cy = size / 2;
      let grad;
      if (color === BLACK) {
        grad = g.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r * 1.05);
        grad.addColorStop(0, '#6a6a72');
        grad.addColorStop(0.35, '#2b2b30');
        grad.addColorStop(1, '#050507');
      } else {
        grad = g.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r * 1.05);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.55, '#f2efe6');
        grad.addColorStop(1, '#c9c4b4');
      }
      g.fillStyle = grad;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
      // glossy highlight
      const hl = g.createRadialGradient(cx - r * 0.4, cy - r * 0.45, 0, cx - r * 0.4, cy - r * 0.45, r * 0.55);
      hl.addColorStop(0, `rgba(255,255,255,${color === BLACK ? 0.32 : 0.75})`);
      hl.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = hl;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
      return { canvas: c, size };
    };
    this.sprites = {
      [BLACK]: make(BLACK),
      [WHITE]: make(WHITE),
    };
  }

  _drawStone(x, y, color, { alpha = 1, scale = 1, shadow = 1 }) {
    const { ctx } = this;
    const cx = this.px(x);
    const cy = this.px(y);
    const sprite = this.sprites[color];
    const r = this.stoneRadius;

    if (shadow > 0.05) {
      ctx.save();
      ctx.globalAlpha = 0.28 * shadow * alpha;
      ctx.fillStyle = '#1d1206';
      ctx.beginPath();
      // lift the shadow while the stone is still "in the air"
      const lift = (scale - 1) * r * 1.6;
      ctx.ellipse(cx + r * 0.12, cy + r * 0.22 + lift * 0.2, r * 0.95 * scale, r * 0.8 * scale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    const drawSize = sprite.size * scale;
    ctx.drawImage(sprite.canvas, cx - drawSize / 2, cy - drawSize / 2, drawSize, drawSize);
    ctx.restore();

    if (this.showNumbers) {
      const num = this.moveNumbers.get(`${x},${y}`);
      if (num !== undefined) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color === BLACK ? 'rgba(245,242,232,0.92)' : 'rgba(40,35,28,0.88)';
        ctx.font = `600 ${Math.max(r * (num >= 100 ? 0.72 : 0.9), 8)}px 'Noto Sans', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(num), cx, cy + r * 0.04);
        ctx.restore();
      }
    }
  }

  _drawAnnotations(now) {
    const { ctx } = this;
    const r = this.stoneRadius;

    // bookmark markers: small gold triangle above the stone
    for (const key of this.bookmarks) {
      const [x, y] = key.split(',').map(Number);
      if (this.grid[y * this.boardSize + x] === EMPTY) continue;
      const cx = this.px(x);
      const cy = this.px(y);
      ctx.save();
      ctx.fillStyle = 'rgba(212, 160, 35, 0.95)';
      ctx.beginPath();
      ctx.moveTo(cx, cy - r * 0.45);
      ctx.lineTo(cx - r * 0.3, cy + r * 0.18);
      ctx.lineTo(cx + r * 0.3, cy + r * 0.18);
      ctx.closePath();
      if (this.showNumbers) {
        // keep numbers readable: outline only
        ctx.strokeStyle = 'rgba(212,160,35,0.9)';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      } else {
        ctx.fill();
      }
      ctx.restore();
    }

    // pulsing ring on the last move
    if (this.lastMove) {
      const { x, y, color } = this.lastMove;
      const cx = this.px(x);
      const cy = this.px(y);
      const pulse = 0.5 + 0.5 * Math.sin(now / 480);
      ctx.save();
      ctx.strokeStyle = color === BLACK
        ? `rgba(255, 235, 190, ${0.55 + pulse * 0.35})`
        : `rgba(120, 80, 20, ${0.55 + pulse * 0.35})`;
      ctx.lineWidth = Math.max(r * 0.14, 1.4);
      ctx.beginPath();
      ctx.arc(cx, cy, r * (0.55 + pulse * 0.08), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawGhost() {
    if (!this.ghost) return;
    const { ctx } = this;
    const { x, y, color } = this.ghost;
    const cx = this.px(x);
    const cy = this.px(y);
    const r = this.stoneRadius;
    ctx.save();
    ctx.globalAlpha = this.pendingTap ? 0.65 : 0.45;
    const sprite = this.sprites?.[color];
    if (sprite) ctx.drawImage(sprite.canvas, cx - sprite.size / 2, cy - sprite.size / 2, sprite.size, sprite.size);
    ctx.restore();
    if (this.pendingTap) {
      ctx.save();
      ctx.strokeStyle = 'rgba(212, 160, 35, 0.9)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.35, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawParticles() {
    const { ctx } = this;
    for (const p of this.particles) {
      const t = p.life / p.max;
      ctx.save();
      ctx.globalAlpha = (1 - t) * 0.6;
      ctx.fillStyle = p.color === BLACK ? '#23211e' : '#efece2';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (1 + t * 1.5), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // ----- input ---------------------------------------------------------

  _bindInput() {
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.interactive || e.pointerType !== 'mouse') return;
      const pt = this.pointAt(e.clientX, e.clientY);
      if (pt && this.grid[pt.y * this.boardSize + pt.x] === EMPTY) {
        this.ghost = { ...pt, color: this.ghostColor || BLACK };
      } else {
        this.ghost = null;
      }
      this.draw();
    });

    this.canvas.addEventListener('pointerleave', () => {
      if (this.pendingTap) return;
      this.ghost = null;
      this.draw();
    });

    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.interactive) return;
      const pt = this.pointAt(e.clientX, e.clientY);
      if (!pt) {
        this.pendingTap = null;
        this.ghost = null;
        this.draw();
        return;
      }
      const occupied = this.grid[pt.y * this.boardSize + pt.x] !== EMPTY;
      if (occupied) {
        this.pendingTap = null;
        this.ghost = null;
        this.draw();
        return;
      }
      if (e.pointerType === 'mouse') {
        this.onPlay && this.onPlay(pt.x, pt.y);
        return;
      }
      // touch / pen: first tap previews, second tap on same point confirms
      if (this.pendingTap && this.pendingTap.x === pt.x && this.pendingTap.y === pt.y) {
        this.pendingTap = null;
        this.ghost = null;
        this.onPlay && this.onPlay(pt.x, pt.y);
      } else {
        this.pendingTap = pt;
        this.ghost = { ...pt, color: this.ghostColor || BLACK };
        this.draw();
      }
    });
  }

  setGhostColor(color) {
    this.ghostColor = color;
    if (this.ghost) {
      this.ghost.color = color;
      this.draw();
    }
  }

  clearPending() {
    this.pendingTap = null;
    this.ghost = null;
    this.draw();
  }
}

/** Deterministic small PRNG for the wood grain. */
function mulberry32(seed) {
  let a = seed;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draw a small static thumbnail of a position into a canvas
 * (used by the library cards and the summary page).
 */
export function drawThumbnail(canvas, size, grid) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const css = canvas.clientWidth || 120;
  canvas.width = css * dpr;
  canvas.height = css * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = '#dcae58';
  ctx.fillRect(0, 0, css, css);
  const cell = css / (size + 1);
  const px = (i) => cell * (i + 1);

  ctx.strokeStyle = 'rgba(70,45,15,0.6)';
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (let i = 0; i < size; i++) {
    ctx.moveTo(px(0), px(i)); ctx.lineTo(px(size - 1), px(i));
    ctx.moveTo(px(i), px(0)); ctx.lineTo(px(i), px(size - 1));
  }
  ctx.stroke();

  const r = cell * 0.44;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === EMPTY) continue;
    const x = i % size;
    const y = Math.floor(i / size);
    ctx.fillStyle = grid[i] === BLACK ? '#1c1c20' : '#f4f1e8';
    ctx.beginPath();
    ctx.arc(px(x), px(y), r, 0, Math.PI * 2);
    ctx.fill();
    if (grid[i] === WHITE) {
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
  }
}
