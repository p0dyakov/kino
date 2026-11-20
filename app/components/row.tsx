"use client";

import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { typeClass } from "@/lib/type-scale";
import { fontWeights } from "@/lib/font-weight";

interface RowProps {
  title: string;
  children: React.ReactNode;
  onShowAll?: () => void;
}

/** netflix rail: horizontal strip, chevron buttons appear on row hover */
export function Row({ title, children, onShowAll }: RowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [canL, setCanL] = useState(false);
  const [canR, setCanR] = useState(true);

  const update = () => {
    const el = ref.current;
    if (!el) return;
    setCanL(el.scrollLeft > 4);
    setCanR(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  };

  const page = (dir: number) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
  };

  return (
    <section className="group/row relative flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between px-5 md:px-10">
        <h2 className={cn("text-foreground/90", typeClass("title"), fontWeights.semibold)}>
          {title}
        </h2>
        {onShowAll && (
          <button
            onClick={onShowAll}
            className={cn(
              "text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-foreground cursor-pointer",
              typeClass("caption")
            )}
          >
            Все →
          </button>
        )}
      </div>
      <div className="relative">
        <div
          ref={ref}
          onScroll={update}
          className="flex gap-2.5 overflow-x-auto scroll-smooth px-5 py-3 md:px-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {children}
        </div>
        {canL && (
          <button
            onClick={() => page(-1)}
            aria-label="Назад"
            className={cn(
              "absolute left-0 top-0 bottom-1 z-10 w-10 items-center justify-center",
              "hidden md:flex bg-gradient-to-r from-background/95 to-transparent",
              "text-white/70 hover:text-white opacity-0 group-hover/row:opacity-100 transition-opacity cursor-pointer"
            )}
          >
            <ChevronLeft size={26} />
          </button>
        )}
        {canR && (
          <button
            onClick={() => page(1)}
            aria-label="Вперёд"
            className={cn(
              "absolute right-0 top-0 bottom-1 z-10 w-10 items-center justify-center",
              "hidden md:flex bg-gradient-to-l from-background/95 to-transparent",
              "text-white/70 hover:text-white opacity-0 group-hover/row:opacity-100 transition-opacity cursor-pointer"
            )}
          >
            <ChevronRight size={26} />
          </button>
        )}
      </div>
    </section>
  );
}
