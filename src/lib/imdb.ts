import { Env } from "./types";
import { cacheGet, cacheSet, netFetch } from "./utils";
import { SOURCES, sourceByPrefix } from "../registry";
import { searchVariants } from "./slugmap";

// ---------------------------------------------------------------------------
// Capa IMDb: traduce ids de Stremio con prefijo "tt" (IMDb) a ids internos de
// las fuentes. Dos traducciones encadenadas, cada una cacheada en KV:
//
//   tt0385326  --TMDB find-->  nombre de la serie ("Hana Yori Dango")
//              --search en las fuentes--> id de serie interno ("kplay:slug-…")
//
// El consumidor llama a resolveImdb() para `{ imdb, title }` y a
// imdbToInternal() para obtener el id de EPISODIO "dlat:slug-sxe" que se
// entregará al fan-out de resolve.getStreams (que reúne streams de TODAS las
// fuentes, como con cualquier id interno).
// ---------------------------------------------------------------------------

/** Ids de IMDb de Stremio: "tt…" puro (meta / stream sin episodio) o
 *  "tt…:s:e" (stream de un episodio; Stremio lo envía cuando la meta declara
 *  videos con ese id, como hace Torrentio). Sin s/e se asume 1x1. */
export type ImdbRef = { imdbId: string; season: number; episode: number };

const IMDB_RE = /^(tt\d{6,})(?::(\d+))?(?::(\d+))?$/;

export function parseImdbId(rawId: string): ImdbRef | null {
  const m = rawId.match(IMDB_RE);
  if (!m) return null;
  return {
    imdbId: m[1],
    season: m[2] ? parseInt(m[2], 10) : 1,
    episode: m[3] ? parseInt(m[3], 10) : 1,
  };
}

export function isImdbId(rawId: string): boolean {
  return IMDB_RE.test(rawId);
}

// ─── TMDB: tt → título ──────────────────────────────────────────────────────

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p/w500";
const IMDB_INFO_TTL = 30 * 24 * 3600; // 30 días: un tt siempre será la misma serie

export type ImdbSeriesInfo = {
  imdbId: string;
  /** id TMDB (para la meta: detalles + lista de temporadas); 0 = fallback
   *  Cinemeta (sin detalles TMDB) */
  tmdbId: number;
  name: string;
  originalName: string;
  poster: string;
  background: string;
  description: string;
  year: string;
  /** videos del fallback Cinemeta: episodes con "tt:s:e" reasignados */
  cinemetaVideos?: { id: string; name: string; season: number; episode: number }[];
};

/** find/{tt}?external_source=imdb_id → ficha TMDB de la serie.
 *  Solo series (tv_results): los streams de este addon son de doramas/series.
 *  Fallback sin TMDB_KEY: el nombre sale de Cinemeta (API pública de Stremio,
 *  mismo upstream que las fichas nativas) — la búsqueda en las fuentes solo
 *  necesita el título, y la meta minimal se arma con lo que devuelva. */
export async function fetchImdbSeries(
  imdbId: string,
  tmdbKey: string
): Promise<ImdbSeriesInfo | null> {
  if (tmdbKey) {
    try {
      const find = await netFetch(
        "tmdb",
        `${TMDB_BASE}/find/${imdbId}?api_key=${tmdbKey}&external_source=imdb_id&language=es-ES`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) }
      );
      if (!find.ok) throw new Error(`tmdb find HTTP ${find.status}`);
      const data: any = await find.json();
      const hit = data.tv_results?.[0];
      if (!hit?.id) throw new Error("sin tv_results");

      const details = await netFetch(
        "tmdb",
        `${TMDB_BASE}/tv/${hit.id}?api_key=${tmdbKey}&language=es-ES`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) }
      ).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const d: any = details;

      return {
        imdbId,
        tmdbId: hit.id,
        name: (d?.name || hit.name || "").trim(),
        originalName: (d?.original_name || hit.original_name || "").trim(),
        poster: hit.poster_path
          ? `${TMDB_IMG}${hit.poster_path}`
          : d?.poster_path
          ? `${TMDB_IMG}${d.poster_path}`
          : "",
        background: d?.backdrop_path
          ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}`
          : "",
        description: d?.overview || "",
        year: (d?.first_air_date || hit.first_air_date || "").slice(0, 4),
      };
    } catch (e) {
      console.log(`[imdb] TMDB falló (${e}), fallback Cinemeta: ${imdbId}`);
    }
  }

  // Fallback Cinemeta: nombre (+name) y poster; tmdbId=0 (sin detalles
  // TMDB → meta ligera sin episode_count reales).
  try {
    const r = await netFetch(
      "cinemeta",
      `https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(imdbId)}.json`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const m: any = await r.json();
    const meta = m.meta || {};
    if (!meta.name) return null;
    return {
      imdbId,
      tmdbId: 0,
      name: String(meta.name).trim(),
      originalName: String(meta.originalName || meta.name).trim(),
      poster: (meta.poster || "").replace(/^http:/, "https:"),
      background: meta.background || "",
      description: meta.description || "",
      year: String(meta.releaseInfo || "").split(/[-–]/)[0].trim(),
      cinemetaVideos: (meta.videos || [])
        .filter((v: any) => v.season > 0 && v.episode > 0)
        .map((v: any) => ({
          id: `${imdbId}:${v.season}:${v.episode}`,
          name: v.name || `${meta.name} · Episodio ${v.episode}`,
          season: v.season,
          episode: v.episode,
        })),
    };
  } catch {
    return null;
  }
}

/** Ficha IMDb → nombre, con caché KV `imdb:v1:{tt}` y caché negativa
 *  explícita (`name` vacío = el tt no es una serie conocida). */
export async function getImdbSeries(
  imdbId: string,
  tmdbKey: string,
  env: Env
): Promise<ImdbSeriesInfo | null> {
  const key = `imdb:v1:${imdbId}`;
  const cached = (await cacheGet(key, env.STREAM_CACHE)) as ImdbSeriesInfo | null;
  if (cached) return cached.name ? cached : null;
  const info = await fetchImdbSeries(imdbId, tmdbKey);
  // Cuando no hay ficha se escribe el objeto vacío como caché negativa; con
  // ficha (TMDB o Cinemeta) se cachea entera.
  if (env.STREAM_CACHE)
    await cacheSet(
      key,
      info ?? { imdbId, tmdbId: 0, name: "", originalName: "", poster: "", background: "", description: "", year: "" },
      IMDB_INFO_TTL,
      env.STREAM_CACHE
    );
  return info;
}

// ─── matching título → id interno ───────────────────────────────────────────

/** Normalización de matching: lowercase sin acentos ni puntuación. */
function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "de", "la", "el", "los", "las", "del", "y", "o", "a", "en", "con", "por", "para",
  "un", "una", "al", "su", "the", "of", "and", "from",
  "sub", "subtitulado", "subtitulada", "latino", "castellano", "dobrado", "doblada",
  "online", "hd", "completo", "estreno", "temporada", "ver", "season", "episodio",
]);

function tokens(s: string): string[] {
  return norm(s)
    .split(" ")
    .filter(Boolean)
    .filter((w) => !STOPWORDS.has(w));
}

/** Contención bidireccional de tokens (mismo criterio que slugmap.scoreSeries,
 *  aquí sobre nombres visibles de meta en vez de slugs). */
function scoreName(t: string, cand: string): number {
  const tt = tokens(t);
  const ct = tokens(cand);
  if (!tt.length || !ct.length) return 0;
  let hits = 0;
  for (const w of tt) if (ct.includes(w)) hits++;
  if (hits < Math.min(2, tt.length)) return 0;
  return Math.max(hits / tt.length, hits / ct.length);
}

/** Match más fuerte entre un metaName y los nombres canónicos de la serie. */
function bestScore(series: ImdbSeriesInfo, metaName: string): number {
  return Math.max(
    scoreName(series.name, metaName),
    scoreName(series.originalName, metaName)
  );
}

export type ImdbMatch = {
  /** id de serie interno, p.ej. "kplay:hana-yori-dango" */
  seriesId: string;
  name: string;
  score: number;
};

const IMDB_MAP_TTL = 7 * 24 * 3600; // 7 días: la correspondencia tt→slug es estable

/** tt → ids de serie en las fuentes. Lanza la búsqueda por título contra cada
 *  fuente vía su getCatalog (misma vía que usa el usuario en el catálogo) y
 *  matchea nombres con scoreName. Cachea en KV `imdb:map:v1:{tt}` (con caché
 *  negativa `:nx` para tts que están en TMDB pero en ninguna fuente: si se
 *  estrenan el mapa se refresca con /cache-clear o a las 24h). */
export async function getImdbMatches(
  series: ImdbSeriesInfo,
  env: Env
): Promise<ImdbMatch[]> {
  const kv = env.STREAM_CACHE;
  const key = `imdb:map:v1:${series.imdbId}`;
  if (kv) {
    const cached = (await cacheGet(key, kv)) as ImdbMatch[] | null;
    const neg = (await cacheGet(`imdb:map:v1nx:${series.imdbId}`, kv)) as boolean | null;
    if (cached?.length) return cached;
    if (neg) return [];
  }

  // Los sitios guardan títulos ES ("Boys over Flowers") más a menudo que el
  // hangul romanizado; se prueban ambos, y variantes tipo "2 primeras
  // palabras" para el REST/LIKE de DooPlay.
  const queries = [series.name, series.originalName].filter(Boolean);
  const matches = new Map<string, ImdbMatch>();

  for (const s of SOURCES) {
    for (const q of queries) {
      let found = false;
      for (const variant of searchVariants(q)) {
        try {
          const r = await s.getCatalog({ search: variant }, env);
          for (const m of r?.metas ?? []) {
            const sc = bestScore(series, m.name || "");
            if (sc < 0.5) continue;
            const prev = matches.get(m.id);
            if (!prev || prev.score < sc)
              matches.set(m.id, { seriesId: m.id, name: m.name, score: sc });
            if (sc >= 0.99) found = true;
          }
        } catch (e) {
          console.log(`[imdb] search en ${s.prefix} falló: ${e}`);
        }
        if (found) break;
      }
      if (found) break; // match completo en esta fuente: no probar más variantes
    }
  }

  const list = [...matches.values()].sort((a, b) => b.score - a.score);
  if (kv) {
    if (list.length) await cacheSet(key, list, IMDB_MAP_TTL, kv);
    else await cacheSet(`imdb:map:v1nx:${series.imdbId}`, true, 24 * 3600, kv);
  }
  return list;
}

// ─── streams: tt[:s:e] → id de episodio interno ─────────────────────────────

/** Traducción completa para getStreams: elige la fuente con mejor match,
 *  arma su id de episodio `{prefix}:{seriesSlug}-{s}x{e}` (formato canónico),
 *  y lo devuelve listo para resolve.getStreams, que hace el fan-out al resto
 *  de fuentes vía epSlug. Null si el tt no resuelve a ninguna fuente. */
export async function imdbToEpisodeId(
  ref: ImdbRef,
  tmdbKey: string,
  env: Env
): Promise<string | null> {
  const series = await getImdbSeries(ref.imdbId, tmdbKey, env);
  if (!series) return null;
  const matches = await getImdbMatches(series, env);
  if (!matches.length) return null;

  for (const m of matches) {
    const prefix = m.seriesId.split(":")[0];
    const def = sourceByPrefix(prefix);
    if (!def) continue;
    const seriesSlug = m.seriesId.slice(prefix.length + 1);
    const epId = def.buildId(`${seriesSlug}-${ref.season}x${ref.episode}`);
    // Solo es un candidato válido si la fuente lo reconoce como episodio
    // (formatos tipo "yandi:ep:…", ids "1x1" de movies, etc.)
    if (def.isEpisodeId(epId)) return epId;
    console.log(`[imdb] candidato no es episodeId para ${prefix}: ${epId}`);
  }
  return null;
}

// ─── meta mínima desde TMDB ─────────────────────────────────────────────────

/** Meta ligera por tt: ficha TMDB + videos "tt:s:e" por temporada (con
 *  episode_count de TMDB). Sin afinar con data de las fuentes: la ficha
 *  completa de la fuente interna sigue disponible con su id propio. */
export async function getMetaFromImdb(
  ref: ImdbRef,
  tmdbKey: string,
  env: Env
): Promise<{ meta: any }> {
  const series = await getImdbSeries(ref.imdbId, tmdbKey, env);
  if (!series) return { meta: null };
  const kv = env.STREAM_CACHE;
  const videosKey = `imdb:v1eps:${series.imdbId}`;
  let videos = (await cacheGet(videosKey, kv)) as any[] | null;

  if (!videos && series.cinemetaVideos?.length) {
    // Fallback Cinemeta: lista de episodios ya viene con temporada/número
    videos = series.cinemetaVideos;
    if (kv) await cacheSet(videosKey, videos, IMDB_INFO_TTL, kv);
  }

  if (!videos) {
    try {
      const details = await netFetch(
        "tmdb",
        `${TMDB_BASE}/tv/${series.tmdbId}?api_key=${tmdbKey}&language=es-ES`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) }
      );
      if (!details.ok) return { meta: null };
      const d: any = await details.json();
      videos = (d.seasons || [])
        .filter((s: any) => (s.season_number || 0) > 0 && (s.episode_count || 0) > 0)
        .flatMap((s: any) =>
          Array.from({ length: s.episode_count }, (_, i) => ({
            id: `${series.imdbId}:${s.season_number}:${i + 1}`,
            name: `${s.name || `Temporada ${s.season_number}`} · Episodio ${i + 1}`,
            season: s.season_number,
            episode: i + 1,
          }))
        );
      if (kv) await cacheSet(videosKey, videos, IMDB_INFO_TTL, kv);
    } catch {
      return { meta: null };
    }
  }

  return {
    meta: {
      id: series.imdbId,
      type: "series",
      name: series.name || series.originalName,
      originalName: series.originalName,
      poster: series.poster,
      background: series.background,
      description: series.description,
      year: series.year,
      releaseInfo: series.year,
      posterShape: "poster",
      videos,
    },
  };
}
