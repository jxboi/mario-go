/**
 * Ambient background canvas — slow drifting ink-wash particles and
 * occasional falling "leaf" petals, kept deliberately cheap.
 */

export class AmbientBackground {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mist = [];
    this.petals = [];
    this.running = false;
    this.lastTime = 0;
    this.resize = this.resize.bind(this);
    this.tick = this.tick.bind(this);
    window.addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stop();
      else this.start();
    });
    this.resize();
    this.seed();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  seed() {
    const mistCount = 14;
    for (let i = 0; i < mistCount; i++) {
      this.mist.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        r: 120 + Math.random() * 260,
        vx: 2 + Math.random() * 5,
        drift: Math.random() * Math.PI * 2,
        alpha: 0.015 + Math.random() * 0.03,
      });
    }
    for (let i = 0; i < 7; i++) this.petals.push(this.makePetal(true));
  }

  makePetal(anywhere = false) {
    return {
      x: Math.random() * this.width,
      y: anywhere ? Math.random() * this.height : -20,
      size: 3 + Math.random() * 5,
      vy: 6 + Math.random() * 10,
      sway: Math.random() * Math.PI * 2,
      swaySpeed: 0.4 + Math.random() * 0.7,
      spin: Math.random() * Math.PI * 2,
      spinSpeed: (Math.random() - 0.5) * 1.4,
      hue: 18 + Math.random() * 14,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
  }

  tick(now) {
    if (!this.running) return;
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    const { ctx } = this;
    ctx.clearRect(0, 0, this.width, this.height);

    for (const m of this.mist) {
      m.drift += dt * 0.12;
      m.x += m.vx * dt;
      m.y += Math.sin(m.drift) * 3 * dt;
      if (m.x - m.r > this.width) m.x = -m.r;
      const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r);
      g.addColorStop(0, `rgba(70, 60, 50, ${m.alpha})`);
      g.addColorStop(1, 'rgba(70, 60, 50, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = 0; i < this.petals.length; i++) {
      const p = this.petals[i];
      p.sway += p.swaySpeed * dt;
      p.spin += p.spinSpeed * dt;
      p.y += p.vy * dt;
      p.x += Math.sin(p.sway) * 14 * dt;
      if (p.y > this.height + 20) this.petals[i] = this.makePetal();
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.spin);
      ctx.fillStyle = `hsla(${p.hue}, 45%, 62%, 0.22)`;
      ctx.beginPath();
      ctx.ellipse(0, 0, p.size, p.size * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    requestAnimationFrame(this.tick);
  }
}
