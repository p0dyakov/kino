"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  fetchCatalog, fetchGenreCatalog, fetchMeta, fetchStreams, playStream, watchHref,
  type MetaDetail, type MetaItem,
} from "@/lib/api";
import { parseStream, sortStreams } from "@/lib/parse-stream";
import {
  continueWatching, getMyList, inMyList, subscribe, toggleMyList, peekCached, type HistoryEntry,
} from "@/lib/store";
import { Hero } from "@/components/hero";
import { Row } from "@/components/row";
import { PosterCard } from "@/components/poster-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { typeClass } from "@/lib/type-scale";

function RowSkeleton() {
  return (
    <div className="flex flex-col gap-2.5 px-5 md:px-10">
      <Skeleton className="h-5 w-40 rounded" />
      <div className="flex gap-2.5 overflow-hidden">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="aspect-[2/3] w-[118px] shrink-0 rounded-lg sm:w-[134px] md:w-[152px] lg:w-[168px]" />
        ))}
      </div>
    </div>
  );
}

const GENRES = [["action", "Боевики"], ["comedy", "Комедии"], ["drama", "Драмы"], ["sci-fi", "Фантастика"]] as const;

export default function HomePage() {
  const router = useRouter();
  const [hero, setHero] = useState<MetaDetail | null>(() => {
    const id = peekCached<MetaItem[]>("cat:movie")?.[0]?.id;
    return id ? peekCached<MetaDetail>(`meta:movie:${id}`) : null;
  });
  const [movies, setMovies] = useState<MetaItem[]>(() => peekCached<MetaItem[]>("cat:movie") ?? []);
  const [series, setSeries] = useState<MetaItem[]>(() => peekCached<MetaItem[]>("cat:series") ?? []);
  const [genreRows, setGenreRows] = useState<[string, MetaItem[]][]>(() =>
    GENRES.map(([g, label]) => [label, peekCached<MetaItem[]>(`genre:movie:${g}`) ?? []]));
  const [cont, setCont] = useState<HistoryEntry[]>(continueWatching);
  const [list, setList] = useState(getMyList);
  const [playing, setPlaying] = useState(false);

  const refreshStores = () => { setCont(continueWatching()); setList(getMyList()); };
  useEffect(() => {
    refreshStores();
    return subscribe(refreshStores);
  }, []);

  useEffect(() => {
    void fetchCatalog("movie").then(setMovies);
    void fetchCatalog("series").then(setSeries);
    void Promise.all(
      GENRES.map(async ([g, label]): Promise<[string, MetaItem[]]> => [label, await fetchGenreCatalog("movie", g)])
    ).then(setGenreRows);
  }, []);

  // hero = first trending movie, enriched with meta for the logo+plot
  useEffect(() => {
    if (!movies.length || hero) return;
    void fetchMeta("movie", movies[0].id).then((m) => m && setHero(m));
  }, [movies, hero]);

  const open = (m: MetaItem) =>
    router.push(`/movie?type=${m.type}&id=${encodeURIComponent(m.id)}&t=${encodeURIComponent(m.name)}`);

  const playHero = async () => {
    if (!hero || playing) return;
    setPlaying(true);
    try {
      const streams = sortStreams((await fetchStreams("movie", hero.id)).map(parseStream));
      const best = streams.find((s) => s.hasRu) ?? streams[0];
      if (!best) { router.push(`/movie?type=movie&id=${hero.id}&t=${encodeURIComponent(hero.name)}`); return; }
      const r = await playStream(best.raw, hero.name);
      if (!r.ok || !r.id) { router.push(`/movie?type=movie&id=${hero.id}&t=${encodeURIComponent(hero.name)}`); return; }
      router.push(watchHref({ id: r.id, title: hero.name, mid: hero.id, type: "movie" }));
    } finally {
      setPlaying(false);
    }
  };

  const resume = async (h: HistoryEntry) => {
    const r = await playStream(
      { infoHash: h.hash, fileIdx: h.fileIdx, sources: [] },
      `${h.name}${h.ep ? ` ${h.ep}` : ""}`
    );
    if (!r.ok || !r.id) return;
    router.push(watchHref({
      id: r.id, title: h.name, mid: h.mid, type: h.type,
      episode: h.ep, fileIdx: h.fileIdx, position: h.pos,
    }));
  };

  return (
    <div className="flex w-full flex-col gap-7 pb-20">
      {hero ? (
        <Hero
          item={hero}
          playing={playing}
          onPlay={playHero}
          onInfo={() => router.push(`/movie?type=movie&id=${hero.id}&t=${encodeURIComponent(hero.name)}`)}
          inList={inMyList(hero.id)}
          onToggleList={() =>
            toggleMyList({
              mid: hero.id, type: "movie", name: hero.name,
              poster: hero.poster, imdbRating: hero.imdbRating,
              releaseInfo: hero.releaseInfo, addedAt: Date.now(),
            })
          }
        />
      ) : (
        <div className="-mt-14 h-[72vh] min-h-[440px]">
          <Skeleton className="h-full w-full" />
        </div>
      )}

      <div className="flex flex-col gap-7 -mt-6">
        {cont.length > 0 && (
          <Row title="Продолжить просмотр">
            {cont.slice(0, 15).map((h) => (
              <div key={h.mid} className="flex shrink-0 flex-col gap-1">
                <PosterCard
                  item={{
                    id: h.mid, type: h.type as MetaItem["type"], name: `${h.name}${h.ep ? ` · ${h.ep}` : ""}`,
                    poster: h.poster, imdbRating: undefined,
                  }}
                  progress={h.dur > 0 ? h.pos / h.dur : 0}
                  onClick={() => void resume(h)}
                />
                <span className={cn("px-0.5 text-muted-foreground truncate w-[118px] sm:w-[134px] md:w-[152px] lg:w-[168px]", typeClass("micro"))}>
                  {h.name}{h.ep ? ` · ${h.ep}` : ""}
                </span>
              </div>
            ))}
          </Row>
        )}

        {list.length > 0 && (
          <Row title="Мой список">
            {list.slice(0, 20).map((l) => (
              <PosterCard
                key={l.mid}
                item={{ id: l.mid, type: l.type as MetaItem["type"], name: l.name, poster: l.poster, imdbRating: l.imdbRating, releaseInfo: l.releaseInfo }}
                onClick={() => open({ id: l.mid, type: l.type as MetaItem["type"], name: l.name, poster: l.poster })}
              />
            ))}
          </Row>
        )}

        {movies.length > 0 && (
          <Row title="Фильмы в тренде" onShowAll={() => router.push("/browse?type=movie")}>
            {movies.slice(0, 20).map((m) => <PosterCard key={m.id} item={m} onClick={() => open(m)} />)}
          </Row>
        )}

        {series.length > 0 && (
          <Row title="Сериалы в тренде" onShowAll={() => router.push("/browse?type=series")}>
            {series.slice(0, 20).map((m) => <PosterCard key={m.id} item={m} onClick={() => open(m)} />)}
          </Row>
        )}

        {!genreRows.some(([, items]) => items.length > 0) && movies.length === 0 && <RowSkeleton />}
        {genreRows.map(([label, items]) =>
          items.length > 0 && (
            <Row key={label} title={label}>
              {items.slice(0, 20).map((m) => <PosterCard key={m.id} item={m} onClick={() => open(m)} />)}
            </Row>
          )
        )}
      </div>
    </div>
  );
}
