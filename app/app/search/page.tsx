"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { fetchCatalog, refineSearchTitles, searchCacheKey, searchTitles, type MetaItem } from "@/lib/api";
import { peekCached } from "@/lib/store";
import { PosterCard } from "@/components/poster-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { typeClass } from "@/lib/type-scale";
import { fontWeights } from "@/lib/font-weight";

const TYPE_FILTERS = ["Все", "Фильмы", "Сериалы"] as const;
const RATING_FILTERS = ["Любой", "6+", "7+", "8+"] as const;

function yearOf(m: MetaItem): number {
  const y = parseInt(m.releaseInfo ?? "", 10);
  return isNaN(y) ? 0 : y;
}

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

function SearchPage() {
  const params = useSearchParams();
  const router = useRouter();
  const query = params.get("q") ?? "";
  const [results, setResults] = useState<MetaItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [trending, setTrending] = useState<MetaItem[]>([]);
  const [typeF, setTypeF] = useState<(typeof TYPE_FILTERS)[number]>("Все");
  const [ratingF, setRatingF] = useState<(typeof RATING_FILTERS)[number]>("Любой");
  const [yearF, setYearF] = useState("Все годы");
  const [genreF, setGenreF] = useState("");
  const seq = useRef(0);

  // trending shown while the query is empty — instant, from cache
  useEffect(() => {
    if (query.trim()) return;
    const cached = peekCached<MetaItem[]>("cat:movie");
    if (cached) setTrending(cached);
    void Promise.all([fetchCatalog("movie"), fetchCatalog("series")])
      .then(([m, s]) => setTrending([...m, ...s].slice(0, 40)));
  }, [query]);

  useEffect(() => {
    const q = query.trim();
    const id = ++seq.current;
    if (!q) { setResults(null); setSearching(false); return; }
    const cached = peekCached<MetaItem[]>(searchCacheKey(q));
    setResults(cached);
    setSearching(!cached);
    void searchTitles(q).then((r) => {
      if (seq.current !== id) return;
      setResults(r);
      setSearching(false);
      void refineSearchTitles(q, r).then((ranked) => {
        if (seq.current === id) setResults(ranked);
      });
    });
    return () => { if (seq.current === id) seq.current++; };
  }, [query]);

  const years = useMemo(() => {
    if (!results) return [] as string[];
    const ys = new Set<string>();
    for (const m of results) {
      const y = yearOf(m);
      if (y >= 1970) ys.add(String(Math.floor(y / 10) * 10) + "s");
    }
    return [...ys].sort().reverse();
  }, [results]);

  const genres = useMemo(() => {
    if (!results) return [] as string[];
    const gs = new Set<string>();
    for (const m of results) for (const g of m.genres ?? []) gs.add(g);
    return [...gs].sort();
  }, [results]);

  const filtered = useMemo(() => {
    if (!results) return null;
    return results.filter((m) => {
      if (typeF === "Фильмы" && m.type !== "movie") return false;
      if (typeF === "Сериалы" && m.type !== "series") return false;
      if (ratingF !== "Любой" && parseFloat(m.imdbRating ?? "0") < parseFloat(ratingF)) return false;
      if (yearF !== "Все годы") {
        const y = yearOf(m);
        if (Math.floor(y / 10) * 10 !== parseInt(yearF, 10)) return false;
      }
      if (genreF && !(m.genres ?? []).includes(genreF)) return false;
      return true;
    });
  }, [results, typeF, ratingF, yearF, genreF]);

  const hasFilters = typeF !== "Все" || ratingF !== "Любой" || yearF !== "Все годы" || !!genreF;
  const shown = query.trim() ? filtered : trending;

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-5 px-5 pb-20 pt-20 md:px-10">
      {/* filters — only with live results */}
      {results && results.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {TYPE_FILTERS.map((t) => (
              <Chip key={t} active={typeF === t} onClick={() => setTypeF(t)}>{t}</Chip>
            ))}
            <span className="mx-1 h-4 w-px bg-white/15" />
            {RATING_FILTERS.map((r) => (
              <Chip key={r} active={ratingF === r} onClick={() => setRatingF(r)}>★ {r === "Любой" ? "рейтинг" : r}</Chip>
            ))}
            <span className="mx-1 h-4 w-px bg-white/15" />
            <Chip active={yearF === "Все годы"} onClick={() => setYearF("Все годы")}>Все годы</Chip>
            {years.map((y) => (
              <Chip key={y} active={yearF === y} onClick={() => setYearF(y)}>{y.replace("s", "-е")}</Chip>
            ))}
          </div>
          {genres.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={cn("text-muted-foreground", typeClass("caption"))}>Жанр:</span>
              <Chip active={!genreF} onClick={() => setGenreF("")}>Все</Chip>
              {genres.slice(0, 10).map((g) => (
                <Chip key={g} active={genreF === g} onClick={() => setGenreF(g)}>{g}</Chip>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <span className={cn("text-muted-foreground", typeClass("caption"))}>
          {query.trim()
            ? searching
              ? "Ищу…"
              : filtered?.length
                ? `${filtered.length} ${filtered.length === 1 ? "результат" : "результатов"}`
                : "Ничего не нашлось"
            : "Популярное"}
        </span>
        {searching && !shown ? (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
            {Array.from({ length: 16 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[2/3] w-full rounded-lg" />
            ))}
          </div>
        ) : shown ? (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
            {shown.slice(0, 60).map((m) => (
              <PosterCard
                key={m.type + m.id}
                item={m}
                variant="grid"
                onClick={() =>
                  router.push(`/movie?type=${m.type}&id=${encodeURIComponent(m.id)}&t=${encodeURIComponent(m.name)}`)
                }
              />
            ))}
          </div>
        ) : null}
        {hasFilters && filtered?.length === 0 && (
          <button
            onClick={() => { setTypeF("Все"); setRatingF("Любой"); setYearF("Все годы"); setGenreF(""); }}
            className={cn("w-fit text-muted-foreground underline hover:text-foreground cursor-pointer", typeClass("caption"))}
          >
            Сбросить фильтры
          </button>
        )}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <SearchPage />
    </Suspense>
  );
}
