"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FolderOpen, Trash2, HardDriveDownload, Play, X } from "lucide-react";
import { fetchDownloads, playDownload, playStream, removeDownload, revealDownload, watchHref, type DownloadStatus } from "@/lib/api";
import { getHistory, getMyList, removeHistory, subscribe, toggleMyList, type HistoryEntry } from "@/lib/store";
import { PosterCard } from "@/components/poster-card";
import { cn } from "@/lib/utils";
import { typeClass } from "@/lib/type-scale";
import { fontWeights } from "@/lib/font-weight";
import type { MetaItem } from "@/lib/api";

const TABS = [
  ["downloads", "Загрузки"],
  ["history", "История"],
  ["list", "Мой список"],
] as const;

function fmtGb(bytes?: number): string {
  if (!bytes) return "";
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

function LibraryPage() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = params.get("tab") ?? "downloads";

  const [dls, setDls] = useState<DownloadStatus[]>([]);
  const [hist, setHist] = useState<HistoryEntry[]>([]);
  const [list, setList] = useState(getMyList);
  const [resuming, setResuming] = useState<string | null>(null);
  const [playingDl, setPlayingDl] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState("");

  const refreshStores = () => { setHist(getHistory()); setList(getMyList()); };
  useEffect(() => {
    refreshStores();
    return subscribe(refreshStores);
  }, []);

  useEffect(() => {
    if (tab !== "downloads") return;
    const tick = async () => setDls(await fetchDownloads());
    void tick();
    const id = setInterval(tick, 2500);
    return () => clearInterval(id);
  }, [tab]);

  const resume = async (h: HistoryEntry) => {
    if (resuming) return;
    setResuming(h.mid);
    try {
      const r = await playStream(
        { infoHash: h.hash, fileIdx: h.fileIdx, sources: [] },
        `${h.name}${h.ep ? ` ${h.ep}` : ""}`
      );
      if (!r.ok || !r.id) return;
      router.push(watchHref({
        id: r.id, title: h.name, mid: h.mid, type: h.type,
        episode: h.ep, fileIdx: h.fileIdx, position: h.pos,
      }));
    } finally {
      setResuming(null);
    }
  };

  const playDl = async (d: DownloadStatus) => {
    if (!d.id || playingDl) return;
    setPlayingDl(d.id);
    setDownloadError("");
    try {
      const r = await playDownload(d.id);
      if (!r?.ok || !r.id) {
        setDownloadError("Не удалось открыть загрузку. Попробуй ещё раз.");
        return;
      }
      router.push(watchHref({
        id: r.id, title: r.title ?? d.title ?? d.file ?? "",
        mid: r.mid, type: r.mt, episode: r.ep, fileIdx: r.fileIdx,
      }));
    } finally {
      setPlayingDl(null);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-5 pb-20 pt-20 md:px-10">
      <h1 className={cn("text-foreground", typeClass("display"), fontWeights.bold)}>Библиотека</h1>

      <div className="flex gap-1.5">
        {TABS.map(([t, label]) => (
          <button
            key={t}
            onClick={() => router.replace(`/library?tab=${t}`)}
            className={cn(
              "h-8 rounded-full px-4 transition-colors cursor-pointer",
              typeClass("body"), fontWeights.semibold,
              tab === t ? "bg-foreground text-background" : "bg-surface-2 text-muted-foreground ring-1 ring-border hover:text-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ---------- downloads ---------- */}
      {tab === "downloads" && (
        <div className="flex flex-col gap-2.5">
          {downloadError && (
            <span role="alert" className={cn("text-destructive", typeClass("caption"))}>
              {downloadError}
            </span>
          )}
          {dls.length === 0 && (
            <div className="flex flex-col items-center gap-3 rounded-xl bg-surface-2 py-16 ring-1 ring-border">
              <HardDriveDownload size={26} className="text-muted-foreground" />
              <span className={cn("text-muted-foreground", typeClass("body"))}>
                Нет загрузок — качай со страницы фильма кнопкой ⬇
              </span>
            </div>
          )}
          {dls.map((d) => {
            const pct = Math.round((d.progress ?? 0) * 100);
            const done = d.ready === true;
            return (
              <div key={d.id} className="flex items-center gap-4 rounded-xl bg-surface-2 p-4 ring-1 ring-border">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className={cn("truncate text-foreground", typeClass("body"), fontWeights.semibold)}>
                    {d.title || d.file || d.id}
                  </span>
                  <span className={cn("truncate text-muted-foreground", typeClass("caption"))}>
                    {d.file} {d.fileSize ? `· ${fmtGb(d.fileSize)}` : ""}
                  </span>
                  <div className="flex items-center gap-2.5">
                    <div className="h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-white/10">
                      <div
                        className={cn("h-full rounded-full transition-all", done ? "bg-[#22c55e]" : "bg-[#6B97FF]")}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className={cn("shrink-0 text-muted-foreground tabular-nums", typeClass("caption"))}>
                      {done ? "готово" : `${pct}% · ${((d.downloadRate ?? 0) / 1048576).toFixed(1)} MB/s · ${d.peers ?? 0} пир`}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {done && (
                    <button
                      onClick={() => void playDl(d)}
                      disabled={playingDl === d.id}
                      className={cn(
                        "flex h-9 items-center gap-1.5 rounded-full bg-foreground px-4 text-background transition-opacity hover:opacity-90 cursor-pointer",
                        typeClass("caption"), fontWeights.semibold,
                        playingDl === d.id && "opacity-60"
                      )}
                    >
                      {playingDl === d.id
                        ? <span className="h-3.5 w-3.5 animate-spin rounded-full border border-background/30 border-t-background" />
                        : <Play size={14} className="fill-background" />}
                      Смотреть
                    </button>
                  )}
                  {d.filePath && (
                    <button
                      onClick={() => void revealDownload(d.id!)}
                      aria-label="Показать в Finder"
                      title="Показать в Finder"
                      className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground cursor-pointer"
                    >
                      <FolderOpen size={16} />
                    </button>
                  )}
                  <button
                    onClick={() => void removeDownload(d.id!).then((ok) => {
                      if (ok) setDls((l) => l.filter((x) => x.id !== d.id));
                    })}
                    aria-label="Удалить"
                    title="Удалить загрузку"
                    className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-destructive cursor-pointer"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ---------- history ---------- */}
      {tab === "history" && (
        <div className="flex flex-col gap-2.5">
          {hist.length === 0 && (
            <div className="flex flex-col items-center gap-3 rounded-xl bg-surface-2 py-16 ring-1 ring-border">
              <Play size={26} className="text-muted-foreground" />
              <span className={cn("text-muted-foreground", typeClass("body"))}>
                История пуста — начни что-нибудь смотреть
              </span>
            </div>
          )}
          {hist.map((h) => (
            <div key={h.mid} className="group flex items-center gap-4 rounded-xl bg-surface-2 p-3 ring-1 ring-border transition-colors hover:ring-white/15">
              <button onClick={() => void resume(h)} className="relative h-20 w-14 shrink-0 overflow-hidden rounded-md bg-surface-3 cursor-pointer">
                {h.poster && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={h.poster} alt="" className="h-full w-full object-cover" />
                )}
                <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
                  <Play size={18} className="fill-white text-white" />
                </span>
              </button>
              <button onClick={() => void resume(h)} className="flex min-w-0 flex-1 flex-col gap-1 text-left cursor-pointer">
                <span className={cn("truncate text-foreground", typeClass("body"), fontWeights.semibold)}>
                  {h.name}{h.ep ? ` · ${h.ep}` : ""}
                </span>
                <span className={cn("text-muted-foreground", typeClass("caption"))}>
                  {h.dur > 0 ? `${Math.round((h.pos / h.dur) * 100)}% · ` : ""}
                  {new Date(h.ts).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}
                </span>
                <div className="h-1 w-full max-w-xs overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-[#6B97FF]" style={{ width: `${Math.min((h.pos / (h.dur || 1)) * 100, 100)}%` }} />
                </div>
              </button>
              <button
                onClick={() => removeHistory(h.mid)}
                aria-label="Убрать из истории"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-all hover:bg-white/10 hover:text-foreground group-hover:opacity-100 cursor-pointer"
              >
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ---------- my list ---------- */}
      {tab === "list" && (
        <div>
          {list.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl bg-surface-2 py-16 ring-1 ring-border">
              <span className={cn("text-muted-foreground", typeClass("body"))}>
                Список пуст — добавляй фильмы кнопкой +
              </span>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
              {list.map((l) => (
                <div key={l.mid} className="group relative">
                  <PosterCard
                    item={{ id: l.mid, type: l.type as MetaItem["type"], name: l.name, poster: l.poster, imdbRating: l.imdbRating, releaseInfo: l.releaseInfo }}
                    variant="grid"
                    onClick={() => router.push(`/movie?type=${l.type}&id=${encodeURIComponent(l.mid)}&t=${encodeURIComponent(l.name)}`)}
                  />
                  <button
                    onClick={() => toggleMyList(l)}
                    aria-label="Убрать из списка"
                    className="absolute right-1.5 top-1.5 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity hover:bg-destructive group-hover:opacity-100 cursor-pointer"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <LibraryPage />
    </Suspense>
  );
}
