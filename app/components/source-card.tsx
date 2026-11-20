"use client";

import { useState } from "react";
import { Play, Users, HardDrive, Loader } from "lucide-react";
import { cn } from "@/lib/utils";
import { typeClass } from "@/lib/type-scale";
import { fontWeights } from "@/lib/font-weight";
import { Button } from "@/components/ui/button";
import type { ParsedStream } from "@/lib/parse-stream";

interface SourceCardProps {
  stream: ParsedStream;
  onPlay: (s: ParsedStream) => void;
}

function Chip({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "ru" | "quality" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-px whitespace-nowrap",
        typeClass("micro"),
        tone === "ru" && "bg-[#22c55e]/15 text-[#22c55e]",
        tone === "quality" && "bg-[#6B97FF]/15 text-[#6B97FF]",
        tone === "default" && "bg-surface-3 text-muted-foreground ring-1 ring-border"
      )}
    >
      {children}
    </span>
  );
}

export function SourceCard({ stream: s, onPlay }: SourceCardProps) {
  const [loading, setLoading] = useState(false);
  return (
    <div className="flex items-start gap-3 rounded-[var(--shape-surface-radius,12px)] bg-surface-2 p-3 ring-1 ring-border">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1">
          <Chip tone="quality">{s.quality}</Chip>
          {s.hdr.map((h) => <Chip key={h} tone="quality">{h}</Chip>)}
          {s.codec && <Chip>{s.codec}</Chip>}
          {s.source && <Chip>{s.source}</Chip>}
          {s.hasRu && <Chip tone="ru">RU</Chip>}
        </div>
        <div className={cn("truncate text-foreground/90 font-mono", typeClass("caption"))} title={s.releaseName}>
          {s.releaseName}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
          {s.seeds != null && (
            <span className={cn("inline-flex items-center gap-1", typeClass("caption"))}>
              <Users size={12} strokeWidth={2} /> {s.seeds}
            </span>
          )}
          <span className={cn("inline-flex items-center gap-1", typeClass("caption"))}>
            <HardDrive size={12} strokeWidth={2} /> {s.sizeGb.toFixed(1)} GB
          </span>
          <span className={typeClass("caption")}>{s.provider}</span>
          {s.audioChips.slice(0, 4).map((c) => (
            <span key={c} className={cn("text-muted-foreground/80", typeClass("micro"))}>{c}</span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-1.5">
        <Button
          size="compact"
          loading={loading}
          onClick={async () => { setLoading(true); try { await onPlay(s); } finally { setLoading(false); } }}
        >
          <Play size={13} strokeWidth={2.2} /> Смотреть
        </Button>
      </div>
    </div>
  );
}
