"use client";

import { useState } from "react";
import { Play, Plus, Check, Info, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { typeClass } from "@/lib/type-scale";
import { fontWeights } from "@/lib/font-weight";
import type { MetaItem, MetaDetail } from "@/lib/api";

interface HeroProps {
  item: MetaItem | MetaDetail;
  onPlay: () => void;
  onInfo: () => void;
  inList?: boolean;
  onToggleList?: () => void;
  playing?: boolean;
}

export function Hero({ item, onPlay, onInfo, inList, onToggleList, playing }: HeroProps) {
  const [imgOk, setImgOk] = useState(true);
  const backdrop = item.background ?? item.poster;
  const detail = item as MetaDetail;

  return (
    <section className="relative -mt-14 h-[72vh] min-h-[440px] overflow-hidden">
      {/* backdrop */}
      <div className="absolute inset-0">
        {backdrop && imgOk ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={backdrop}
            alt=""
            onError={() => setImgOk(false)}
            className="h-full w-full object-cover object-[center_20%]"
          />
        ) : (
          <div className="h-full w-full bg-surface-2" />
        )}
        {/* netflix-style grading: bottom fade into page + left vignette */}
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/25 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-background/85 via-transparent to-transparent" />
        <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/55 to-transparent" />
      </div>

      {/* content */}
      <div className="absolute inset-x-0 bottom-0 px-5 pb-10 md:px-10">
        <div className="flex max-w-xl flex-col gap-4">
          {detail.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={detail.logo}
              alt={item.name}
              className="max-h-28 w-auto max-w-[380px] object-contain object-left drop-shadow-lg"
            />
          ) : (
            <h1
              className={cn(
                "text-foreground drop-shadow-md",
                "text-4xl md:text-5xl",
                fontWeights.bold
              )}
            >
              {item.name}
            </h1>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-white/85">
            {item.imdbRating && (
              <span className={cn("inline-flex items-center gap-1", typeClass("body"), fontWeights.semibold)}>
                <Star size={13} className="fill-[#f59e0b] text-[#f59e0b]" />
                {item.imdbRating}
              </span>
            )}
            {item.releaseInfo && <span className={typeClass("body")}>{item.releaseInfo}</span>}
            {detail.runtime && <span className={typeClass("body")}>{detail.runtime}</span>}
            {detail.genres?.slice(0, 3).map((g) => (
              <span key={g} className={cn("text-white/60", typeClass("body"))}>{g}</span>
            ))}
          </div>

          {detail.description && (
            <p className={cn("max-w-lg text-white/80 line-clamp-3 drop-shadow", typeClass("body"))}>
              {detail.description}
            </p>
          )}

          <div className="mt-1 flex items-center gap-2.5">
            <button
              onClick={onPlay}
              disabled={playing}
              className={cn(
                "inline-flex h-11 items-center gap-2 rounded-lg bg-white px-6 text-black cursor-pointer",
                "transition-transform hover:scale-[1.03] active:scale-[0.99]",
                typeClass("body"), fontWeights.semibold
              )}
            >
              <Play size={18} className="fill-black" /> Смотреть
            </button>
            {onToggleList && (
              <button
                onClick={onToggleList}
                className={cn(
                  "inline-flex h-11 items-center gap-2 rounded-lg bg-white/15 px-5 text-white backdrop-blur cursor-pointer",
                  "transition-colors hover:bg-white/25",
                  typeClass("body"), fontWeights.semibold
                )}
              >
                {inList ? <Check size={17} /> : <Plus size={17} />}
                {inList ? "В списке" : "Мой список"}
              </button>
            )}
            <button
              onClick={onInfo}
              className={cn(
                "inline-flex h-11 w-11 items-center justify-center rounded-full border-2 border-white/40 text-white cursor-pointer",
                "transition-colors hover:border-white hover:bg-white/10"
              )}
              aria-label="Подробнее"
            >
              <Info size={18} />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
