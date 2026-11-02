import { Env } from "../lib/types";
import { cleanTitle, fetchHtml, denoBaseFromEnv, makeStreamDeduper } from "../lib/utils";
import { SourceBase, SourceCard, SourceEpisode } from "../lib/sourceBase";

const KISSASIA_BASE = "https://kissasia.cam";
const TMDB_IMAGE_PREFIX = "https://image.tmdb.org/t/p/w500";

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

/**
 * KissAsia (kissasia.cam) - Fuente de doramas en Next.js con API pública.
 * - Catálogo: GET /api/content?limit=24&page={page} (&q={search}, &genre={genre})
 * - Meta: GET /drama/{slug} (extrae contentId y episodios iniciales)
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

  protected override buildSearchUrl(q: string): string {
    return `${KISSASIA_BASE}/api/content?q=${encodeURIComponent(q)}&limit=${this.pageSize}`;
  }

  protected override buildGenreUrl(gslug: string, page: number): string {
    return `${KISSASIA_BASE}/api/content?genre=${encodeURIComponent(gslug)}&limit=${this.pageSize}&page=${page}`;
  }

  protected override buildListUrl(page: number): string {
    return `${KISSASIA_BASE}/api/content?limit=${this.pageSize}&page=${page}`;
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

  protected override parseMetaBasics(data: string | unknown, slug: string) {
    const html = typeof data === "string" ? data : "";
    let name = "";
    let poster = "";
    let description = "";

    // 1. Extraer del JSON Next.js o atributos
    const mTitle = html.match(/title[\\\"]*:\s*[\\\"]*([^\\\"}]+)/);
    if (mTitle) {
      name = cleanTitle(mTitle[1].trim());
    }
    const mPoster = html.match(/poster(?:ImageUrl|Path)[\\\"]*:\s*[\\\"]*([^\\\",}]+)/);
    if (mPoster) {
      const p = mPoster[1].trim();
      poster = p.startsWith("http") ? p : `${TMDB_IMAGE_PREFIX}${p.startsWith("/") ? p : `/${p}`}`;
    }
    const mOverview = html.match(/overview[\\\"]*:\s*[\\\"]*([^\\\"}]+)/);
    if (mOverview) {
      description = mOverview[1].trim();
    }

    // 2. Fallbacks de metaetiquetas OpenGraph
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
    };
  }

  protected override parseGenres(data: string | unknown): string[] {
    const html = typeof data === "string" ? data : "";
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

  protected override listEpisodes(data: string | unknown, slug: string): SourceEpisode[] {
    const html = typeof data === "string" ? data : "";
    const episodes: SourceEpisode[] = [];

    // Extraer contentId del HTML
    const mCid = html.match(/contentId[\\\"]*:\s*[\\\"]*(\d+)/);
    const contentId = mCid ? mCid[1] : "";

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
  override async toEpSlug(rawId: string, _env?: Env): Promise<string> {
    const parts = rawId.split(":");
    // kissasia:ep:{contentId}:{episodeId}:{num} -> episodio num
    if (parts.length >= 5 && parts[1] === "ep") {
      const epNum = parts[4];
      return `kissasia-${parts[2]}-1x${epNum}`;
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
