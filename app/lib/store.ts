// localStorage-backed stores: watch history, my list, api response cache.
// everything reads synchronously so screens render instantly; writers
// persist immediately and bump subscribers via a tiny pub/sub.

export interface HistoryEntry {
  mid: string;          // imdb/cinemeta id
  type: string;         // movie | series
  name: string;
  poster?: string;
  backdrop?: string;
  hash: string;         // torrent infoHash used
  fileIdx: number;
  ep?: string;          // "S1E2" for series
  pos: number;          // seconds
  dur: number;
  ts: number;           // last watched
}

export interface ListEntry {
  mid: string;
  type: string;
  name: string;
  poster?: string;
  imdbRating?: string;
  releaseInfo?: string;
  addedAt: number;
}

const HIST_KEY = "ks:history";
const LIST_KEY = "ks:mylist";

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch {}
  emit();
}

const subs = new Set<() => void>();
export function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}
function emit() { for (const f of subs) f(); }

// ---------- history ----------

export function getHistory(): HistoryEntry[] {
  const map = read<Record<string, HistoryEntry>>(HIST_KEY, {});
  return Object.values(map).sort((a, b) => b.ts - a.ts);
}

export function continueWatching(): HistoryEntry[] {
  return getHistory().filter((h) => h.pos > 25 && (h.dur <= 0 || h.pos < h.dur * 0.96));
}

export function saveProgress(e: HistoryEntry) {
  const map = read<Record<string, HistoryEntry>>(HIST_KEY, {});
  map[e.mid] = e;
  // cap at 60 entries
  const keys = Object.keys(map);
  if (keys.length > 60) {
    const sorted = Object.values(map).sort((a, b) => a.ts - b.ts);
    for (const old of sorted.slice(0, keys.length - 60)) delete map[old.mid];
  }
  write(HIST_KEY, map);
}

export function removeHistory(mid: string) {
  const map = read<Record<string, HistoryEntry>>(HIST_KEY, {});
  delete map[mid];
  write(HIST_KEY, map);
}

export function historyEntry(mid: string): HistoryEntry | null {
  return read<Record<string, HistoryEntry>>(HIST_KEY, {})[mid] ?? null;
}

// ---------- my list ----------

export function getMyList(): ListEntry[] {
  const map = read<Record<string, ListEntry>>(LIST_KEY, {});
  return Object.values(map).sort((a, b) => b.addedAt - a.addedAt);
}

export function inMyList(mid: string): boolean {
  return !!read<Record<string, ListEntry>>(LIST_KEY, {})[mid];
}

export function toggleMyList(e: ListEntry): boolean {
  const map = read<Record<string, ListEntry>>(LIST_KEY, {});
  if (map[e.mid]) { delete map[e.mid]; write(LIST_KEY, map); return false; }
  map[e.mid] = e;
  write(LIST_KEY, map);
  return true;
}

// ---------- json cache ----------

type CacheEntry = { t: number; v: unknown };
const MAX_CACHE_ENTRIES = 64, MAX_CACHE_CHARS = 2 * 1024 * 1024;
const mem = new Map<string, { entry: CacheEntry; chars: number }>();
const inFlight = new Map<string, Promise<unknown>>();
let chars = 0;

function remember(key: string, entry: CacheEntry, size: number) {
  const old = mem.get(key);
  if (old) {
    chars -= old.chars;
    mem.delete(key);
  }
  if (size > MAX_CACHE_CHARS) return;
  mem.set(key, { entry, chars: size });
  chars += size;
  while (mem.size > MAX_CACHE_ENTRIES || chars > MAX_CACHE_CHARS) {
    const first = mem.keys().next().value;
    if (first === undefined) break;
    chars -= mem.get(first)!.chars;
    mem.delete(first);
  }
}

function readRaw(key: string): string | null {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem(key); } catch { return null; }
}

function getEntry(key: string): CacheEntry | null {
  const hit = mem.get(key);
  if (hit) {
    mem.delete(key);
    mem.set(key, hit);
    return hit.entry;
  }
  const raw = readRaw(`ks:c:${key}`);
  if (raw == null) return null;
  try {
    const entry = JSON.parse(raw) as CacheEntry;
    if (!entry || typeof entry.t !== "number") return null;
    remember(key, entry, raw.length);
    return entry;
  } catch {
    return null;
  }
}

let storageIndex: Map<string, number> | null = null;

function cacheStorageIndex(): Map<string, number> {
  if (storageIndex) return storageIndex;
  const idx = new Map<string, number>();
  storageIndex = idx;
  if (typeof window === "undefined") return idx;
  try {
    const items: { k: string; t: number; n: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith("ks:c:")) continue;
      const raw = localStorage.getItem(k);
      if (raw == null) continue;
      let t = 0;
      try { const p = JSON.parse(raw); if (typeof p?.t === "number") t = p.t; } catch {}
      items.push({ k, t, n: raw.length });
    }
    items.sort((a, b) => a.t - b.t);
    for (const x of items) idx.set(x.k, x.n);
  } catch {}
  return idx;
}

function persistCache(key: string, text: string) {
  if (typeof window === "undefined" || text.length > MAX_CACHE_CHARS) return;
  const idx = cacheStorageIndex();
  const fullKey = `ks:c:${key}`;
  idx.delete(fullKey);
  idx.set(fullKey, text.length);
  let total = 0;
  for (const n of idx.values()) total += n;
  while ((idx.size > MAX_CACHE_ENTRIES || total > MAX_CACHE_CHARS) && idx.size > 1) {
    const first = idx.keys().next().value;
    if (first === undefined) break;
    try { localStorage.removeItem(first); } catch {}
    total -= idx.get(first) ?? 0;
    idx.delete(first);
  }
  try { localStorage.setItem(fullKey, text); } catch {}
}

/** cached fetch: returns stored value instantly if fresh, else fetches;
 *  a stale entry is held only when the refetch throws or yields null. */
export async function cachedJson<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = getEntry(key) as { t: number; v: T } | null;
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;
  const p = Promise.resolve().then(async () => {
    try {
      const v = await fn();
      if (v == null) {
        if (hit) return hit.v;
        return v;
      }
      const entry = { t: Date.now(), v };
      const text = JSON.stringify(entry);
      remember(key, entry, text.length);
      persistCache(key, text);
      return v;
    } catch (e) {
      if (hit) return hit.v;
      throw e;
    } finally {
      inFlight.delete(key);
    }
  });
  inFlight.set(key, p);
  return p;
}

/** instant read without fetching — seed UI from cache synchronously */
export function peekCached<T>(key: string): T | null {
  return (getEntry(key)?.v as T) ?? null;
}
