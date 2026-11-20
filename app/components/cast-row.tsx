"use client";

import { useEffect, useState } from "react";
import { fetchActorPhoto, fetchFullCast, type CastMember } from "@/lib/api";
import { peekCached } from "@/lib/store";
import { cn } from "@/lib/utils";
import { typeClass } from "@/lib/type-scale";
import { fontWeights } from "@/lib/font-weight";

function Actor({ member }: { member: CastMember }) {
  const [src, setSrc] = useState<string | null>(() =>
    member.photo ?? peekCached<string | null>(`actor:${member.name}`));
  const [done, setDone] = useState(() =>
    !!(member.photo ?? peekCached<string | null>(`actor:${member.name}`)));
  useEffect(() => {
    if (member.photo) return;
    let on = true;
    void fetchActorPhoto(member.name).then((s) => {
      if (on) { setSrc(s); setDone(true); }
    });
    return () => { on = false; };
  }, [member]);

  const initials = member.name.split(" ").map((w) => w[0]).slice(0, 2).join("");
  return (
    <div className="flex w-[72px] shrink-0 flex-col items-center gap-1.5">
      <div className="relative h-14 w-14 overflow-hidden rounded-full bg-surface-2 ring-1 ring-white/10">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={member.name} loading="lazy" className="h-full w-full object-cover object-[50%_20%]" />
        ) : (
          <span className={cn(
            "flex h-full w-full items-center justify-center text-muted-foreground",
            done ? "opacity-100" : "animate-pulse opacity-40",
            typeClass("caption")
          )}>
            {initials}
          </span>
        )}
      </div>
      <span className={cn("w-full break-words text-center leading-tight text-muted-foreground line-clamp-2 min-h-[2em]", typeClass("micro"))}>
        {member.name}
      </span>
    </div>
  );
}

export function CastRow({ cast, imdbId }: { cast: string[]; imdbId?: string }) {
  const [members, setMembers] = useState<CastMember[] | null>(() =>
    imdbId ? peekCached<CastMember[]>(`cast:${imdbId}`) : null);
  useEffect(() => {
    if (!imdbId) return;
    let on = true;
    void fetchFullCast(imdbId).then((m) => {
      if (on) setMembers(m);
      // warm every headshot into the http cache — instant on scroll
      for (const x of m ?? []) if (x.photo) { const i = new Image(); i.src = x.photo; }
    });
    return () => { on = false; };
  }, [imdbId]);

  const list = members && members.length > 0
    ? members
    : cast.map((name) => ({ name }));
  if (members && members.length === 0 && cast.length === 0) return null;
  if (list.length === 0) return null;

  return (
    <div className="flex flex-col gap-2.5">
      <h2 className={cn("text-foreground", typeClass("title"), fontWeights.semibold)}>В ролях</h2>
      <div className="flex gap-3.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {list.slice(0, 24).map((m) => <Actor key={m.name} member={m} />)}
      </div>
    </div>
  );
}
