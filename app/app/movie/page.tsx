"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Play, Plus, Check, Star, Clock, Download, Loader, Film,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { typeClass } from "@/lib/type-scale";
import { fontWeights } from "@/lib/font-weight";
import {
  fetchMeta, fetchGenreCatalog, playStream, startDownload, watchHref,
  type MetaDetail, type MetaItem, type StreamRaw,
} from "@/lib/api";
import { fetchMergedStreams, type ParsedStream } from "@/lib/parse-stream";
import { toggleMyList, inMyList, subscribe, peekCached, historyEntry } from "@/lib/store";
import { PosterCard } from "@/components/poster-card";
import { CastRow } from "@/components/cast-row";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

const QUALITY_FILTERS = ["Все", "4K", "1080p", "720p"] as const;

function Chip({ active, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "h-7 rounded-full px-3 transition-colors cursor-pointer whitespace-nowrap",
        typeClass("caption"), fontWeights.semibold,
        active ? "bg-foreground text-background" : "bg-surface-2 text-muted-foreground ring-1 ring-border hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function TrailerButton({ ytId, title }: { ytId: string; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="secondary" className="h-11 rounded-lg px-5" leadingIcon={Film}>
            Трейлер
          </Button>
        }
      />
      <DialogContent size="xl">
        <DialogTitle>Трейлер: {title}</DialogTitle>
        {open && (
          <iframe
            className="mt-4 aspect-video w-full rounded-lg bg-background"
            title={`Трейлер: ${title}`}
            src={`https://www.youtube-nocookie.com/embed/${ytId}?autoplay=1`}
            referrerPolicy="strict-origin-when-cross-origin"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function MoviePage() {
  const params = useSearchParams();
  const router = useRouter();
  const type = params.get("type") ?? "movie";
  const id = params.get("id") ?? "";
  const title = params.get("t") ?? "";

  const [meta, setMeta] = useState<MetaDetail | null>(() => peekCached<MetaDetail>(`meta:${type}:${id}`) ?? null);
  const [sourceState, setSourceState] = useState<{ key: string; items: ParsedStream[] } | null>(null);
  const [ep, setEp] = useState<{ s: number; e: number } | null>(null);
  const sourceKey = `${type}:${id}:${ep?.s ?? ""}:${ep?.e ?? ""}`;
  const streams = sourceState?.key === sourceKey ? sourceState.items : null;
  const [quality, setQuality] = useState<(typeof QUALITY_FILTERS)[number]>("Все");
  const [ruOnly, setRuOnly] = useState(false);
  const [err, setErr] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const [dlState, setDlState] = useState<Record<string, "idle" | "busy" | "ok">>({});
  const [listed, setListed] = useState(() => inMyList(id));
  const [similar, setSimilar] = useState<MetaItem[]>([]);

  useEffect(() => subscribe(() => setListed(inMyList(id))), [id]);

  useEffect(() => {
    if (!id) return;
    let active = true;
    void fetchMeta(type, id).then((m) => {
      if (!active) return;
      setMeta(m);
      const v = m?.videos?.find((v) => v.season > 0);
      if (m?.type === "series" && v) setEp((old) => old ?? { s: v.season, e: v.episode });
    });
    return () => { active = false; };
  }, [type, id]);

  // "more like this": same-genre top catalog minus this title
  useEffect(() => {
    const g = meta?.genres?.[0];
    if (!g || !meta) return;
    let active = true;
    void fetchGenreCatalog("movie", g.toLowerCase().replace(" ", "-"))
      .then((l) => { if (active) setSimilar(l.filter((x) => x.id !== id).slice(0, 12)); });
    return () => { active = false; };
  }, [meta, id]);

  // series year is "2011–2019" — breaks jacred search; query by name only
  const ruQ = meta?.name
    ? type === "series"
      ? meta.name
      : `${meta.name} ${(meta.year ?? "").match(/\d{4}/)?.[0] ?? ""}`.trim()
    : null;

  useEffect(() => {
    if (!id || (type === "series" && !ep)) return;
    let active = true;
    const publish = (items: ParsedStream[]) => {
      if (active) setSourceState({ key: sourceKey, items });
    };
    void fetchMergedStreams(type, id, ruQ, ep?.s, ep?.e, publish)
      .then(publish)
      .catch(() => {
        if (active) setSourceState((prev) => prev?.key === sourceKey ? prev : { key: sourceKey, items: [] });
      });
    return () => { active = false; };
  }, [type, id, ep?.s, ep?.e, sourceKey, ruQ]);

  const filtered = useMemo(() => {
    if (!streams) return null;
    return streams.filter((s) =>
      (quality === "Все" || s.quality === quality) && (!ruOnly || s.hasRu));
  }, [streams, quality, ruOnly]);

  const episodes = useMemo(() => {
    if (!meta?.videos?.length) return null;
    const byS = new Map<number, number[]>();
    for (const v of meta.videos) {
      if (v.season <= 0) continue;
      if (!byS.has(v.season)) byS.set(v.season, []);
      byS.get(v.season)!.push(v.episode);
    }
    for (const v of byS.values()) v.sort((a, b) => a - b);
    return [...byS.entries()].sort((a, b) => a[0] - b[0]);
  }, [meta]);

  const titleName = meta?.name ?? title;
  const trailer = meta?.trailerStreams?.find(({ ytId }) => /^[a-zA-Z0-9_-]{11}$/.test(ytId));

  const play = async (s: ParsedStream) => {
    if (playing) return;
    setErr("");
    setPlaying(s.infoHash);
    try {
      const r = await playStream(s.raw, `${titleName}${ep ? ` S${ep.s}E${ep.e}` : ""}`);
      if (!r.ok || !r.id) { setErr(r.error ?? "Не удалось запустить. Выбери другой источник."); return; }
      const h = historyEntry(id);
      const label = ep ? `S${ep.s}E${ep.e}` : undefined;
      const resumePos = h && h.ep === label && h.hash === s.infoHash &&
        (s.raw.fileIdx == null || h.fileIdx === s.raw.fileIdx) ? h.pos : undefined;
      router.push(watchHref({
        id: r.id, title: titleName, mid: id, type,
        episode: label, fileIdx: s.raw.fileIdx, position: resumePos,
      }));
    } catch {
      setErr("Не удалось запустить. Выбери другой источник.");
    } finally {
      setPlaying(null);
    }
  };

  const playBest = () => {
    if (!filtered?.length) { setErr("источники ещё грузятся"); return; }
    const h = historyEntry(id);
    const label = ep ? `S${ep.s}E${ep.e}` : undefined;
    const histSrc = h && h.ep === label ? filtered.find((s) => s.infoHash === h.hash) : undefined;
    const best = histSrc ?? filtered.find((s) => s.hasRu) ?? filtered[0];
    void play(best);
  };

  const dlKey = (s: ParsedStream) =>
    `${sourceKey}:${s.infoHash}:${s.raw.fileIdx ?? -1}:${s.raw.fileQuery ?? ""}`;

  const download = async (s: ParsedStream) => {
    const k = dlKey(s);
    setDlState((d) => ({ ...d, [k]: "busy" }));
    const ok = await startDownload(s.raw, `${titleName}${ep ? ` S${ep.s}E${ep.e}` : ""}`, undefined,
      { mid: id, mt: type, ep: ep ? `S${ep.s}E${ep.e}` : undefined });
    setDlState((d) => ({ ...d, [k]: ok ? "ok" : "idle" }));
  };

  const firstDlState = filtered?.[0] ? dlState[dlKey(filtered[0])] : undefined;

  const backdrop = meta?.background ?? meta?.poster;
  const hist = historyEntry(id);

  return (
    <div className="min-h-screen">
      {/* full-bleed hero */}
      <div className="relative -mt-14 flex min-h-[62vh] items-end overflow-hidden">
        <div className="absolute inset-0">
          {backdrop ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={backdrop} alt="" className="h-full w-full object-cover object-[center_20%]" />
          ) : (
            <div className="h-full w-full bg-surface-2" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/35 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-r from-background/80 via-transparent to-transparent" />
        </div>

        <div className="relative w-full px-5 pb-6 md:px-10">
          <div className="flex max-w-2xl flex-col gap-3.5">
            {meta?.logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={meta.logo} alt={titleName} className="max-h-24 w-auto max-w-[340px] object-contain object-left drop-shadow-lg" />
            ) : (
              <h1 className={cn("text-foreground text-3xl md:text-5xl drop-shadow-md", fontWeights.bold)}>
                {titleName}
              </h1>
            )}

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-white/85">
              {meta?.imdbRating && (
                <span className={cn("inline-flex items-center gap-1", typeClass("body"), fontWeights.semibold)}>
                  <Star size={13} className="fill-[#f59e0b] text-[#f59e0b]" /> {meta.imdbRating}
                </span>
              )}
              {(meta?.year ?? meta?.releaseInfo) && <span className={typeClass("body")}>{meta.year ?? meta.releaseInfo}</span>}
              {meta?.runtime && (
                <span className={cn("inline-flex items-center gap-1", typeClass("body"))}>
                  <Clock size={13} /> {meta.runtime}
                </span>
              )}
              {meta?.type === "series" && episodes && (
                <span className={typeClass("body")}>{episodes.length} сез.</span>
              )}
              {meta?.genres?.slice(0, 3).map((g) => (
                <span key={g} className={cn("text-white/55", typeClass("body"))}>{g}</span>
              ))}
            </div>

            {meta?.description && (
              <p className={cn("max-w-xl text-white/80 line-clamp-3 drop-shadow", typeClass("body"))}>
                {meta.description}
              </p>
            )}

            <div className="mt-1 flex flex-wrap items-center gap-2.5">
              <button
                onClick={playBest}
                disabled={!!playing || !filtered?.length}
                className={cn(
                  "inline-flex h-11 items-center gap-2 rounded-lg bg-white px-6 text-black cursor-pointer",
                  "transition-transform hover:scale-[1.03] active:scale-[0.99] disabled:opacity-60",
                  typeClass("body"), fontWeights.semibold
                )}
              >
                {playing ? <Loader size={17} className="animate-spin" /> : <Play size={17} className="fill-black" />}
                {hist && hist.pos > 25 ? "Продолжить" : "Смотреть"}
              </button>
              {trailer && <TrailerButton key={trailer.ytId} ytId={trailer.ytId} title={titleName} />}
              <button
                onClick={() =>
                  setListed(toggleMyList({
                    mid: id, type, name: titleName,
                    poster: meta?.poster, imdbRating: meta?.imdbRating,
                    releaseInfo: meta?.releaseInfo, addedAt: Date.now(),
                  }))
                }
                className={cn(
                  "inline-flex h-11 w-11 items-center justify-center rounded-full border-2 text-white cursor-pointer transition-colors",
                  listed ? "border-white bg-white/15" : "border-white/40 hover:border-white hover:bg-white/10"
                )}
                aria-label={listed ? "Убрать из списка" : "В мой список"}
                title={listed ? "Убрать из списка" : "В мой список"}
              >
                {listed ? <Check size={18} /> : <Plus size={18} />}
              </button>
              <button
                onClick={() => filtered?.[0] && download(filtered[0])}
                disabled={!filtered?.length || firstDlState === "busy" || firstDlState === "ok"}
                className={cn(
                  "inline-flex h-11 w-11 items-center justify-center rounded-full border-2 text-white cursor-pointer transition-colors",
                  firstDlState === "ok"
                    ? "border-[#22c55e] text-[#22c55e]"
                    : "border-white/40 hover:border-white hover:bg-white/10 disabled:opacity-50"
                )}
                aria-label="Скачать лучший источник"
                title="Скачать лучший источник"
              >
                {firstDlState === "busy" ? (
                  <Loader size={17} className="animate-spin" />
                ) : firstDlState === "ok" ? (
                  <Check size={17} />
                ) : (
                  <Download size={17} />
                )}
              </button>
            </div>

            {hist && hist.pos > 25 && (
              <span className={cn("text-white/55", typeClass("caption"))}>
                Остановились на {Math.floor(hist.pos / 60)} мин — продолжу с этого места
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-8 px-5 pb-20 pt-7 md:px-10">
        {meta && <CastRow cast={meta.cast ?? []} imdbId={id} />}

        {/* episodes */}
        {episodes && (
          <section className="flex flex-col gap-2.5">
            <h2 className={cn("text-foreground", typeClass("title"), fontWeights.semibold)}>
              Эпизоды {ep ? `· S${ep.s}E${ep.e}` : ""}
            </h2>
            <div className="flex flex-col gap-2.5">
              {episodes.map(([s, eps]) => (
                <div key={s} className="flex flex-wrap items-center gap-1.5">
                  <span className={cn("mr-1 w-14 text-muted-foreground", typeClass("caption"))}>
                    Сезон {s}
                  </span>
                  {eps.map((e) => (
                    <button
                      key={e}
                      onClick={() => setEp({ s, e })}
                      className={cn(
                        "h-7 min-w-7 rounded-md px-1.5 transition-colors cursor-pointer",
                        typeClass("caption"), fontWeights.semibold,
                        ep?.s === s && ep?.e === e
                          ? "bg-foreground text-background"
                          : "bg-surface-2 text-muted-foreground ring-1 ring-border hover:text-foreground"
                      )}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* sources */}
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className={cn("text-foreground", typeClass("title"), fontWeights.semibold)}>
              Источники {filtered ? `· ${Math.min(filtered.length, 60)}${filtered.length > 60 ? "+" : ""}` : ""}
            </h2>
            <div className="flex flex-wrap items-center gap-1.5">
              {QUALITY_FILTERS.map((q) => (
                <Chip key={q} active={quality === q} onClick={() => setQuality(q)}>{q}</Chip>
              ))}
              <Chip active={ruOnly} onClick={() => setRuOnly((v) => !v)}>RU-озвучка</Chip>
            </div>
          </div>
          {err && (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive" role="alert">
              <span className={typeClass("caption")}>{err}</span>
            </div>
          )}
          <div className="flex flex-col gap-2">
            {!filtered ? (
              Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-xl" />
              ))
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl bg-surface-2 py-10 ring-1 ring-border">
                <span className={cn("text-muted-foreground", typeClass("body"))}>
                  {streams?.length ? "Нет источников с такими фильтрами" : "Нет доступных источников"}
                </span>
              </div>
            ) : (
              filtered.slice(0, 60).map((s) => (
                <div
                  key={s.infoHash}
                  className="flex items-center gap-3 rounded-xl bg-surface-2 px-3.5 py-3 ring-1 ring-border transition-colors hover:ring-white/15"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className={cn("rounded-md bg-[#6B97FF]/15 px-1.5 py-px text-[#6B97FF]", typeClass("micro"), fontWeights.semibold)}>
                        {s.quality}
                      </span>
                      {s.hdr.map((h) => (
                        <span key={h} className={cn("rounded-md bg-[#6B97FF]/15 px-1.5 py-px text-[#6B97FF]", typeClass("micro"))}>{h}</span>
                      ))}
                      {s.hasRu && (
                        <span className={cn("rounded-md bg-[#22c55e]/15 px-1.5 py-px text-[#22c55e]", typeClass("micro"), fontWeights.semibold)}>RU</span>
                      )}
                      {s.audioChips.slice(0, 3).map((c) => (
                        <span key={c} className={cn("rounded-md bg-surface-3 px-1.5 py-px text-muted-foreground ring-1 ring-border", typeClass("micro"))}>{c}</span>
                      ))}
                    </div>
                    <div className={cn("truncate text-muted-foreground", typeClass("caption"))} title={s.releaseName}>
                      {s.releaseName}
                    </div>
                    <span className={cn("text-muted-foreground/70", typeClass("micro"))}>
                      {s.seeds != null ? `${s.seeds} сидов · ` : ""}{s.sizeGb.toFixed(1)} GB{s.source ? ` · ${s.source}` : ""}{s.codec ? ` · ${s.codec}` : ""}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      onClick={() => void download(s)}
                      disabled={dlState[dlKey(s)] === "busy" || dlState[dlKey(s)] === "ok"}
                      aria-label="Скачать"
                      title="Скачать"
                      className={cn(
                        "flex h-9 w-9 items-center justify-center rounded-full transition-colors cursor-pointer",
                        dlState[dlKey(s)] === "ok"
                          ? "bg-[#22c55e]/15 text-[#22c55e]"
                          : "text-muted-foreground hover:bg-white/10 hover:text-foreground disabled:opacity-50"
                      )}
                    >
                      {dlState[dlKey(s)] === "busy" ? <Loader size={15} className="animate-spin" />
                        : dlState[dlKey(s)] === "ok" ? <Check size={15} />
                        : <Download size={15} />}
                    </button>
                    <button
                      onClick={() => void play(s)}
                      disabled={!!playing}
                      className={cn(
                        "inline-flex h-9 items-center gap-1.5 rounded-full bg-foreground px-4 text-background cursor-pointer",
                        "transition-transform hover:scale-[1.03] disabled:opacity-60",
                        typeClass("caption"), fontWeights.semibold
                      )}
                    >
                      {playing === s.infoHash ? <Loader size={13} className="animate-spin" /> : <Play size={13} className="fill-background" />}
                      Смотреть
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* more like this */}
        {similar.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className={cn("text-foreground", typeClass("title"), fontWeights.semibold)}>
              Похожие
            </h2>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
              {similar.slice(0, 12).map((m) => (
                <PosterCard
                  key={m.id}
                  item={m}
                  variant="grid"
                  onClick={() =>
                    router.push(`/movie?type=${m.type}&id=${encodeURIComponent(m.id)}&t=${encodeURIComponent(m.name)}`)
                  }
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function MovieRoute() {
  const params = useSearchParams();
  const type = params.get("type") ?? "movie";
  const id = params.get("id") ?? "";
  return <MoviePage key={`${type}:${id}`} />;
}

export default function Page() {
  return (
    <Suspense>
      <MovieRoute />
    </Suspense>
  );
}
