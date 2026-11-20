import { cachedJson } from "@/lib/store";

const CINEMETA = "https://v3-cinemeta.strem.io";
const CINEMETA_CATALOGS = "https://cinemeta-catalogs.strem.io";
const TORRENTIO = "https://torrentio.strem.fun";

export const ENGINE =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_ENGINE_URL) || "";

export interface MetaItem {
  id: string;
  type: "movie" | "series";
  name: string;
  poster?: string;
  background?: string;
  releaseInfo?: string;
  imdbRating?: string;
  genres?: string[];
}

export interface MetaVideo {
  id: string;
  title: string;
  season: number;
  episode: number;
  released?: string;
  thumbnail?: string;
}

export interface MetaDetail extends MetaItem {
  description?: string;
  genres?: string[];
  runtime?: string;
  cast?: string[];
  director?: string[];
  year?: string;
  logo?: string;
  trailerStreams?: { title?: string; ytId: string }[];
  videos?: MetaVideo[];
}

export interface StreamRaw {
  name?: string;
  title?: string;
  infoHash: string;
  fileIdx?: number;
  fileQuery?: string;
  sources?: string[];
  behaviorHints?: {
    bingeGroup?: string;
    filename?: string;
  };
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const searchCacheKey = (query: string) =>
  `search:v2:${query.trim().toLowerCase()}`;

export async function searchTitles(query: string): Promise<MetaItem[]> {
  const q = query.trim();
  if (!q) return [];
  return cachedJson(searchCacheKey(q), 15 * 60e3, () => searchTitlesUncached(q));
}

/** imdb suggestion api — results ordered by popularity rank; used to re-rank
 *  cinemeta's fuzzy substring matches (which bury exact titles under junk) */
async function imdbRanks(query: string): Promise<Map<string, number>> {
  const t = query.trim().toLowerCase();
  if (!t) return new Map();
  const rows = await cachedJson(`imr:${t}`, 15 * 60e3, async () => {
    const d = await getJson<{ d: { id?: string; rank?: number }[] }>(
      `https://v2.sg.media-imdb.com/suggestion/${encodeURIComponent(t[0])}/${encodeURIComponent(t.replace(/\s+/g, "_"))}.json`
    );
    if (!d) return null;
    const out: [string, number][] = [];
    for (const x of d.d ?? []) {
      if (x.id && typeof x.rank === "number") out.push([x.id, x.rank]);
    }
    return out;
  });
  return new Map(rows ?? []);
}

function rankTitles(items: MetaItem[], query: string, ranks = new Map<string, number>()) {
  const q = query.trim().toLowerCase();
  const tier = (name: string) => {
    const n = name.toLowerCase();
    return n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : 3;
  };
  return [...items].sort((a, b) =>
    tier(a.name) - tier(b.name) ||
    (ranks.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
    (Number(b.imdbRating) || 0) - (Number(a.imdbRating) || 0));
}

async function searchTitlesUncached(q: string): Promise<MetaItem[]> {
  const enc = encodeURIComponent(q);
  const [movies, series] = await Promise.all([
    getJson<{ metas: MetaItem[] }>(`${CINEMETA}/catalog/movie/top/search=${enc}.json`),
    getJson<{ metas: MetaItem[] }>(`${CINEMETA}/catalog/series/top/search=${enc}.json`),
  ]);
  const seen = new Set<string>();
  const out: MetaItem[] = [];
  for (const m of [...(series?.metas ?? []), ...(movies?.metas ?? [])]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return rankTitles(out, q);
}

export async function refineSearchTitles(query: string, results: MetaItem[]) {
  if (results.length < 2) return results;
  const ranks = await imdbRanks(query);
  return ranks.size ? rankTitles(results, query, ranks) : results;
}

export async function fetchCatalog(type: "movie" | "series"): Promise<MetaItem[]> {
  return cachedJson(`cat:${type}`, 30 * 60e3, async () => {
    const d = await getJson<{ metas: MetaItem[] }>(
      `${CINEMETA_CATALOGS}/top/catalog/${type}/top.json`
    );
    return d?.metas ?? [];
  });
}

export async function fetchGenreCatalog(type: "movie" | "series", genre: string): Promise<MetaItem[]> {
  return cachedJson(`genre:${type}:${genre}`, 60 * 60e3, async () => {
    const d = await getJson<{ metas: MetaItem[] }>(
      `${CINEMETA_CATALOGS}/top/catalog/${type}/top/genre=${encodeURIComponent(genre)}.json`
    );
    return d?.metas ?? [];
  });
}

export const BROWSE_GENRES: [string, string][] = [
  ["action", "Боевики"],
  ["comedy", "Комедии"],
  ["drama", "Драмы"],
  ["thriller", "Триллеры"],
  ["sci-fi", "Фантастика"],
  ["horror", "Ужасы"],
  ["animation", "Мультфильмы"],
  ["crime", "Криминал"],
  ["documentary", "Документальные"],
  ["family", "Семейные"],
  ["fantasy", "Фэнтези"],
  ["adventure", "Приключения"],
  ["mystery", "Детективы"],
  ["romance", "Мелодрамы"],
  ["war", "Военные"],
  ["western", "Вестерны"],
  ["history", "Исторические"],
];

/** actor headshot via wikipedia pageimages — cached ~30d */
export async function fetchActorPhoto(name: string): Promise<string | null> {
  return cachedJson(`actor:${name}`, 30 * 24 * 3600e3, async () => {
    interface WikiPage { thumbnail?: { source: string } }
    const d = await getJson<{ query: { pages: Record<string, WikiPage> } }>(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(name)}` +
        `&prop=pageimages&pithumbsize=300&redirects=1&format=json&origin=*`
    );
    const pages = d?.query?.pages;
    if (!pages) return null;
    return Object.values(pages)[0]?.thumbnail?.source ?? null;
  });
}

export interface CastMember {
  name: string;
  photo?: string;
}

/** full credited cast via wikidata (imdb id -> P161 cast member -> P18 image),
 *  ordered by actor sitelink count which approximates billing order */
export async function fetchFullCast(imdbId: string): Promise<CastMember[]> {
  return cachedJson(`cast:${imdbId}`, 7 * 24 * 3600e3, async () => {
    const q =
      `SELECT DISTINCT ?actorLabel ?image ?links WHERE {` +
      ` ?film wdt:P345 "${imdbId}" . ?film wdt:P161 ?actor .` +
      ` OPTIONAL { ?actor wdt:P18 ?image } ?actor wikibase:sitelinks ?links` +
      ` SERVICE wikibase:label { bd:serviceParam wikibase:language "en" } }` +
      ` ORDER BY DESC(?links) LIMIT 30`;
    interface B { actorLabel?: { value: string }; image?: { value: string } }
    const d = await getJson<{ results: { bindings: B[] } }>(
      `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`
    );
    const seen = new Set<string>();
    const out: CastMember[] = [];
    for (const b of d?.results?.bindings ?? []) {
      const name = b.actorLabel?.value;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const img = b.image?.value;
      out.push({
        name,
        photo: img
          ? img.replace("http://commons.wikimedia.org/wiki/Special:FilePath/",
                        "https://commons.wikimedia.org/wiki/Special:FilePath/") + "?width=200"
          : undefined,
      });
    }
    // resolve missing photos now so the cached payload is complete for everyone
    await Promise.all(out.map(async (m) => {
      if (!m.photo) m.photo = (await fetchActorPhoto(m.name)) ?? undefined;
    }));
    return out;
  });
}

export async function fetchMeta(type: string, id: string): Promise<MetaDetail | null> {
  return cachedJson(`meta:${type}:${id}`, 6 * 3600e3, async () => {
    const d = await getJson<{ meta: MetaDetail }>(`${CINEMETA}/meta/${type}/${id}.json`);
    return d?.meta ?? null;
  });
}

export async function fetchStreams(
  type: string,
  id: string,
  season?: number,
  episode?: number
): Promise<StreamRaw[]> {
  const vid = season != null && episode != null ? `${id}:${season}:${episode}` : id;
  return cachedJson(`streams:${vid}`, 10 * 60e3, async () => {
    const d = await getJson<{ streams: StreamRaw[] }>(
      `${TORRENTIO}/stream/${type}/${vid}.json`
    );
    return d?.streams ?? [];
  });
}

// ---------- jacred (rutracker/rutor/kinozal/nnmclub aggregation) ----------

export interface JacItem {
  Title?: string;
  Tracker?: string;
  MagnetUri?: string;
  Seeders?: number;
  Peers?: number;
  Size?: number;
  CategoryDesc?: string;
  PublishDate?: string;
  info?: {
    imdb?: string;
    kinopoisk?: string;
    quality?: number;
    types?: string[];
    videotype?: string;
    voices?: string[];
    media?: { video?: string };
    relased?: number;
    name?: string;
    originalname?: string;
  };
}

const JACRED = "https://jac.black";

export async function fetchRuStreams(query: string): Promise<JacItem[]> {
  return cachedJson(`ru:${query.toLowerCase()}`, 10 * 60e3, async () => {
    const d = await getJson<{ Results?: JacItem[] }>(
      `${JACRED}/api/v2.0/indexers/all/results?query=${encodeURIComponent(query)}`
    );
    return (d?.Results ?? []).filter((x) => x.MagnetUri && (x.Size ?? 0) > 200 * 1e6);
  });
}

// ---------- engine ----------

export function watchHref({ id, title, mid, type, episode, fileIdx, position }: {
  id: string; title: string; mid?: string; type?: string;
  episode?: string; fileIdx?: number; position?: number;
}) {
  const q = new URLSearchParams({ id, t: title });
  if (mid) q.set("mid", mid);
  if (type) q.set("mt", type);
  if (episode) q.set("ep", episode);
  if (fileIdx != null && fileIdx >= 0) q.set("fi", String(fileIdx));
  if (position != null && position > 25) q.set("pos", String(Math.floor(position)));
  return `/watch?${q}`;
}

export interface PlayResponse {
  ok: boolean;
  id?: string;
  error?: string;
}

export async function playStream(
  stream: StreamRaw,
  title: string,
  fileIdx?: number
): Promise<PlayResponse> {
  const res = await fetch(`${ENGINE}/api/play`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      infoHash: stream.infoHash,
      fileIdx: fileIdx ?? stream.fileIdx ?? -1,
      title,
      sources: stream.sources ?? [],
      ...(stream.fileQuery ? { fileQuery: stream.fileQuery } : {}),
    }),
  });
  return res.json();
}

export interface SessionStatus {
  state?: string;
  metadata?: boolean;
  title?: string;
  file?: string;
  fileSize?: number;
  progress?: number;
  downloadRate?: number;
  peers?: number;
  error?: string;
  dead?: boolean;
}

export async function sessionStatus(id: string): Promise<SessionStatus | null> {
  try {
    const res = await fetch(`${ENGINE}/api/session/${id}`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function engineHealth(): Promise<{ ok: boolean; sessions?: string[] } | null> {
  try {
    const res = await fetch(`${ENGINE}/api/health`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export interface TracksResponse {
  duration?: number;
  fileIdx?: number;
  video?: { codec: string; tag: string; width: number; height: number; mse: boolean };
  audio?: { idx: number; lang: string; title: string; codec: string; channels: number; default: boolean }[];
}

export async function fetchTracks(id: string): Promise<TracksResponse | null> {
  try {
    const res = await fetch(`${ENGINE}/api/session/${id}/tracks`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function stopSession(id: string): Promise<void> {
  try {
    await fetch(`${ENGINE}/api/session/${id}`, { method: "DELETE" });
  } catch {}
}

// ---------- downloads ----------

export interface DownloadStatus extends SessionStatus {
  id?: string;
  filePath?: string;
  isDownload?: boolean;
  state?: string;
  mid?: string;
  mt?: string;
  ep?: string;
  fileIdx?: number;
  ready?: boolean;
  warm?: boolean;
}

export async function startDownload(
  stream: StreamRaw,
  title: string,
  fileIdx?: number,
  context?: { mid: string; mt: string; ep?: string }
): Promise<boolean> {
  try {
    const res = await fetch(`${ENGINE}/api/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        infoHash: stream.infoHash,
        fileIdx: fileIdx ?? stream.fileIdx ?? -1,
        title,
        sources: stream.sources ?? [],
        ...(stream.fileQuery ? { fileQuery: stream.fileQuery } : {}),
        ...(context ?? {}),
      }),
    });
    return res.ok && (await res.json()).ok === true;
  } catch {
    return false;
  }
}

export async function fetchDownloads(): Promise<DownloadStatus[]> {
  try {
    const res = await fetch(`${ENGINE}/api/downloads`);
    if (!res.ok) return [];
    return (await res.json()) as DownloadStatus[];
  } catch {
    return [];
  }
}

export async function playDownload(id: string): Promise<{
  ok: boolean;
  id?: string;
  fileIdx?: number;
  mid?: string;
  mt?: string;
  ep?: string;
  title?: string;
  error?: string;
} | null> {
  try {
    const res = await fetch(`${ENGINE}/api/downloads/${id}/play`, { method: "POST" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function removeDownload(id: string): Promise<boolean> {
  try {
    const res = await fetch(`${ENGINE}/api/downloads/${id}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function revealDownload(id: string): Promise<void> {
  try {
    await fetch(`${ENGINE}/api/downloads/${id}/reveal`, { method: "POST" });
  } catch {}
}

export async function revealInFinder(id: string): Promise<void> {
  try {
    await fetch(`${ENGINE}/api/session/${id}/reveal`, { method: "POST" });
  } catch {}
}

// ---------- prefetch ----------

export async function startPrefetch(stream: StreamRaw, title: string): Promise<boolean> {
  try {
    const res = await fetch(`${ENGINE}/api/prefetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        infoHash: stream.infoHash,
        fileIdx: stream.fileIdx ?? -1,
        title,
        sources: stream.sources ?? [],
        ...(stream.fileQuery ? { fileQuery: stream.fileQuery } : {}),
      }),
    });
    return res.ok && (await res.json()).ok === true;
  } catch {
    return false;
  }
}

export async function prefetchStatus(stream: StreamRaw): Promise<{ warm?: boolean } | null> {
  try {
    const q = new URLSearchParams({
      fi: String(stream.fileIdx ?? -1),
      q: stream.fileQuery ?? "",
    });
    const res = await fetch(`${ENGINE}/api/prefetch/${stream.infoHash}?${q}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
