"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft, Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  RotateCcw, RotateCw, AudioLines, HardDriveDownload, Users, SkipForward,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { typeClass } from "@/lib/type-scale";
import { fontWeights } from "@/lib/font-weight";
import { ENGINE, fetchMeta, fetchTracks, playStream, prefetchStatus, sessionStatus, startPrefetch, type StreamRaw, type TracksResponse } from "@/lib/api";
import { MsePlayer } from "@/lib/mse-player";
import { fetchMergedStreams } from "@/lib/parse-stream";
import { saveProgress } from "@/lib/store";

function fmtTime(t: number): string {
  if (!isFinite(t) || t < 0) return "0:00";
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function peerWord(n: number): string {
  const m = n % 10, h = n % 100;
  if (m === 1 && h !== 11) return "пир";
  if (m >= 2 && m <= 4 && (h < 12 || h > 14)) return "пира";
  return "пиров";
}

function IconBtn({
  label, onClick, children, danger,
}: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-9 w-9 items-center justify-center rounded-full text-white/90 transition-colors cursor-pointer",
        "hover:bg-white/15 hover:text-white",
        danger && "hover:bg-destructive/60"
      )}
    >
      {children}
    </button>
  );
}

function WatchPage() {
  const params = useSearchParams();
  const router = useRouter();
  const sessionId = params.get("id") ?? "";
  const title = params.get("t") ?? "";
  const mid = params.get("mid") ?? "";
  const mtype = params.get("mt") ?? "movie";
  const fileIdx = parseInt(params.get("fi") ?? "-1", 10);
  const epLabel = params.get("ep") ?? undefined;
  const startPos = parseFloat(params.get("pos") ?? "0") || 0;
  const debugEnabled = params.get("debug") === "1";

  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<MsePlayer | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const scrubRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const fileIdxRef = useRef(fileIdx);

  const [tracks, setTracks] = useState<TracksResponse | null>(null);
  const [audioIdx, setAudioIdx] = useState(-1);
  const [audioMenu, setAudioMenu] = useState(false);
  const [err, setErr] = useState("");
  const [booting, setBooting] = useState(true);

  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [vol, setVol] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fs, setFs] = useState(false);
  const [controls, setControls] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [peers, setPeers] = useState(0);
  const [rate, setRate] = useState(0);
  const [next, setNext] = useState<{ raw: StreamRaw; label: string; s: number; e: number; warm: boolean } | null>(null);
  const [nextBusy, setNextBusy] = useState(false);
  const [nextErr, setNextErr] = useState("");
  const [started, setStarted] = useState(false);
  const nextFlight = useRef(false);

  fileIdxRef.current = tracks?.fileIdx ?? fileIdx;

  // boot: get tracks → pick RU/default audio → start MSE
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let onMeta: (() => void) | null = null;
    let onCan: (() => void) | null = null;
    (async () => {
      const tr = await fetchTracks(sessionId);
      if (cancelled) return;
      if (!tr?.video) { setErr("Не удалось открыть видео. Попробуй другой источник."); return; }
      setTracks(tr);
      const ru = tr.audio?.find((a) => a.lang === "rus") ?? tr.audio?.find((a) => a.default);
      const idx = ru?.idx ?? tr.audio?.[0]?.idx ?? 0;
      setAudioIdx(idx);
      const v = videoRef.current;
      if (!v) return;
      if (!("MediaSource" in window)) { setErr("WebKit не поддерживает MSE"); return; }
      const p = new MsePlayer(v, sessionId, {
        video: tr.video,
        audio: tr.audio ?? [],
        duration: tr.duration ?? 0,
      }, idx, startPos, debugEnabled);
      playerRef.current = p;
      v.src = p.src();
      v.preload = "auto";
      if (startPos > 0) {
        onMeta = () => { v.currentTime = startPos; };
        v.addEventListener("loadedmetadata", onMeta, { once: true });
      }
      // auto-start as soon as the stream can render a frame
      onCan = () => void v.play().catch(() => {});
      v.addEventListener("canplay", onCan, { once: true });
      setBooting(false);
    })();
    return () => {
      cancelled = true;
      const v = videoRef.current;
      if (v && onMeta) v.removeEventListener("loadedmetadata", onMeta);
      if (v && onCan) v.removeEventListener("canplay", onCan);
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [sessionId, debugEnabled]);

  // session stats + progress persistence for continue-watching
  useEffect(() => {
    if (!sessionId || !mid) return;
    let poster: string | undefined;
    let backdrop: string | undefined;
    void fetchMeta(mtype, mid).then((m) => { poster = m?.poster; backdrop = m?.background; });
    const persist = () => {
      const v = videoRef.current;
      if (!v || !isFinite(v.duration) || v.duration <= 0) return;
      saveProgress({
        mid, type: mtype, name: title,
        poster, backdrop, ep: epLabel,
        hash: sessionId, fileIdx: fileIdxRef.current,
        pos: v.currentTime, dur: v.duration, ts: Date.now(),
      });
    };
    const id = setInterval(async () => {
      persist();
      const st = await sessionStatus(sessionId);
      if (st) { setPeers(st.peers ?? 0); setRate(st.downloadRate ?? 0); }
    }, 5000);
    window.addEventListener("beforeunload", persist);
    return () => {
      persist();
      window.removeEventListener("beforeunload", persist);
      clearInterval(id);
    };
  }, [sessionId, mid, mtype, title, fileIdx, epLabel]);

  useEffect(() => {
    if (!sessionId || !debugEnabled) return;
    const timer = setInterval(() => {
      const p = playerRef.current;
      if (p) void fetch(`${ENGINE}/api/playerdebug`, {
        method: "POST", body: JSON.stringify(p.debugJson()),
      }).catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [sessionId, debugEnabled]);

  // wire video element events
  useEffect(() => {
    const v = videoRef.current;
    if (!v || booting) return;
    const onTime = () => {
      if (!dragging.current) setCur(v.currentTime);
      const b = v.buffered;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= v.currentTime && v.currentTime <= b.end(i)) {
          setBufferedEnd(b.end(i));
          break;
        }
      }
    };
    const onDur = () => { if (isFinite(v.duration)) setDur(v.duration); };
    const onSeek = () => playerRef.current?.handleSeek(v.currentTime);
    const onPlay = () => { setPlaying(true); setStarted(true); };
    const onPause = () => setPlaying(false);
    const onWait = () => setWaiting(true);
    const onCanPlay = () => setWaiting(false);
    const onVol = () => { setVol(v.volume); setMuted(v.muted); };
    const onFs = () => setFs(!!document.fullscreenElement);
    const onEnded = () => setPlaying(false);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("durationchange", onDur);
    v.addEventListener("seeking", onSeek);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("waiting", onWait);
    v.addEventListener("canplay", onCanPlay);
    v.addEventListener("volumechange", onVol);
    v.addEventListener("ended", onEnded);
    document.addEventListener("fullscreenchange", onFs);
    if (!v.paused) setStarted(true);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("durationchange", onDur);
      v.removeEventListener("seeking", onSeek);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("waiting", onWait);
      v.removeEventListener("canplay", onCanPlay);
      v.removeEventListener("volumechange", onVol);
      v.removeEventListener("ended", onEnded);
      document.removeEventListener("fullscreenchange", onFs);
    };
  }, [booting]);

  const showControls = useCallback(() => {
    setControls(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (playing && !audioMenu) setControls(false);
    }, 2600);
  }, [playing, audioMenu]);

  // series: once playback actually starts, quietly fetch the best source for
  // the NEXT episode and let the engine warm it in the background — the
  // button then promotes that warm session and playback is near-instant
  useEffect(() => {
    if (mtype !== "series" || !epLabel || !mid || !started) return;
    const m = /^S(\d+)E(\d+)$/i.exec(epLabel);
    if (!m) return;
    let on = true;
    (async () => {
      const meta = await fetchMeta(mtype, mid);
      const vids = (meta?.videos ?? [])
        .filter((v) => v.season > 0)
        .sort((a, b) => a.season - b.season || a.episode - b.episode);
      const s = +m[1], e = +m[2];
      const ni = vids.findIndex((v) => v.season === s && v.episode === e);
      const nv = ni >= 0 ? vids[ni + 1] : undefined;
      if (!on || !nv || !meta?.name) return;
      const list = await fetchMergedStreams("series", mid, meta.name, nv.season, nv.episode);
      const best = list[0];
      if (!on || !best) return;
      void startPrefetch(best.raw, `${title} S${nv.season}E${nv.episode}`);
      setNext({ raw: best.raw, label: `S${nv.season}E${nv.episode}`, s: nv.season, e: nv.episode, warm: false });
    })();
    return () => { on = false; };
  }, [started, epLabel, mid, mtype, title]);

  useEffect(() => {
    if (!next || next.warm) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const st = await prefetchStatus(next.raw);
      if (!active) return;
      if (st?.warm) { setNext((n) => (n ? { ...n, warm: true } : n)); return; }
      timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [next]);

  const goNext = useCallback(async () => {
    if (!next || nextFlight.current) return;
    nextFlight.current = true;
    setNextBusy(true);
    setNextErr("");
    try {
      const r = await playStream(next.raw, `${title} ${next.label}`);
      if (!r.ok || !r.id) throw new Error(r.error || "play failed");
      const q = new URLSearchParams({ id: r.id, t: title, mid, mt: mtype, ep: next.label });
      if (next.raw.fileIdx != null) q.set("fi", String(next.raw.fileIdx));
      if (debugEnabled) q.set("debug", "1");
      router.push(`/watch?${q}`);
    } catch {
      nextFlight.current = false;
      setNextBusy(false);
      setNextErr("Не удалось запустить — попробуй ещё раз");
    }
  }, [next, title, mid, mtype, debugEnabled, router]);

  // auto-advance only once the prefetched episode is warm enough to start
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !next?.warm) return;
    const onEnd = () => void goNext();
    v.addEventListener("ended", onEnd);
    return () => v.removeEventListener("ended", onEnd);
  }, [next?.warm, goNext]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play(); else v.pause();
  }, []);

  const seekTo = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(t, dur || v.duration || Infinity));
    setCur(v.currentTime);
  }, [dur]);

  const toggleFs = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrapRef.current?.requestFullscreen();
  }, []);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = videoRef.current;
      if (!v) return;
      switch (e.code) {
        case "Space": case "KeyK": e.preventDefault(); togglePlay(); break;
        case "ArrowLeft": case "KeyJ": seekTo(v.currentTime - 10); break;
        case "ArrowRight": case "KeyL": seekTo(v.currentTime + 10); break;
        case "ArrowUp": e.preventDefault(); v.volume = Math.min(1, v.volume + 0.1); break;
        case "ArrowDown": e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1); break;
        case "KeyM": v.muted = !v.muted; break;
        case "KeyF": toggleFs(); break;
        case "Escape": setAudioMenu(false); break;
      }
      showControls();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekTo, toggleFs, showControls]);

  // scrub interactions
  const scrubEvent = (e: React.PointerEvent) => {
    const el = scrubRef.current;
    if (!el || !dur) return;
    const r = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    seekTo(pct * dur);
  };

  const switchAudio = (idx: number) => {
    setAudioMenu(false);
    if (idx === audioIdx) return;
    setAudioIdx(idx);
    const v = videoRef.current;
    if (v && playerRef.current) playerRef.current.setAudio(idx, v.currentTime);
    setWaiting(true);
  };

  const pct = dur > 0 ? (cur / dur) * 100 : 0;
  const bufPct = dur > 0 ? (bufferedEnd / dur) * 100 : 0;
  const audioTracks = tracks?.audio ?? [];
  const curAudio = audioTracks.find((a) => a.idx === audioIdx);

  return (
    <div
      ref={wrapRef}
      onMouseMove={showControls}
      onMouseLeave={() => playing && setControls(false)}
      className={cn(
        "relative flex h-screen w-full flex-col bg-black select-none overflow-hidden",
        !controls && "cursor-none"
      )}
    >
      {/* video */}
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full"
        onClick={togglePlay}
        onDoubleClick={toggleFs}
        playsInline
      />

      {/* top bar */}
      <div
        className={cn(
          "absolute inset-x-0 top-0 z-20 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 pb-8 pt-3 transition-opacity duration-200",
          !controls && "opacity-0 pointer-events-none"
        )}
      >
        <IconBtn label="Назад" onClick={() => router.back()}>
          <ArrowLeft size={18} />
        </IconBtn>
        <span className={cn("truncate text-white/95", typeClass("subtitle"), fontWeights.semibold)}>
          {title}
        </span>
        <div className="ml-auto flex items-center gap-3 text-white/60">
          <span className={cn("inline-flex items-center gap-1", typeClass("micro"))} title="пиры">
            <Users size={11} /> {peers}
          </span>
          <span className={cn("inline-flex items-center gap-1", typeClass("micro"))} title="скорость загрузки">
            <HardDriveDownload size={11} /> {(rate / 1048576).toFixed(1)} MB/s
          </span>
        </div>
      </div>

      {/* center status */}
      {(booting || waiting) && !err && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-white/90" />
            <span className={cn("text-white/70", typeClass("caption"))}>
              {booting
                ? peers > 0
                  ? `Подключаюсь к сидам… ${peers} ${peerWord(peers)}`
                  : "Ищу раздающих…"
                : "Буферизация"}
            </span>
          </div>
        </div>
      )}

      {/* error overlay */}
      {err && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/80">
          <div className="flex max-w-sm flex-col items-center gap-4 text-center">
            <span className={cn("text-white", typeClass("subtitle"), fontWeights.semibold)}>{err}</span>
            <button onClick={() => router.back()} className={cn("text-white/60 hover:text-white cursor-pointer", typeClass("caption"))}>
              Назад к источникам
            </button>
          </div>
        </div>
      )}

      {/* audio menu */}
      {audioMenu && controls && (
        <div className="absolute bottom-24 right-4 z-30 w-72 overflow-hidden rounded-xl border border-white/10 bg-black/90 backdrop-blur-xl">
          <div className={cn("border-b border-white/10 px-3.5 py-2.5 text-white/50", typeClass("micro"), fontWeights.semibold)}>
            АУДИОДОРОЖКА
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {audioTracks.map((a) => (
              <button
                key={a.idx}
                onClick={() => switchAudio(a.idx)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors cursor-pointer",
                  "hover:bg-white/10",
                  a.idx === audioIdx ? "text-white" : "text-white/65"
                )}
              >
                <span className={cn("w-4 text-center", typeClass("body"))}>
                  {a.idx === audioIdx ? "●" : ""}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn("truncate", typeClass("body"), a.idx === audioIdx && fontWeights.semibold)}>
                    {a.title || `Дорожка ${a.idx + 1}`}
                  </span>
                  <span className={cn("text-white/40", typeClass("micro"))}>
                    {[a.lang, a.codec?.toUpperCase(), a.channels ? `${a.channels}ch` : ""].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {a.lang === "rus" && (
                  <span className={cn("rounded bg-[#22c55e]/20 px-1.5 py-px text-[#22c55e]", typeClass("micro"))}>RU</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* bottom controls */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-4 pb-3 pt-10 transition-opacity duration-200",
          !controls && "opacity-0 pointer-events-none"
        )}
      >
        {/* scrubber */}
        <div
          ref={scrubRef}
          onPointerDown={(e) => {
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            scrubEvent(e);
          }}
          onPointerMove={(e) => dragging.current && scrubEvent(e)}
          onPointerUp={() => (dragging.current = false)}
          className="group/scrub relative flex h-4 w-full cursor-pointer items-center"
        >
          <div className="relative h-[3px] w-full rounded-full bg-white/20 transition-all group-hover/scrub:h-[5px]">
            <div className="absolute inset-y-0 left-0 rounded-full bg-white/30" style={{ width: `${bufPct}%` }} />
            <div className="absolute inset-y-0 left-0 rounded-full bg-[#6B97FF]" style={{ width: `${pct}%` }} />
            <div
              className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-md opacity-0 transition-opacity group-hover/scrub:opacity-100"
              style={{ left: `${pct}%` }}
            />
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <IconBtn label="−10 сек (J)" onClick={() => seekTo(cur - 10)}>
            <RotateCcw size={17} />
          </IconBtn>
          <button
            aria-label={playing ? "Пауза (Space)" : "Играть (Space)"}
            title={playing ? "Пауза (Space)" : "Играть (Space)"}
            onClick={togglePlay}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-black transition-transform hover:scale-105 cursor-pointer"
          >
            {playing ? <Pause size={19} className="fill-black" /> : <Play size={19} className="ml-0.5 fill-black" />}
          </button>
          <IconBtn label="+10 сек (L)" onClick={() => seekTo(cur + 10)}>
            <RotateCw size={17} />
          </IconBtn>

          {/* volume */}
          <div className="group/vol ml-1 flex items-center">
            <IconBtn label="Звук (M)" onClick={() => { const v = videoRef.current; if (v) v.muted = !v.muted; }}>
              {muted || vol === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </IconBtn>
            <input
              type="range"
              min={0} max={1} step={0.05}
              value={muted ? 0 : vol}
              onChange={(e) => {
                const v = videoRef.current;
                if (!v) return;
                v.muted = false;
                v.volume = parseFloat(e.target.value);
              }}
              aria-label="Громкость"
              className="w-0 cursor-pointer opacity-0 transition-all duration-200 group-hover/vol:w-20 group-hover/vol:opacity-100 accent-[#6B97FF]"
            />
          </div>

          <span className={cn("ml-2 tabular-nums text-white/80", typeClass("caption"))}>
            {fmtTime(cur)} <span className="text-white/40">/ {fmtTime(dur)}</span>
          </span>

          <div className="ml-auto flex items-center gap-1.5">
            {next && (
              <button
                onClick={goNext}
                disabled={nextBusy}
                className={cn(
                  "flex h-9 items-center gap-1.5 rounded-full px-3 text-white/90 transition-colors cursor-pointer",
                  "hover:bg-white/15", nextBusy && "opacity-60"
                )}
                title={nextErr || `Следующая серия (${next.label})`}
              >
                {nextBusy
                  ? <span className="h-3.5 w-3.5 animate-spin rounded-full border border-white/30 border-t-white" />
                  : <SkipForward size={16} />}
                <span className={typeClass("caption")}>{next.label}</span>
              </button>
            )}
            <button
              onClick={() => setAudioMenu((v) => !v)}
              className={cn(
                "flex h-9 items-center gap-1.5 rounded-full px-3 text-white/90 transition-colors cursor-pointer",
                "hover:bg-white/15", audioMenu && "bg-white/15"
              )}
              title="Аудиодорожки"
            >
              <AudioLines size={16} />
              <span className={cn("max-w-36 truncate", typeClass("caption"))}>
                {curAudio ? (curAudio.title || `Дорожка ${curAudio.idx + 1}`) : "Звук"}
              </span>
            </button>
            <IconBtn label="На весь экран (F)" onClick={toggleFs}>
              {fs ? <Minimize size={17} /> : <Maximize size={17} />}
            </IconBtn>
          </div>
        </div>
      </div>
    </div>
  );
}

function WatchRoute() {
  const params = useSearchParams();
  return (
    <WatchPage
      key={`${params.get("id")}|${params.get("ep")}|${params.get("pos")}|${params.get("fi")}`}
    />
  );
}

export default function Page() {
  return (
    <Suspense>
      <WatchRoute />
    </Suspense>
  );
}
