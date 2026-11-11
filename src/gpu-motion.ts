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
          const t = Math.max(0, Math.min(1, (now - start) / duration));
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
        // Closing follows q = (1 - t)^3. Match the blend and blur by position in
        // either direction so the card and table exchange at the same size.
        const returnTime = 1 - Math.cbrt(q);
        const detailOpacity = 1 - smooth(.18, .67, returnTime);
        shell.style.left = `${lerp(source.x, target.x, q)}px`; shell.style.top = `${lerp(source.y, target.y, q)}px`;
        shell.style.width = `${width}px`; shell.style.height = `${height}px`;
        shell.style.borderRadius = `${lerp(10, 16, q)}px`;
        shell.style.filter = `blur(${6 * smooth(0, .2, returnTime) * (1 - smooth(.56, 1, returnTime))}px)`;
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
  return {
    open: () => morph(true),
    close: () => morph(false),
    dispose() {
      disposed = true; cancelTimeline?.(); cancelTimeline = undefined;
      transient.forEach(element => element.remove()); transient.clear();
      origin.style.opacity = originOpacity;
    },
  };
}
