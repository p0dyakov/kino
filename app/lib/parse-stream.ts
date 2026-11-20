import { fetchRuStreams, fetchStreams, type JacItem, type StreamRaw } from "./api";

export interface ParsedStream {
  infoHash: string;
  fileIdx: number;
  sources: string[];
  releaseName: string;
  quality: string;       // "4k" | "1080p" | "720p" | "480p" | "sd"
  qualityRank: number;   // 4k=4, 1080p=3...
  hdr: string[];         // ["DV","HDR10+","HDR"]
  codec: string;         // hevc | av1 | h264
  source: string;        // BluRay REMUX | WEB-DL | BluRay | WEBRip | HDTV | BDRip
  sizeGb: number;
  seeds: number | null;
  provider: string;
  hasRu: boolean;
  audioChips: string[];
  bonus?: number;         // extra rank (e.g. matching season pack)
  raw: StreamRaw;
}

const STUDIOS: [RegExp, string][] = [
  [/lostfilm/i, "LostFilm"],
  [/кубик|kubik/i, "Кубик в Кубе"],
  [/hdrezka|резка/i, "HDRezka"],
  [/newstudio/i, "NewStudio"],
  [/alexfilm/i, "AlexFilm"],
  [/tvshows/i, "TVShows"],
  [/кураж|kuraj|kurage/i, "Кураж-Бамбей"],
  [/baibako|rudub|байбако/i, "BaibaKo"],
  [/coldfilm/i, "ColdFilm"],
  [/jaskier|яскер/i, "Jaskier"],
  [/amedia|novamedia/i, "Amedia"],
  [/ideafilm/i, "IdeaFilm"],
  [/newcomers/i, "NewComers"],
  [/red\s*head|rhs/i, "Red Head Sound"],
  [/ultradox/i, "Ultradox"],
  [/dnipro|днепр/i, "Dnipro"],
  [/good\s*people|добрых|доброе/i, "Good People"],
  [/moviedalen/i, "MovieDalen"],
  [/le-?production/i, "LE-Production"],
  [/produblyazh/i, "ProDublyazh"],
  [/ultrahdclub/i, "UltraHDClub"],
  [/elektri4ka/i, "ELEKTRI4KA"],
  [/exkinoray/i, "ExKinoRay"],
  [/gavrilov|гаврилов/i, "Гаврилов"],
  [/glafira|глафира/i, "Глафира"],
  [/гоблин/i, "Гоблин"],
];

export function parseStream(s: StreamRaw): ParsedStream {
  const title = s.title ?? "";
  const lines = title.split("\n");
  const releaseName = lines[0] ?? "";
  const stats = lines[1] ?? "";
  const flags = lines[2] ?? "";
  const nameLine = (s.name ?? "").split("\n")[1] ?? "";

  const seedCount = title.match(/👤\s*(\d+)/)?.[1];
  const seeds = seedCount === undefined ? null : Number(seedCount);
  const sizeM = stats.match(/💾\s*([\d.]+)\s*([GMK]B)/i);
  let sizeGb = 0;
  if (sizeM) {
    const v = parseFloat(sizeM[1]);
    sizeGb = /GB/i.test(sizeM[2]) ? v : /MB/i.test(sizeM[2]) ? v / 1024 : v / 1048576;
  }
  const provider = stats.match(/⚙️\s*(\S+)/)?.[1] ?? "";
  const hasRu = flags.includes("🇷🇺") || /рус|rus|\bD\b(?![a-z])/i.test(releaseName);

  const binge = (s.behaviorHints?.bingeGroup ?? "").toLowerCase();
  const hay = `${nameLine} ${releaseName} ${binge}`;

  let quality = "sd", qualityRank = 1;
  if (/4k|2160p/i.test(hay)) { quality = "4K"; qualityRank = 4; }
  else if (/1080p/i.test(hay)) { quality = "1080p"; qualityRank = 3; }
  else if (/720p/i.test(hay)) { quality = "720p"; qualityRank = 2; }

  const hdr: string[] = [];
  if (/\bDV\b|dolby\s*vision/i.test(hay)) hdr.push("DV");
  if (/hdr10\+/i.test(hay)) hdr.push("HDR10+");
  else if (/hdr10/i.test(hay)) hdr.push("HDR10");
  else if (/\bhdr\b/i.test(hay)) hdr.push("HDR");

  let codec = "";
  if (/hevc|h\.?265|x265/i.test(hay)) codec = "HEVC";
  else if (/av1/i.test(hay)) codec = "AV1";
  else if (/h\.?264|x264|avc\b/i.test(hay)) codec = "H.264";

  let source = "";
  const srcM = binge.split("|").find((t) =>
    /remux|web-?dl|bluray|webrip|hdtv|bdrip|dvd/i.test(t));
  if (srcM) source = srcM.replace(/^blu?ray\s*/i, "").toUpperCase().replace("BLU RAY", "BluRay");
  else if (/remux/i.test(hay)) source = "REMUX";
  else if (/web-?dl/i.test(hay)) source = "WEB-DL";
  else if (/bluray|blu-?ray|bdrip/i.test(hay)) source = "BluRay";
  else if (/webrip/i.test(hay)) source = "WEBRip";

  const audioChips: string[] = [];
  const cntM = releaseName.match(/(\d+)\s*x\s*(mvo|dvo|avo|vo)\b/gi);
  if (cntM) {
    for (const m of cntM) audioChips.push(m.replace(/\s+/g, " ").toUpperCase());
  }
  if (/\b(dub|дубляж|дублирован)\b/i.test(releaseName)) audioChips.unshift("Дубляж");
  if (/лицензия/i.test(releaseName)) audioChips.push("Лицензия");
  for (const [re, name] of STUDIOS)
    if (re.test(releaseName)) { audioChips.push(name); break; }
  if (/\boriginal|оригинал\b/i.test(releaseName)) audioChips.push("Оригинал");
  if (/\bsub|субтитр/i.test(releaseName)) audioChips.push("Сабы");
  if (hasRu && audioChips.length === 0) audioChips.push("Русский");

  return {
    infoHash: s.infoHash,
    fileIdx: s.fileIdx ?? -1,
    sources: s.sources ?? [],
    releaseName,
    quality, qualityRank, hdr, codec, source,
    sizeGb, seeds, provider, hasRu, audioChips,
    raw: s,
  };
}

// jac.black (JacRed) result → ParsedStream. Fields come from `info` block
// (parsed by jacred) with title-regex fallbacks. `season` boosts packs
// containing the wanted season and full-series packs.
export function parseRuStream(x: JacItem, season?: number): ParsedStream | null {
  const m = /btih:([a-f0-9]{40})/i.exec(x.MagnetUri ?? "");
  if (!m) return null;
  const title = x.Title ?? "";
  const info = x.info ?? {};
  const hay = title;

  let quality = "sd", qualityRank = 1;
  const q = info.quality ?? 0;
  if (q >= 2160 || /2160p|\buhd\b|\b4k\b/i.test(hay)) { quality = "4K"; qualityRank = 4; }
  else if (q >= 1080 || /1080p/i.test(hay)) { quality = "1080p"; qualityRank = 3; }
  else if (q >= 720 || /720p/i.test(hay)) { quality = "720p"; qualityRank = 2; }

  const vt = (info.videotype ?? "").toLowerCase();
  const hdr: string[] = [];
  if (vt === "dolbyvision" || /\bDV\b|dolby\s*vision/i.test(hay)) hdr.push("DV");
  if (vt === "hdr10plus" || /hdr10\+/i.test(hay)) hdr.push("HDR10+");
  else if (vt === "hdr10" || /hdr10/i.test(hay)) hdr.push("HDR10");
  else if (vt === "hdr" || /\bhdr\b/i.test(hay)) hdr.push("HDR");

  const mv = info.media?.video ?? "";
  const chay = `${mv} ${hay}`;
  let codec = "";
  if (/hevc|h\.?265|x265/i.test(chay)) codec = "HEVC";
  else if (/av1/i.test(chay)) codec = "AV1";
  else if (/h\.?264|x264|\bavc\b/i.test(chay)) codec = "H.264";

  let source = "";
  if (/remux/i.test(hay)) source = "REMUX";
  else if (/web-?dl/i.test(hay)) source = "WEB-DL";
  else if (/webrip/i.test(hay)) source = "WEBRip";
  else if (/blu-?ray|bdrip/i.test(hay)) source = "BluRay";
  else if (/hdtv|satrip|iptv/i.test(hay)) source = "HDTV";

  const voices = (info.voices ?? []).filter(Boolean);
  const hasRu = voices.length > 0 || /[а-яё]/i.test(title) ||
    /rutracker|rutor|kinozal|nnmclub|bitru|rudub|megapeer|tapochek|korsars|rustorka|selezen|baibako|newstudio|toloka|pirat/i
      .test(x.Tracker ?? "");

  const audioChips: string[] = voices.slice(0, 4);
  if (hasRu && audioChips.length === 0) audioChips.push("Русский");

  const sources = (x.MagnetUri ?? "").split("&")
    .filter((p) => p.startsWith("tr="))
    .map((p) => "tracker:" + decodeURIComponent(p.slice(3)));

  return {
    infoHash: m[1].toLowerCase(),
    fileIdx: -1,
    sources,
    releaseName: title,
    quality, qualityRank, hdr, codec, source,
    sizeGb: (x.Size ?? 0) / 1e9,
    seeds: x.Seeders ?? null,
    provider: x.Tracker ?? "jacred",
    hasRu,
    audioChips,
    bonus: season ? seasonBonus(title, season) : 0,
    raw: { infoHash: m[1].toLowerCase(), fileIdx: -1, sources, title },
  };
}

// Season-pack relevance: "+1 tier" if the release names the wanted season,
// "+half" for multi-season packs. Extracts the season number from the
// usual release-name shapes instead of loose matching ("6 сезон: 1-7 серии"
// must not score as season 1).
function seasonBonus(title: string, season: number): number {
  const range = /(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*сезон/i.exec(title)
    || /\bs0*(\d{1,2})\s*[-–—]\s*s?0*(\d{1,2})\b/i.exec(title);
  if (range && +range[1] <= season && season <= +range[2]) return 30;
  const m = /(\d{1,2})\s*сезон/i.exec(title)
    || /сезон[:\s]*(\d{1,2})/i.exec(title)
    || /\bseason\s*0*(\d{1,2})\b/i.exec(title)
    || /\bs0*(\d{1,2})(?=[ ._exx-]|$)/i.exec(title)
    || /\b(\d{1,2})x\d{2}\b/i.exec(title);
  if (m) return +m[1] === season ? 60 : 0;
  return /все сезоны|полная серия|\bcomplete\b/i.test(title) ? 30 : 0;
}

export function sortStreams(list: ParsedStream[]): ParsedStream[] {
  // stable + best quality first: quality tier weighs most, then seed health
  const score = (s: ParsedStream) =>
    s.qualityRank * 25 + Math.min(Math.log10((s.seeds ?? 0) + 1) * 15, 45) + (s.bonus ?? 0);
  return list.filter((s) => s.seeds !== 0).sort((a, b) =>
    (b.hasRu ? 1 : 0) - (a.hasRu ? 1 : 0) || score(b) - score(a));
}

function mergeSources(tio: ParsedStream[], ru: ParsedStream[], epQ?: string): ParsedStream[] {
  const seen = new Set(tio.map((s) => s.infoHash));
  const merged = new Map<string, ParsedStream>();
  for (const input of ru) {
    const s = { ...input, raw: { ...input.raw } };
    if (seen.has(s.infoHash)) continue;
    const k = s.releaseName.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() || s.infoHash;
    const prev = merged.get(k);
    if (!prev) { merged.set(k, s); continue; }
    const keep = (s.seeds ?? -1) > (prev.seeds ?? -1) ? s : prev;
    const drop = keep === s ? prev : s;
    keep.sources = [...new Set([...keep.sources, ...drop.sources])];
    keep.raw.sources = keep.sources;
    merged.set(k, keep);
  }
  const extra = [...merged.values()];
  if (epQ) for (const s of extra) s.raw.fileQuery = epQ;
  return sortStreams([...tio, ...extra]);
}

/** Torrentio + jac.black merged, deduped by hash and by release name
 *  (multi-tracker duplicates collapse into one card, trackers merged).
 *  For episodes, jac sources get a fileQuery regex so the engine picks
 *  the right file inside season packs. `query` = title+year or title.
 *  `onPartial` fires with a merged snapshot as each provider resolves. */
export async function fetchMergedStreams(
  type: string,
  imdbId: string,
  query: string | null,
  season?: number,
  episode?: number,
  onPartial?: (items: ParsedStream[]) => void
): Promise<ParsedStream[]> {
  const epQ = season != null && episode != null
    ? `s0*${season}[ ._x-]*e0*${episode}\\b|\\b0*${season}x0*${episode}\\b`
    : undefined;
  let tio: ParsedStream[] = [], ru: ParsedStream[] = [];
  const publish = () => onPartial?.(mergeSources(tio, ru, epQ));
  await Promise.all([
    fetchStreams(type, imdbId, season, episode).then((raw) => {
      tio = raw.map(parseStream).filter((s) => s.seeds !== 0);
      if (tio.length) publish();
    }),
    query
      ? fetchRuStreams(query).then((raw) => {
          ru = raw.map((r) => parseRuStream(r, season)).filter((s): s is ParsedStream => s != null && s.seeds !== 0);
          if (ru.length) publish();
        })
      : Promise.resolve(),
  ]);
  return mergeSources(tio, ru, epQ);
}
