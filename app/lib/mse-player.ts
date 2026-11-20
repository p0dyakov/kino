import { ENGINE } from "./api";

const MAX_CHUNK = 4 * 1024 * 1024;
const MAX_QUEUE = 32 * 1024 * 1024;

export interface Tracks {
  video: { codec: string; tag: string; width: number; height: number; mse: boolean };
  audio: { idx: number; lang: string; title: string; codec: string; channels: number; default: boolean }[];
  duration: number;
}

// Streams engine fMP4 into a SourceBuffer. Each /fmp4?t=X response is
// timestamped relative to that request's start (tfdt ≈ 0), so before
// appending a new stream we set SourceBuffer.timestampOffset to the seek
// target — fragments then land at [t, t+Δ] on the real timeline.
export class MsePlayer {
  private ms = new MediaSource();
  private sb?: SourceBuffer;
  private queue: Uint8Array[] = [];
  private queueSize = 0;
  private abort?: AbortController;
  private destroyed = false;
  private ended = false;
  private pendingSeek: number | null = null;
  private url: string;
  private jumpTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private watchTimer?: ReturnType<typeof setInterval>;
  private contTimer?: ReturnType<typeof setTimeout>;
  private stallRetries = 0;
  private pendingOffset: number | null = null;
  private evLog: { t: number; ev: string; ct: number }[] = [];

  constructor(
    private video: HTMLVideoElement,
    private sessionId: string,
    private tracks: Tracks,
    public audioIdx: number,
    startAt = 0,
    private diagnostics = false
  ) {
    this.url = this.sourceUrl(this.ms, startAt);
    if (this.diagnostics) {
      for (const ev of ["seeking", "seeked", "waiting", "canplay", "stalled",
                        "playing", "pause", "error", "suspend", "emptied", "abort"]) {
        video.addEventListener(ev, () => {
          this.evLog.push({ t: Math.round(performance.now() / 100) / 10, ev, ct: +video.currentTime.toFixed(2) });
          if (this.evLog.length > 60) this.evLog.shift();
        });
      }
    }
  }

  src() { return this.url; }

  private sourceUrl(ms: MediaSource, at: number) {
    const url = URL.createObjectURL(ms);
    ms.addEventListener("sourceopen", () => {
      if (this.ms === ms) this.open(at);
    }, { once: true });
    return url;
  }

  private open(at: number) {
    if (this.destroyed || this.sb) return;
    const tag = this.tracks.video.tag;
    const candidates = [
      `video/mp4; codecs="${tag}, mp4a.40.2"`,
      "video/mp4",
      `video/mp4; codecs="avc1.64001f, mp4a.40.2"`,
    ];
    for (const mime of candidates) {
      if (!MediaSource.isTypeSupported(mime)) continue;
      try {
        this.sb = this.ms.addSourceBuffer(mime);
        this.sb.mode = "segments";
        const sb = this.sb;
        sb.addEventListener("updateend", () => { if (this.sb === sb) this.pump(); });
        if (this.tracks.duration > 0) {
          try { this.ms.duration = this.tracks.duration; } catch {}
        }
        break;
      } catch {
        continue;
      }
    }
    if (!this.sb) return;
    // resuming mid-file: the stream starts at startAt while currentTime is 0 —
    // pendingSeek lets snapIfGap pull the playhead onto the first range
    const target = this.pendingSeek ?? at;
    if (target <= 0) this.pendingSeek = null;
    if (target > 0) {
      this.pendingSeek = target;
      this.sb.timestampOffset = target;
      this.armSeekWatch();
      // a fresh MediaSource (audio switch, resume) resets the element to 0 —
      // seek it to the target as soon as metadata exists; snapIfGap stays as
      // the fallback for keyframe drift
      const v = this.video;
      const seek = () => {
        if (this.destroyed) return;
        try { v.currentTime = target; } catch {}
      };
      if (v.readyState >= 1) seek();
      else v.addEventListener("loadedmetadata", seek, { once: true });
    }
    void this.fetchFrom(target);
  }

  private pump() {
    if (this.destroyed || !this.sb || this.sb.updating) return;
    const chunk = this.queue[0];
    if (!chunk) {
      if (this.ended) this.continueAtFrontier();
      return;
    }
    try {
      // apply a stream-start offset only between appends — setting it while
      // updating throws, and the new stream's fragments would land at 0
      if (this.pendingOffset != null) {
        if (this.ms.readyState === "open") this.sb.abort();
        this.sb.timestampOffset = this.pendingOffset;
        this.pendingOffset = null;
      }
      let count = 1;
      let size = chunk.byteLength;
      while (count < this.queue.length && size + this.queue[count].byteLength <= MAX_CHUNK) {
        size += this.queue[count++].byteLength;
      }
      let batch = chunk;
      if (count > 1) {
        batch = new Uint8Array(size);
        let offset = 0;
        for (let i = 0; i < count; i++) {
          batch.set(this.queue[i], offset);
          offset += this.queue[i].byteLength;
        }
      }
      this.sb.appendBuffer(batch.buffer as ArrayBuffer);
      this.queue.splice(0, count);
      this.queueSize -= size;
    } catch {
      // buffer full (QuotaExceededError) or transient failure: nothing is
      // updating so updateend will never refire — retry on a timer
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.pump(), 400);
    }
  }

  private bufferedAhead() {
    const v = this.video, b = v.buffered;
    for (let i = 0; i < b.length; i++)
      if (b.start(i) <= v.currentTime && v.currentTime <= b.end(i))
        return b.end(i) - v.currentTime;
    return 0;
  }

  private async fetchFrom(t: number) {
    this.abort?.abort();
    const ctl = new AbortController();
    this.abort = ctl;
    const url = `${ENGINE}/fmp4/${this.sessionId}?t=${Math.max(0, t)}&audio=${this.audioIdx}`;
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      for (;;) {
        if (this.destroyed || ctl.signal.aborted) break;
        // back-pressure: on cached files the engine pushes 100+ MB/s — pause
        // reads while plenty is buffered ahead or the queue is fat, otherwise
        // the SourceBuffer hits its quota and pump deadlocks
        while (this.bufferedAhead() > 30 || this.queueSize > MAX_QUEUE) {
          if (this.destroyed || ctl.signal.aborted) return;
          await new Promise((r) => setTimeout(r, 250));
        }
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<never>((_, rej) => {
            stallTimer = setTimeout(() => rej(new Error("stream-stall")), 25000);
          }),
        ]).finally(() => clearTimeout(stallTimer));
        if (this.destroyed || ctl.signal.aborted) return;
        if (done) { this.ended = true; this.pump(); break; }
        this.stallRetries = 0;
        // copy into tight, bounded buffers — stream chunks are views over a
        // shared pool (pinning megabytes each), and a busy main thread lets
        // them coalesce into multi-GB reads whose appendBuffer wedges the
        // MSE parser for minutes until WebKit resets the element
        for (let off = 0; off < value.byteLength; off += MAX_CHUNK) {
          const take = Math.min(MAX_CHUNK, value.byteLength - off);
          while (this.queueSize + take > MAX_QUEUE || this.bufferedAhead() > 30) {
            await new Promise((r) => setTimeout(r, 50));
            if (this.destroyed || ctl.signal.aborted) return;
          }
          const part = value.slice(off, off + take);
          this.queue.push(part);
          this.queueSize += part.byteLength;
          this.pump();
        }
      }
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return;
      if ((e as Error).message === "stream-stall" && this.stallRetries++ < 3 &&
          !this.destroyed && !ctl.signal.aborted) {
        // producer stalled mid-stream — retry the request once
        void this.startStream(t);
        return;
      }
      console.warn("fmp4 fetch", e);
    }
  }

  // re-request the stream at a position — used for seeks and audio switches.
  // fragments carry absolute timestamps, so the new stream can be appended
  // straight on top of what's already buffered — no remove() needed, which
  // also keeps already-watched data available for back-seeks.
  jumpTo(t: number) {
    this.ended = false;
    this.pendingSeek = t;
    this.stallRetries = 0;
    clearTimeout(this.contTimer);
    this.contTimer = undefined;
    this.armSeekWatch();
    // debounce: key-repeat / scrub drags fire seeking constantly — coalesce
    // into a single producer restart at the final position
    clearTimeout(this.jumpTimer);
    this.jumpTimer = setTimeout(() => {
      this.jumpTimer = undefined;
      this.startStream(t);
    }, 140);
  }

  handleSeek(t: number) {
    if (!this.sb) return;
    if (this.pendingSeek != null && Math.abs(this.pendingSeek - t) <= 0.001) return;
    const b = this.video.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= t && t < b.end(i)) {
        clearTimeout(this.jumpTimer);
        this.jumpTimer = undefined;
        this.pendingSeek = null;
        if (this.ended) this.continueAtFrontier();
        return;
      }
    }
    this.jumpTo(t);
  }

  // (re)open a produce stream at t — shared by jumpTo and frontier continue
  private startStream(t: number) {
    this.ended = false;
    clearTimeout(this.contTimer);
    this.contTimer = undefined;
    this.queue.length = 0;
    this.queueSize = 0;
    this.abort?.abort();
    // stream tfdt starts at 0 relative to t — defer the shift until the
    // buffer isn't mid-append (applied in pump)
    this.pendingOffset = t;
    void this.fetchFrom(t);
  }

  private drained() {
    return !this.destroyed && this.ended && this.pendingSeek == null &&
      this.queue.length === 0 && this.sb && !this.sb.updating && this.ms.readyState === "open";
  }

  private bufferedFrontier() {
    const v = this.video, b = v.buffered, t = v.currentTime;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= t && t <= b.end(i) + 0.08) return Math.max(t, b.end(i));
    }
    return t;
  }

  private continueAtFrontier() {
    if (!this.drained() || this.contTimer !== undefined) return;
    const duration = this.tracks.duration;
    if (duration > 0 && this.bufferedFrontier() >= duration - 0.25) {
      try { this.ms.endOfStream(); } catch {}
      return;
    }
    this.contTimer = setTimeout(() => {
      this.contTimer = undefined;
      if (!this.drained()) return;
      if (this.bufferedAhead() > 2) this.continueAtFrontier();
      else this.startStream(this.bufferedFrontier());
    }, 800);
  }

  // pendingSeek may be resolvable only after appends that land *after* the
  // fetch loop already exited — poll buffered until the gap is closed
  private armSeekWatch() {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => {
      if (this.destroyed || this.pendingSeek == null) {
        clearInterval(this.watchTimer);
        this.watchTimer = undefined;
        return;
      }
      this.snapIfGap();
    }, 250);
  }

  // After a seek the new stream may land on a keyframe AFTER currentTime,
  // leaving a gap the video element waits on forever. Once real data exists
  // at the requested point, snap the playhead onto it.
  private snapIfGap() {
    const requested = this.pendingSeek;
    if (requested == null || this.destroyed || this.jumpTimer !== undefined) return;
    const v = this.video;
    const b = v.buffered;
    for (let i = 0; i < b.length; i++) {
      const start = b.start(i), end = b.end(i);
      if (start > requested + 0.5 || end < Math.max(start, requested) + 0.08 ||
          v.currentTime > end) continue;
      this.pendingSeek = null;
      if (v.currentTime < start || Math.abs(v.currentTime - requested) > 0.05)
        v.currentTime = Math.max(start + 0.04, requested);
      if (this.ended) this.continueAtFrontier();
      return;
    }
    // nothing covers the request — the keyframe may have landed past it:
    // snap forward onto the nearest fragment within a few seconds
    for (let i = 0; i < b.length; i++) {
      const start = b.start(i), end = b.end(i);
      const gap = start - requested;
      if (gap <= 0.5 || gap > 3 || end - start < 0.04 || v.currentTime > start) continue;
      this.pendingSeek = null;
      v.currentTime = start + 0.04;
      if (this.ended) this.continueAtFrontier();
      return;
    }
  }

  setAudio(idx: number, atTime: number) {
    if (this.destroyed || idx === this.audioIdx) return;
    const shouldPlay = !this.video.paused && !this.video.ended;
    this.abort?.abort();
    clearTimeout(this.jumpTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.contTimer);
    clearInterval(this.watchTimer);
    this.jumpTimer = this.retryTimer = this.contTimer = undefined;
    this.watchTimer = undefined;
    this.queue.length = 0;
    this.queueSize = 0;
    this.ended = false;
    this.stallRetries = 0;
    this.pendingOffset = null;
    this.pendingSeek = atTime;
    this.audioIdx = idx;
    this.sb = undefined;
    const oldUrl = this.url;
    this.ms = new MediaSource();
    this.url = this.sourceUrl(this.ms, atTime);
    this.video.src = this.url;
    URL.revokeObjectURL(oldUrl);
    if (shouldPlay) void this.video.play().catch(() => {});
  }

  // full state snapshot for /api/playerdebug — engine-side truth, no AX needed
  debugJson() {
    const v = this.video;
    const tl = (r: TimeRanges) => {
      const a: number[][] = [];
      for (let i = 0; i < r.length; i++) a.push([+r.start(i).toFixed(2), +r.end(i).toFixed(2)]);
      return a;
    };
    return {
      q: this.queueSize, n: this.queue.length, pend: this.pendingSeek,
      ms: this.ms.readyState, sbUpdating: this.sb?.updating ?? null,
      sbBuffered: this.sb ? tl(this.sb.buffered) : null,
      sbOffset: this.sb?.timestampOffset ?? null,
      v: {
        ct: +v.currentTime.toFixed(2), dur: v.duration, rs: v.readyState,
        ns: v.networkState, paused: v.paused, seeking: v.seeking, ended: v.ended,
        err: v.error ? { code: v.error.code, msg: v.error.message } : null,
        buffered: tl(v.buffered), seekable: tl(v.seekable),
      },
      ended: this.ended,
      ev: this.evLog.slice(-24),
    };
  }

  destroy() {
    this.destroyed = true;
    this.abort?.abort();
    clearTimeout(this.jumpTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.contTimer);
    clearInterval(this.watchTimer);
    this.queue.length = 0;
    this.queueSize = 0;
    try {
      if (this.ms.readyState === "open") this.ms.endOfStream();
    } catch {}
    URL.revokeObjectURL(this.url);
  }
}
