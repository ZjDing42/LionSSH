export interface FileEntry { name: string; path: string; directory: boolean; symlink: boolean; size: number | null; modified: number | null }
export interface FileListing { path: string; entries: FileEntry[] }
export interface FileContent { kind: 'text' | 'image'; text?: string; data?: string; encoding?: string; revision?: string; size: number }
export interface FileLocation { profileId: string | null; path: string }
export interface FileTransfer {
  id: string; name: string; source: FileLocation; target: FileLocation; direction: 'upload' | 'download' | 'copy';
  status: 'queued' | 'scanning' | 'running' | 'paused' | 'waiting' | 'conflict' | 'failed' | 'completed' | 'cancelled';
  total: number | null; transferred: number; skipped: number; nativeDrop: boolean; speed: number; elapsed: number; remaining: number | null;
  error: string | null; createdAt: number; currentPath: string;
}
export interface FileDrop { type: 'enter' | 'over' | 'leave' | 'drop'; paths?: string[]; sources?: FileLocation[]; x?: number; y?: number; logical?: boolean }
export interface FileDropRegion { left: number; top: number; right: number; bottom: number; scale: number; moveAllowed?: boolean; moveRows?: { top: number; bottom: number; allowed: boolean }[] }
