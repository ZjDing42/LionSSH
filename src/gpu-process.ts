import type { GpuCard } from './types';

/** Each user's highest PID determines the front-to-back order. */
export function gpuUsers(card: GpuCard): string[] {
  return [...new Set([...(card.processes || [])].sort((a, b) => b.pid - a.pid)
    .map(process => process.username).filter((name): name is string => Boolean(name)))];
}

export function processElapsed(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '—';
  const value = Math.max(0, Math.floor(seconds));
  const days = Math.floor(value / 86400);
  const clock = [Math.floor(value / 3600) % 24, Math.floor(value / 60) % 60, value % 60]
    .map(part => String(part).padStart(2, '0')).join(':');
  return `${days ? `${days}d ` : ''}${clock}`;
}
