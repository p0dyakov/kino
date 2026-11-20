"use client";

import { useState } from "react";
import { Star, Film } from "lucide-react";
import { cn } from "@/lib/utils";
import { typeClass } from "@/lib/type-scale";
import type { MetaItem } from "@/lib/api";

interface PosterCardProps {
  item: MetaItem;
  onClick?: () => void;
  /** progress 0..1 renders a netflix-style progress bar under the card */
  progress?: number;
  /** "rail" fixes card width for horizontal rows; "grid" fills the cell */
  variant?: "rail" | "grid";
}

/** minimal netflix-style card: poster only — no captions, rating badge
 *  top-left, hover lifts with a soft shadow. */
export function PosterCard({ item, onClick, progress, variant = "rail" }: PosterCardProps) {
  const [err, setErr] = useState(false);
  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative flex shrink-0 flex-col gap-1.5 text-left outline-none cursor-pointer",
        variant === "rail" ? "w-[118px] sm:w-[134px] md:w-[152px] lg:w-[168px]" : "w-full"
      )}
    >
      <div
        className={cn(
          "relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-surface-2 ring-1 ring-white/5",
          "transition-all duration-200 ease-out",
          "group-hover:scale-[1.045] group-hover:ring-white/20 group-hover:shadow-[0_14px_40px_rgba(0,0,0,0.55)] group-hover:z-10"
        )}
      >
        {item.poster && !err ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.poster}
            alt={item.name}
            loading="lazy"
            onError={() => setErr(true)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-2 text-center text-muted-foreground">
            <Film size={18} className="opacity-40" />
            <span className={typeClass("caption")}>{item.name}</span>
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/35 via-transparent to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
        {item.imdbRating && (
          <span
            className={cn(
              "absolute left-1.5 top-1.5 inline-flex items-center gap-0.5 rounded-md bg-black/65 px-1.5 py-0.5 text-white backdrop-blur-sm",
              typeClass("micro")
            )}
          >
            <Star size={9} className="fill-[#f59e0b] text-[#f59e0b]" />
            {item.imdbRating}
          </span>
        )}
      </div>
      {progress != null && progress > 0 && (
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/15">
          <div className="h-full rounded-full bg-[#6B97FF]" style={{ width: `${Math.min(progress * 100, 100)}%` }} />
        </div>
      )}
    </button>
  );
}
