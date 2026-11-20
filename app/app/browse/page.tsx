"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BROWSE_GENRES, fetchCatalog, fetchGenreCatalog, type MetaItem } from "@/lib/api";
import { peekCached } from "@/lib/store";
import { PosterCard } from "@/components/poster-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { typeClass } from "@/lib/type-scale";
import { fontWeights } from "@/lib/font-weight";

function BrowsePage() {
  const params = useSearchParams();
  const router = useRouter();
  const type = (params.get("type") as "movie" | "series") ?? "movie";
  const [genre, setGenre] = useState("all");
  const [items, setItems] = useState<MetaItem[]>(() =>
    peekCached<MetaItem[]>(`cat:${type}`) ?? []
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setItems(peekCached<MetaItem[]>(`cat:${type}`) ?? []);
    setGenre("all");
  }, [type]);

  useEffect(() => {
    setLoading(true);
    const run = genre === "all" ? fetchCatalog(type) : fetchGenreCatalog(type, genre);
    void run.then((r) => { setItems(r); setLoading(false); });
  }, [type, genre]);

  const title = type === "movie" ? "Фильмы" : "Сериалы";

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-5 px-5 pb-20 pt-20 md:px-10">
      <h1 className={cn("text-foreground", typeClass("display"), fontWeights.bold)}>{title}</h1>

      {/* genre chips */}
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => setGenre("all")}
          className={cn(
            "h-7 rounded-full px-3 transition-colors cursor-pointer",
            typeClass("caption"), fontWeights.semibold,
            genre === "all" ? "bg-foreground text-background" : "bg-surface-2 text-muted-foreground ring-1 ring-border hover:text-foreground"
          )}
        >
          Все жанры
        </button>
        {BROWSE_GENRES.map(([g, label]) => (
          <button
            key={g}
            onClick={() => setGenre(g)}
            className={cn(
              "h-7 rounded-full px-3 transition-colors cursor-pointer",
              typeClass("caption"), fontWeights.semibold,
              genre === g ? "bg-foreground text-background" : "bg-surface-2 text-muted-foreground ring-1 ring-border hover:text-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && items.length === 0 ? (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
          {Array.from({ length: 16 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[2/3] w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
          {items.map((m) => (
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
      )}
      {!loading && items.length === 0 && (
        <span className={cn("text-muted-foreground", typeClass("body"))}>
          Каталог пуст — проверь сеть
        </span>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <BrowsePage />
    </Suspense>
  );
}
