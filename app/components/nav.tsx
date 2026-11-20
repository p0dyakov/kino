"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X, ChevronLeft } from "lucide-react";

declare global {
  interface Window {
    webkit?: { messageHandlers?: { kinostream?: { postMessage: (m: unknown) => void } } };
  }
}
import { cn } from "@/lib/utils";
import { typeClass } from "@/lib/type-scale";
import { fontWeights } from "@/lib/font-weight";

const LINKS = [
  { href: "/", label: "Главная" },
  { href: "/browse?type=series", label: "Сериалы" },
  { href: "/browse?type=movie", label: "Фильмы" },
  { href: "/library", label: "Библиотека" },
];

function NavInner() {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const [scrolled, setScrolled] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState(params.get("q") ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const deb = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const onSearchPage = pathname === "/search";
  const expanded = searchOpen || onSearchPage;
  const [native, setNative] = useState(false);
  useEffect(() => { setNative(!!window.webkit?.messageHandlers?.kinostream); }, []);
  // detail pages get a back button in place of the window close button
  const isDetail = pathname === "/movie";

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => { setQ(params.get("q") ?? ""); }, [params]);
  useEffect(() => { if (expanded) inputRef.current?.focus(); }, [expanded]);

  const onType = (v: string) => {
    setQ(v);
    clearTimeout(deb.current);
    deb.current = setTimeout(() => {
      router.replace(v.trim() ? `/search?q=${encodeURIComponent(v)}` : "/search");
    }, 180);
  };

  const isActive = (href: string) => {
    const [path, qs] = href.split("?");
    if (pathname !== path) return false;
    if (!qs) return true;
    return params.toString() === qs;
  };

  if (pathname === "/watch") return null;

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-all duration-300",
        scrolled || expanded
          ? "bg-background/90 backdrop-blur-xl border-b border-white/5 shadow-[0_8px_30px_rgba(0,0,0,0.45)]"
          : "bg-gradient-to-b from-black/70 via-black/25 to-transparent border-b border-transparent"
      )}
    >
      {/* custom chrome: own close button replaces the hidden traffic lights */}
      <div className="flex h-14 w-full items-center gap-5 pl-4 pr-4 md:pr-8">
        {isDetail ? (
          <button
            aria-label="Назад"
            onClick={() => router.back()}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/45 transition-colors cursor-pointer hover:bg-white/10 hover:text-white"
          >
            <ChevronLeft size={18} />
          </button>
        ) : native && (
          <button
            aria-label="Закрыть"
            onClick={() => window.webkit?.messageHandlers?.kinostream?.postMessage({ action: "close" })}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/45 transition-colors cursor-pointer hover:bg-white/10 hover:text-white"
          >
            <X size={15} />
          </button>
        )}
        <nav className="hidden items-center gap-5 md:flex">
          {LINKS.map((l) => {
            const active = isActive(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={cn(
                  "transition-colors cursor-pointer",
                  typeClass("body"),
                  active
                    ? cn("text-white", fontWeights.semibold)
                    : "text-white/55 hover:text-white/85"
                )}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center">
          {/* netflix-style expanding search — input grows leftward from the icon */}
          <div
            className={cn(
              "overflow-hidden transition-all duration-300 ease-out",
              expanded ? "w-52 opacity-100 md:w-64" : "w-0 opacity-0"
            )}
          >
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => onType(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (q) onType("");
                  else setSearchOpen(false);
                }
              }}
              placeholder="Фильмы, сериалы…"
              className={cn(
                "h-9 w-full rounded-lg border border-white/25 bg-black/55 px-3 text-white outline-none backdrop-blur",
                "placeholder:text-white/45 focus:border-white/50",
                typeClass("body")
              )}
            />
          </div>
          <button
            aria-label="Поиск"
            onClick={() => {
              if (!expanded) setSearchOpen(true);
              else if (q) onType("");
              else if (!onSearchPage) setSearchOpen(false);
            }}
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors cursor-pointer",
              expanded ? "text-foreground" : "text-white/70 hover:bg-white/10 hover:text-white"
            )}
          >
            <Search size={18} />
          </button>
        </div>
      </div>
    </header>
  );
}

export function Nav() {
  return (
    <Suspense>
      <NavInner />
    </Suspense>
  );
}
