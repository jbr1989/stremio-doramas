import { Env } from "../lib/types";
import {
  cacheGet,
  cacheSet,
  cleanTitle,
  fetchHtml,
  denoBaseFromEnv,
  makeStreamDeduper,
} from "../lib/utils";
import { SourceBase, SourceCard, SourceEpisode } from "../lib/sourceBase";

const KISSASIA_BASE = "https://kissasia.cam";
const TMDB_IMAGE_PREFIX = "https://image.tmdb.org/t/p/w500";
// contentId → ficha de /api/content?id= (objeto con slug, título, géneros…).
// El slug se usa como título canónico en el fan-out: "between-steps-1x2" es
// traducible por slugmap, mientras que "kissasia-1758-1x2" solo contiene el
// contentId. La misma ficha alimenta la meta (géneros, año, póster 2:3).
const CONTENT_CACHE_PREFIX = "ka:content:";
const CONTENT_CACHE_TTL = 24 * 3600; // 24 h

export interface KissAsiaCardItem {
  id: number;
  slug: string;
  title: string;
  originalTitle?: string;
  type?: string;
  posterPath?: string;
  backdropPath?: string;
  genres?: string;
}

export interface KissAsiaContentResponse {
  items: KissAsiaCardItem[];
  total?: number;
  totalPages?: number;
  currentPage?: number;
}

export interface KissAsiaSubtitle {
  language?: string;
  label?: string;
  url?: string;
  isDefault?: boolean;
}

export interface KissAsiaMediaResponse {
  success?: boolean;
  videoUrl?: string;
  subtitles?: KissAsiaSubtitle[];
  contentTitle?: string;
  episodeTitle?: string | null;
  error?: string;
}

/** Ficha completa de `/api/content?id={contentId}`. La página `/drama/{slug}`
 *  no serializa `genres` ni el año; la API sí. */
export interface KissAsiaContentItem extends KissAsiaCardItem {
  overview?: string;
  releaseDate?: string;
  tmdbId?: number;
  rating?: number;
  country?: string;
  currentEpisode?: number;
  totalEpisodes?: number;
}

/** Resultado de fetchMetaPage: HTML (de ahí salen initialEpisodes) + ficha
 *  de la API para nombre/póster/descripción/géneros/año. */
export interface KissAsiaMetaData {
  html: string;
  info: KissAsiaContentItem | null;
}

const CONTENT_ID_RE = /contentId[\\\"]*:\s*[\\\"]*(\d+)/;

function extractContentId(html: string): string {
  const m = html.match(CONTENT_ID_RE);
  return m ? m[1] : "";
}

/** Acepta tanto el `{html, info}` nuevo como el HTML crudo (por si algún
 *  debug o llamada antigua pasa el string). */
function readMetaData(data: string | unknown): KissAsiaMetaData {
  if (typeof data === "string") return { html: data, info: null };
  const d = data as Partial<KissAsiaMetaData> | null;
  return {
    html: typeof d?.html === "string" ? d.html : "",
    info: d?.info ?? null,
  };
}

function tmdbImageUrl(path: string | undefined): string {
  const p = (path || "").trim();
  if (!p) return "";
  if (/^https?:\/\//i.test(p)) return p;
  return `${TMDB_IMAGE_PREFIX}${p.startsWith("/") ? p : `/${p}`}`;
}

/**
 * KissAsia (kissasia.cam) - Fuente de doramas en Next.js con API pública.
 * - Catálogo: GET /api/content?limit=24&page={page} (&q={search}, &genre={genre})
 * - Meta: GET /drama/{slug} (initialEpisodes/contentId) +
 *         GET /api/content?id={contentId} (título, géneros, año, póster)
 * - Streams: GET /api/get-media?contentId={contentId}&episodeId={episodeId}
 */
export class KissAsiaSource extends SourceBase {
  readonly prefix = "kissasia";
  readonly label = "KissAsia";
  readonly catalogId = "kissasia-directory";

  // Episodio = "kissasia:ep:{contentId}:{episodeId}:{number}" o "kissasia:ep:{contentId}" (películas)
  // Formato: ep:\d+:\d+(?::\d+)? o ep:\d+
  protected override readonly epIdPattern = "ep:\\d+(?::\\d+)*";

  // ── Fetch: usar fetchHtml permitiendo respuestas JSON cortas ──
  protected override async fetchBody(url: string, env: Env): Promise<string> {
    try {
      return await fetchHtml(url, env, { allowShort: true });
    } catch {
      return "";
    }
  }

  // ── Catálogo ──
  protected override get pageSize(): number {
    return 24;
  }

  // Solo series: la API mezcla 1.204 series (type=tv) y 471 películas
  // (type=movie) en /api/content. El catálogo de Stremio es type "series",
  // así que se filtra en origen —equivale a /video-library?type=tvseries—.
  protected override buildSearchUrl(q: string): string {
    return `${KISSASIA_BASE}/api/content?q=${encodeURIComponent(q)}&limit=${this.pageSize}&type=tv`;
  }

  protected override buildGenreUrl(gslug: string, page: number): string {
    return `${KISSASIA_BASE}/api/content?genre=${encodeURIComponent(gslug)}&limit=${this.pageSize}&page=${page}&type=tv`;
  }

  protected override buildListUrl(page: number): string {
    return `${KISSASIA_BASE}/api/content?limit=${this.pageSize}&page=${page}&type=tv`;
  }

  protected override parseCards(resText: string): SourceCard[] {
    try {
      const data: KissAsiaContentResponse = JSON.parse(resText);
      const items = Array.isArray(data.items) ? data.items : [];
      const cards: SourceCard[] = [];

      for (const item of items) {
        if (!item.slug) continue;
        const rawTitle = item.title || item.originalTitle || item.slug;
        let poster = item.posterPath || item.backdropPath || "";
        if (poster && !poster.startsWith("http")) {
          poster = `${TMDB_IMAGE_PREFIX}${poster.startsWith("/") ? poster : `/${poster}`}`;
        }

        cards.push({
          slug: item.slug,
          name: cleanTitle(rawTitle) || rawTitle,
          poster,
          type: item.type === "movie" ? "movie" : "series",
        });
      }

      return cards;
    } catch (e) {
      console.error(`[kissasia] Error parseando cards de catálogo: ${e}`);
      return [];
    }
  }

  // ── Meta ──
  protected override buildSeriesPageUrl(slug: string): string {
    return `${KISSASIA_BASE}/drama/${encodeURIComponent(slug)}`;
  }

  /** Baja la página (initialEpisodes) y, con su contentId, la ficha JSON de
   *  la API. La API es la fuente fiable de géneros/año/póster 2:3; el HTML
   *  queda como fallback si la API falla. */
  protected override async fetchMetaPage(
    slug: string,
    env?: Env
  ): Promise<KissAsiaMetaData> {
    if (!env) return { html: "", info: null };
    const html = await this.fetchBody(this.buildSeriesPageUrl(slug), env);
    const contentId = extractContentId(html);
    const info = contentId ? await this.contentInfo(contentId, env) : null;
    return { html, info };
  }

  protected override parseMetaBasics(data: string | unknown, slug: string) {
    const { html, info } = readMetaData(data);
    let name = "";
    let poster = "";
    let description = "";
    let year: string | undefined;

    // 1. Ficha de la API: valores exactos y póster 2:3 (posterPath).
    if (info) {
      let rawTitle = (info.title || info.originalTitle || "").trim();
      const y = (info.releaseDate || "").slice(0, 4);
      if (/^\d{4}$/.test(y)) {
        year = y;
        // El título de la API trae "(2026)"; el año ya va en releaseInfo.
        rawTitle = rawTitle.replace(/\s*\(\d{4}\)\s*$/, "").trim();
      }
      if (rawTitle) name = cleanTitle(rawTitle) || rawTitle;
      poster = tmdbImageUrl(info.posterPath || info.backdropPath);
      description = (info.overview || "").trim();
    }

    // 2. Fallback: JSON de Next.js incrustado en el HTML.
    if (!name) {
      const mTitle = html.match(/title[\\\"]*:\s*[\\\"]*([^\\\"}]+)/);
      if (mTitle) name = cleanTitle(mTitle[1].trim());
    }
    if (!poster) {
      const mPoster = html.match(/poster(?:ImageUrl|Path)[\\\"]*:\s*[\\\"]*([^\\\",}]+)/);
      if (mPoster) poster = tmdbImageUrl(mPoster[1].trim());
    }
    if (!description) {
      const mOverview = html.match(/overview[\\\"]*:\s*[\\\"]*([^\\\"}]+)/);
      if (mOverview) description = mOverview[1].trim();
    }

    // 3. Fallbacks de metaetiquetas OpenGraph.
    if (!name) {
      const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
      if (ogTitle) name = cleanTitle(ogTitle[1].replace(/\|\s*KissAsian.*$/i, "").trim());
    }
    if (!poster) {
      const ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
      if (ogImg) poster = ogImg[1].trim();
    }
    if (!description) {
      const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
      if (ogDesc) description = ogDesc[1].trim();
    }

    return {
      name: name || slug,
      poster,
      description,
      year,
    };
  }

  protected override parseGenres(data: string | unknown): string[] {
    const { html, info } = readMetaData(data);

    // La API entrega genres como string JSON: "[\"Drama\",\"Comedy\"]".
    if (info?.genres) {
      try {
        const parsed =
          typeof info.genres === "string" ? JSON.parse(info.genres) : info.genres;
        if (Array.isArray(parsed)) {
          return parsed.map((g) => String(g).trim()).filter(Boolean);
        }
      } catch {
        // Ignorar error de parseo
      }
    }

    // Fallback: por si alguna página sí serializa genres en el HTML.
    const mGenres = html.match(/genres[\\\"]*:\s*(\[[^\]]+\])/);
    if (mGenres) {
      try {
        const raw = mGenres[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          return list.map((g) => String(g).trim()).filter(Boolean);
        }
      } catch {
        // Ignorar error de parseo
      }
    }
    return [];
  }

  protected override listEpisodes(
    data: string | unknown,
    slug: string,
    _tmdb?: unknown,
    env?: Env
  ): SourceEpisode[] {
    const { html, info } = readMetaData(data);
    const episodes: SourceEpisode[] = [];

    // contentId: de la ficha API (si vino) o del payload de la página.
    const contentId = info?.id ? String(info.id) : extractContentId(html);

    // Refrescar la caché de la ficha completa, que es la que usa toEpSlug
    // para resolver el slug del fan-out sin otro request.
    if (contentId && info) {
      void cacheSet(
        `${CONTENT_CACHE_PREFIX}${contentId}`,
        info,
        CONTENT_CACHE_TTL,
        env?.STREAM_CACHE
      );
    }

    // Extraer array initialEpisodes
    const mEps = html.match(/initialEpisodes[\\\"]*:\s*\[(.*?)(?:\]\s*,\s*[\\\"]*downloadUrl|\]\s*,\s*\[)/);
    if (mEps && contentId) {
      const chunk = mEps[1];
      // Buscar objetos con id y number: { "id": "13209", "number": 1, ... }
      const epMatches = chunk.matchAll(/id[\\\"]*:\s*[\\\"]*(\d+)[\\\"]*,\s*[\\\"]*number[\\\"]*:\s*(\d+)/g);
      for (const m of epMatches) {
        const epId = m[1];
        const epNum = parseInt(m[2], 10) || 1;
        episodes.push({
          id: `kissasia:ep:${contentId}:${epId}:${epNum}`,
          slug: `${slug}-1x${epNum}`,
          s: 1,
          e: epNum,
        });
      }
    }

    // Si es una película o no hay episodios desglosados, pero tenemos contentId
    if (episodes.length === 0 && contentId) {
      episodes.push({
        id: `kissasia:ep:${contentId}`,
        slug: `${slug}-1x1`,
        s: 1,
        e: 1,
      });
    }

    return episodes;
  }

  // ── Fan-out de streams ──
  /** contentId → ficha completa de `/api/content?id=`, cacheada 24 h.
   *  Compatible con la caché anterior, que guardaba solo el slug (string). */
  private async contentInfo(
    contentId: string,
    env?: Env
  ): Promise<KissAsiaContentItem | null> {
    const kv = env?.STREAM_CACHE;
    const key = `${CONTENT_CACHE_PREFIX}${contentId}`;
    let legacySlug = "";

    if (kv) {
      const cached = await cacheGet(key, kv);
      if (cached && typeof cached === "object") {
        const info = cached as KissAsiaContentItem;
        if (typeof info.slug === "string" && info.slug) return info;
      } else if (typeof cached === "string" && cached) {
        legacySlug = cached;
      }
    }

    const fallback = (): KissAsiaContentItem | null =>
      legacySlug
        ? { id: Number(contentId), slug: legacySlug, title: "" }
        : null;

    if (!env) return fallback();

    try {
      const resText = await this.fetchBody(
        `${KISSASIA_BASE}/api/content?id=${encodeURIComponent(contentId)}`,
        env
      );
      if (!resText) return fallback();

      const data = JSON.parse(resText) as KissAsiaContentItem;
      if (!data || typeof data.slug !== "string" || !data.slug.trim()) {
        return fallback();
      }
      data.slug = data.slug.trim();
      if (!data.id) data.id = Number(contentId);
      if (typeof data.title !== "string") data.title = "";

      await cacheSet(key, data, CONTENT_CACHE_TTL, kv);
      return data;
    } catch (e) {
      console.log(`[kissasia] no se pudo resolver la ficha de ${contentId}: ${e}`);
      return fallback();
    }
  }

  private async contentSlug(contentId: string, env?: Env): Promise<string> {
    const info = await this.contentInfo(contentId, env);
    return info?.slug?.trim() || "";
  }

  /** id propio → epSlug canónico basado en el TÍTULO del sitio, no en el
   *  contentId: `between-steps-1x2` en vez de `kissasia-1758-1x2`. Así el
   *  fan-out puede buscar la serie en las demás fuentes vía slugmap. */
  override async toEpSlug(rawId: string, env?: Env): Promise<string> {
    const parts = rawId.split(":");
    // kissasia:ep:{contentId}:{episodeId}:{num} (serie) o kissasia:ep:{contentId} (película)
    if (parts.length >= 3 && parts[1] === "ep") {
      const contentId = parts[2];
      const epNum = parts[4] || "1";
      const slug = contentId ? await this.contentSlug(contentId, env) : "";
      // Fallback al formato antiguo si la API no responde: el fan-out no
      // encuentra el título, pero los streams de KissAsia siguen funcionando.
      return slug
        ? `${slug}-1x${epNum}`
        : `kissasia-${contentId}-1x${epNum}`;
    }
    return rawId.slice(this.prefix.length + 1);
  }

  // Dummy para clase abstracta
  protected override buildPageUrl(slug: string): string {
    return slug;
  }

  protected override extractEmbeds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // ── Streams ──
  override async getStreams(rawId: string, env: Env): Promise<{ streams: unknown[] }> {
    let epPart = "";
    if (rawId.startsWith("kissasia:ep:")) {
      epPart = rawId.slice("kissasia:ep:".length);
    } else {
      epPart = rawId.replace(/^kissasia:/, "");
    }

    if (!epPart) return { streams: [] };

    // Partes: {contentId}:{episodeId}:{epNum} o {contentId}
    const parts = epPart.split(":");
    const contentId = parts[0];
    const episodeId = parts[1]; // puede ser undefined si es película
    const epNum = parts[2] || "1";

    if (!contentId) return { streams: [] };

    const query = new URLSearchParams({ contentId });
    if (episodeId) {
      query.set("episodeId", episodeId);
    }

    const apiUrl = `${KISSASIA_BASE}/api/get-media?${query.toString()}`;
    let resText = "";
    try {
      resText = await this.fetchBody(apiUrl, env);
    } catch (e) {
      console.error(`[kissasia] error fetching get-media: ${e}`);
      return { streams: [] };
    }

    let mediaData: KissAsiaMediaResponse | null = null;
    try {
      mediaData = JSON.parse(resText);
    } catch (e) {
      console.error(`[kissasia] error parseando media JSON: ${e}`);
      return { streams: [] };
    }

    const videoUrl = mediaData?.videoUrl?.trim();
    if (!videoUrl) {
      return { streams: [] };
    }

    const { add, streams } = makeStreamDeduper();
    const denoBase = denoBaseFromEnv(env);

    // Mapear subtítulos
    const subTracks = (mediaData?.subtitles || [])
      .filter((s) => s.url && /^https?:\/\//i.test(s.url))
      .map((s, idx) => {
        const langCode = (s.language || "eng").toLowerCase().slice(0, 3);
        const label = s.label || s.language || "Subtitle";
        return {
          id: `kissasia-sub-${idx}-${langCode}`,
          url: s.url!,
          ext: (s.url!.toLowerCase().includes(".vtt") ? "vtt" : "srt") as "vtt" | "srt",
          lang: langCode,
          label,
        };
      });

    const isHls = /\.m3u8/i.test(videoUrl);
    if (isHls && denoBase) {
      add({
        url: `${denoBase}/hls?u=${encodeURIComponent(videoUrl)}&r=${encodeURIComponent(KISSASIA_BASE + "/")}`,
        name: "KissAsia HLS",
        title: "▶ KissAsia — HLS",
        behaviorHints: {
          notWebReady: false,
          filename: `kissasia-${contentId}-${epNum}.m3u8`,
          bingeGroup: `kissasia-hls-${contentId}`,
        },
        ...(subTracks.length ? { subtitles: subTracks } : {}),
      });
    } else if (isHls) {
      add({
        externalUrl: videoUrl,
        name: "KissAsia 🌐",
        title: "🌐 HLS — KissAsia",
      });
    } else {
      add({
        url: videoUrl,
        name: "KissAsia MP4",
        title: "▶ KissAsia — directo",
        behaviorHints: {
          notWebReady: false,
          filename: `kissasia-${contentId}-${epNum}.mp4`,
          bingeGroup: `kissasia-mp4-${contentId}`,
        },
        ...(subTracks.length ? { subtitles: subTracks } : {}),
      });
    }

    return { streams };
  }
}

export const kissAsiaSource = new KissAsiaSource();
