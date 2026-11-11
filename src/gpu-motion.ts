export type GpuCloseMotion = 'blur' | 'particles';

/** Local presentation only: snapshots never replace the live table or issue process actions. */
export function createGpuPanelMotion(overlay: HTMLElement, panel: HTMLElement, backdrop: HTMLElement, origin: HTMLElement) {
  let disposed = false;
  let frame = 0;
  let cancelTimeline: (() => void) | undefined;
  const transient = new Set<HTMLElement>();
  const originOpacity = origin.style.opacity;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const smooth = (a: number, b: number, t: number) => {
    const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
    return x * x * (3 - 2 * x);
  };
  const box = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect(), parent = overlay.getBoundingClientRect();
    return { x: rect.left - parent.left, y: rect.top - parent.top, w: rect.width, h: rect.height };
  };
  function attach<T extends HTMLElement>(element: T): T {
    element.setAttribute('aria-hidden', 'true');
    element.inert = true;
    transient.add(element);
    overlay.append(element);
    return element;
  }
  function remove(element: HTMLElement) { element.remove(); transient.delete(element); }
  function timeline(duration: number, draw: (t: number) => void): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    if (reduced()) { draw(1); return Promise.resolve(true); }
    return new Promise((resolve, reject) => {
      const start = performance.now();
      cancelTimeline = () => { cancelAnimationFrame(frame); resolve(false); };
      const tick = (now: number) => {
        if (disposed) { resolve(false); return; }
        try {
          const t = Math.min(1, (now - start) / duration);
          draw(t);
          if (t < 1) frame = requestAnimationFrame(tick);
          else { cancelTimeline = undefined; resolve(true); }
        } catch (error) { cancelTimeline = undefined; reject(error); }
      };
      tick(start);
    });
  }
  function clone(element: HTMLElement, width: number, height: number) {
    const copy = element.cloneNode(true) as HTMLElement;
    copy.classList.add('gpu-motion-layer');
    copy.style.width = `${width}px`; copy.style.height = `${height}px`;
    copy.style.opacity = '1'; copy.style.visibility = 'visible';
    copy.querySelectorAll('.gpu-user-popover').forEach(node => node.remove());
    for (const node of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) {
      for (const name of ['id', 'aria-controls', 'aria-labelledby', 'aria-describedby']) node.removeAttribute(name);
    }
    return copy;
  }
  async function morph(expanding: boolean) {
    const source = box(origin), target = box(panel);
    if (reduced() || !source.w || !source.h || !origin.isConnected) {
      panel.style.visibility = expanding ? 'visible' : 'hidden';
      backdrop.style.opacity = expanding ? '1' : '0';
      return;
    }
    const shell = document.createElement('div'); shell.className = 'gpu-process-morph';
    const cardLayer = clone(origin, source.w, source.h), detailLayer = clone(panel, target.w, target.h);
    shell.append(cardLayer, detailLayer); attach(shell);
    // Preserve a scrolled table in the closing snapshot.
    const liveScroll = panel.querySelector('.gpu-process-table-wrap');
    const copyScroll = detailLayer.querySelector('.gpu-process-table-wrap');
    if (liveScroll && copyScroll) { copyScroll.scrollTop = liveScroll.scrollTop; copyScroll.scrollLeft = liveScroll.scrollLeft; }
    panel.style.visibility = 'hidden'; origin.style.opacity = '0';
    try {
      await timeline(460, t => {
        const geometry = 1 - Math.pow(1 - t, 3), q = expanding ? geometry : 1 - geometry;
        const width = lerp(source.w, target.w, q), height = lerp(source.h, target.h, q);
        const blend = smooth(.18, .67, t), detailOpacity = expanding ? blend : 1 - blend;
        shell.style.left = `${lerp(source.x, target.x, q)}px`; shell.style.top = `${lerp(source.y, target.y, q)}px`;
        shell.style.width = `${width}px`; shell.style.height = `${height}px`;
        shell.style.borderRadius = `${lerp(10, 16, q)}px`;
        shell.style.filter = `blur(${6 * smooth(0, .2, t) * (1 - smooth(.56, 1, t))}px)`;
        shell.style.boxShadow = `0 ${20 * q}px ${70 * q}px #0003`;
        cardLayer.style.transform = `scale(${width / source.w}, ${height / source.h})`;
        detailLayer.style.transform = `scale(${width / target.w}, ${height / target.h})`;
        cardLayer.style.opacity = String(1 - detailOpacity); detailLayer.style.opacity = String(detailOpacity);
        backdrop.style.opacity = String(expanding ? smooth(0, .85, t) : 1 - smooth(.08, .94, t));
      });
    } finally {
      // The final clone and live destination occupy the same bounds in this frame.
      panel.style.visibility = expanding ? 'visible' : 'hidden';
      origin.style.opacity = originOpacity;
      backdrop.style.opacity = expanding ? '1' : '0';
      remove(shell);
    }
  }
  async function dissolve() {
    if (reduced()) { panel.style.visibility = 'hidden'; backdrop.style.opacity = '0'; return; }
    const bounds = box(panel), width = overlay.clientWidth, height = overlay.clientHeight;
    const canvas = document.createElement('canvas'); canvas.className = 'gpu-process-particles';
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(ratio, ratio); attach(canvas);
    try {
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = Math.ceil(bounds.w); maskCanvas.height = Math.ceil(bounds.h);
      const mask = maskCanvas.getContext('2d', { willReadFrequently: true });
      if (!mask) return;
      mask.fillStyle = '#fff'; mask.textBaseline = 'top';
      const panelRect = panel.getBoundingClientRect();
      const tableRect = panel.querySelector('.gpu-process-table-wrap')?.getBoundingClientRect();
      const headBottom = panel.querySelector('thead')?.getBoundingClientRect().bottom || 0;
      for (const element of panel.querySelectorAll<HTMLElement>('h2, p, th, td, footer > span')) {
        const rect = element.getBoundingClientRect();
        const inTable = element.matches('th, td');
        const left = Math.max(rect.left, panelRect.left, inTable ? tableRect?.left || 0 : 0);
        const right = Math.min(rect.right, panelRect.right, inTable ? tableRect?.right || Infinity : Infinity);
        const top = Math.max(rect.top, panelRect.top, inTable ? tableRect?.top || 0 : 0, element.matches('td') ? headBottom : 0);
        const bottom = Math.min(rect.bottom, panelRect.bottom, inTable ? tableRect?.bottom || Infinity : Infinity);
        if (right <= left || bottom <= top) continue;
        const range = document.createRange(); range.selectNodeContents(element);
        const textRect = range.getBoundingClientRect(), style = getComputedStyle(element);
        mask.save(); mask.beginPath(); mask.rect(left - panelRect.left, top - panelRect.top, right - left, bottom - top); mask.clip();
        mask.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        mask.fillText(element.textContent?.trim() || '', textRect.left - panelRect.left, textRect.top - panelRect.top);
        mask.restore();
      }
      const pixels = mask.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
      let seed = 20261111;
      const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      const particles: { x: number; y: number; dx: number; dy: number; radius: number; power: number; birth: number; bend: number }[] = [];
      const add = (x: number, y: number, ink: boolean) => {
        const u = x / bounds.w, v = y / bounds.h;
        const angle = Math.atan2((v - .5) * 2, (u - .5) * 2) + (random() - .5) * .65;
        const distance = (105 + random() * 140) * .62;
        particles.push({ x: bounds.x + x, y: bounds.y + y, dx: Math.cos(angle) * distance, dy: Math.sin(angle) * distance * .75,
          radius: .4 + random() * .4, power: ink ? .85 + random() * .15 : .6 + random() * .35,
          birth: .04 + Math.min(u, 1 - u, v, 1 - v) * 1.04, bend: (random() - .5) * 26 });
      };
      // Bound sampling work on large windows without enlarging the particles.
      const step = Math.max(2, Math.ceil(Math.sqrt(bounds.w * bounds.h / 60000)));
      for (let y = 2; y < maskCanvas.height - 2; y += step) for (let x = 2; x < maskCanvas.width - 2; x += step) {
        if (pixels[(y * maskCanvas.width + x) * 4 + 3] > 75 && random() > .15) add(x, y, true);
      }
      for (let i = 0, count = Math.min(2800, Math.round(bounds.w * bounds.h / 65)); i < count; i++) add(5 + random() * (bounds.w - 10), 5 + random() * (bounds.h - 10), false);
      const dark = document.documentElement.dataset.theme === 'dark';
      const probe = document.createElement('span'); overlay.append(probe);
      probe.style.color = dark ? '#111b2b' : 'var(--blue)';
      const core = getComputedStyle(probe).color; probe.remove();
      const halo = dark ? 'rgb(38,55,78)' : 'rgb(255,255,255)';
      const rgba = (color: string, alpha: number) => `rgba(${color.match(/[\d.]+/g)!.slice(0, 3).join(',')},${alpha})`;
      const sprite = document.createElement('canvas'); sprite.width = 64; sprite.height = 64;
      const glow = sprite.getContext('2d')!;
      const ring = glow.createRadialGradient(32, 32, 0, 32, 32, 32);
      ring.addColorStop(0, rgba(core, 1));
      if (dark) {
        ring.addColorStop(.19, rgba(core, 1)); ring.addColorStop(.29, rgba(core, .5)); ring.addColorStop(.58, rgba(halo, .16));
      } else {
        ring.addColorStop(.17, rgba(core, 1)); ring.addColorStop(.24, rgba(halo, .98)); ring.addColorStop(.48, rgba(halo, .42));
      }
      ring.addColorStop(1, rgba(halo, 0)); glow.fillStyle = ring; glow.fillRect(0, 0, 64, 64);
      const position = (p: typeof particles[number], age: number) => {
        const f = Math.max(0, (age - .18) / .82), travel = Math.pow(f, 1.4), curl = Math.sin(f * Math.PI) * p.bend;
        return { x: p.x + p.dx * travel - curl * .35, y: p.y + p.dy * travel + curl };
      };
      await timeline(760, t => {
        panel.style.filter = `blur(${8 * smooth(0, .14, t)}px)`;
        const progress = Math.max(0, Math.min(1, (t - .04) / .52));
        if (progress > 0) {
          const lo = progress * 50, hi = 100 - lo;
          const stops = `transparent ${lo - 1}%, #000 ${lo + 1}%, #000 ${hi - 1}%, transparent ${hi + 1}%`;
          panel.style.maskImage = `linear-gradient(to right, ${stops}), linear-gradient(to bottom, ${stops})`;
          panel.style.maskComposite = 'intersect';
        }
        panel.style.opacity = String(1 - smooth(.54, .6, t)); backdrop.style.opacity = String(1 - smooth(.14, .84, t));
        ctx.clearRect(0, 0, width, height);
        for (const p of particles) {
          const age = (t - p.birth) / .4;
          if (age <= 0 || age >= 1) continue;
          const alpha = p.power * smooth(0, .1, age) * (1 - smooth(.68, 1, age));
          if (alpha < .015) continue;
          const pos = position(p, age), prior = position(p, Math.max(0, age - .025));
          const radius = p.radius * (1 - age * .25), bloom = radius * (dark ? 5.2 : 4.2);
          if (age > .23) {
            ctx.globalAlpha = alpha * (dark ? .22 : .32); ctx.strokeStyle = dark ? core : halo;
            ctx.lineWidth = radius * .65; ctx.lineCap = 'round';
            ctx.beginPath(); ctx.moveTo(prior.x, prior.y); ctx.lineTo(pos.x, pos.y); ctx.stroke();
          }
          ctx.globalAlpha = alpha; ctx.drawImage(sprite, pos.x - bloom, pos.y - bloom, bloom * 2, bloom * 2);
          ctx.fillStyle = core; ctx.beginPath(); ctx.arc(pos.x, pos.y, radius * .9, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
      });
    } finally {
      panel.style.visibility = 'hidden'; panel.style.filter = ''; panel.style.opacity = '';
      panel.style.maskImage = ''; panel.style.maskComposite = ''; backdrop.style.opacity = '0'; remove(canvas);
    }
  }
  return {
    open: () => morph(true),
    close: (route: GpuCloseMotion) => route === 'particles' ? dissolve() : morph(false),
    dispose() {
      disposed = true; cancelTimeline?.(); cancelTimeline = undefined;
      transient.forEach(element => element.remove()); transient.clear();
      origin.style.opacity = originOpacity;
    },
  };
}
