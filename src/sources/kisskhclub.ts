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

export const KISSKHCLUB_BASE = "https://kisskh.club";

const CONTENT_CACHE_PREFIX = "kc:content:";
const SLUG_CACHE_PREFIX = "kc:slug:";
const CONTENT_CACHE_TTL = 24 * 3600; // 24 h

export interface KisskhClubDramaItem {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  thumbnail?: string | null;
  type?: number;
  country?: number;
  content_status?: string;
  release_year?: number | null;
  episode?: number | null;
  latestEpisode?: number | null;
  totalEpisode?: number | null;
  episodeCount?: number | null;
  badge?: string;
  api_url?: string;
  sub?: number;
}

export interface KisskhClubListResponse {
  status?: string;
  offset?: number;
  limit?: number;
  count?: number;
  total?: number;
  hasMore?: boolean;
  items?: KisskhClubDramaItem[];
}

export interface KisskhClubEpisodeItem {
  id: string;
  number: number;
  title?: string;
  is_locked?: boolean;
  state?: string;
  isPlayable?: boolean;
  isUpcoming?: boolean;
  badge?: string;
  duration_seconds?: number | null;
  sub?: number;
  deliveryDeferred?: boolean;
}

export interface KisskhClubContentDetail {
  status?: string;
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  thumbnail?: string | null;
  type?: number; // 1 = series, 2 = movie
  country?: number;
  content_status?: string;
  release_year?: number | null;
  releaseDate?: string | null;
  updatedDate?: string | null;
  episode?: number | null;
  latestEpisode?: number | null;
  totalEpisode?: number | null;
  episodeCount?: number | null;
  badge?: string;
  api_url?: string;
  sub?: number;
  episodes?: KisskhClubEpisodeItem[];
}

export interface KisskhClubTrack {
  file: string;
  kind?: string;
  label?: string;
  srclang?: string;
  default?: boolean;
}

export interface KisskhClubEpisodePlayback {
  status?: string;
  episode?: {
    id: string;
    number: number;
    title?: string;
    video_url?: string;
    host?: string;
    is_locked?: boolean;
    state?: string;
    isPlayable?: boolean;
    main_sub_url?: string;
    sub?: number;
    tracks?: KisskhClubTrack[];
  };
}

/**
 * KissKH.club (kisskh.club) - Fuente independiente de doramas basada en Next.js.
 * - Catálogo: GET /api/frontend/drama?offset={offset}&limit={limit} (&q={search})
 * - Meta: GET /api/frontend/content/{idOrSlug}
 * - Streams: GET /api/frontend/content/{contentId}/episodes/{episodeId}
 */
export class KisskhClubSource extends SourceBase {
  readonly prefix = "kclub";
  readonly label = "KissKH.club";
  readonly catalogId = "kisskhclub";

  // Episodio = "kclub:ep:{contentId}:{episodeId}:{number}" o slug canónico "kclub:{slug}-SxE"
  protected override readonly epIdPattern =
    "ep:[^:]+(?::[^:]+)*|.+?-\\d+x\\d+";

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
    return `${KISSKHCLUB_BASE}/api/frontend/drama?offset=0&limit=${this.pageSize}&q=${encodeURIComponent(q)}`;
  }

  protected override buildListUrl(page: number): string {
    const offset = Math.max(0, (page - 1) * this.pageSize);
    return `${KISSKHCLUB_BASE}/api/frontend/drama?offset=${offset}&limit=${this.pageSize}`;
  }

  protected override parseCards(resText: string): SourceCard[] {
    try {
      const data: KisskhClubListResponse = JSON.parse(resText);
      const items = Array.isArray(data.items) ? data.items : [];
      const cards: SourceCard[] = [];

      for (const item of items) {
        const slug = item.slug || item.id;
        if (!slug) continue;
        const rawTitle = item.title || slug;
        const poster = item.thumbnail || "";
        const type: "series" | "movie" = item.type === 2 ? "movie" : "series";

        cards.push({
          slug,
          name: cleanTitle(rawTitle) || rawTitle,
          poster,
          type,
        });
      }

      return cards;
    } catch (e) {
      console.error(`[kisskhclub] Error parseando cards de catálogo: ${e}`);
      return [];
    }
  }

  // ── Meta ──
  protected override async fetchMetaPage(
    slug: string,
    env?: Env
  ): Promise<KisskhClubContentDetail | null> {
    if (!env) return null;
    const url = `${KISSKHCLUB_BASE}/api/frontend/content/${encodeURIComponent(slug)}`;
    const resText = await this.fetchBody(url, env);
    if (!resText) return null;

    try {
      const data = JSON.parse(resText) as KisskhClubContentDetail;
      if (data && data.status === "ok" && data.id) {
        // Cachear contentId <-> slug
        const kv = env.STREAM_CACHE;
        if (kv) {
          void cacheSet(`${CONTENT_CACHE_PREFIX}${data.id}`, data, CONTENT_CACHE_TTL, kv);
          if (data.slug) {
            void cacheSet(`${SLUG_CACHE_PREFIX}${data.slug}`, data.id, CONTENT_CACHE_TTL, kv);
          }
        }
        return data;
      }
      return null;
    } catch (e) {
      console.error(`[kisskhclub] error parseando meta para ${slug}: ${e}`);
      return null;
    }
  }

  protected override parseMetaBasics(data: unknown, slug: string) {
    const d = (data || {}) as KisskhClubContentDetail;
    const rawTitle = d.title || slug;
    const year = d.release_year ? String(d.release_year) : undefined;

    return {
      name: cleanTitle(rawTitle) || rawTitle,
      poster: d.thumbnail || "",
      description: d.description || "",
      year,
    };
  }

  protected override listEpisodes(
    data: unknown,
    slug: string,
    _tmdb?: unknown,
    _env?: Env
  ): SourceEpisode[] {
    const d = (data || {}) as KisskhClubContentDetail;
    const contentId = d.id;
    const episodes: SourceEpisode[] = [];

    const rawEps = Array.isArray(d.episodes) ? d.episodes : [];
    for (const ep of rawEps) {
      if (!ep.id) continue;
      const num = ep.number || 1;
      episodes.push({
        id: `kclub:ep:${contentId}:${ep.id}:${num}`,
        slug: `${slug}-1x${num}`,
        s: 1,
        e: num,
      });
    }

    if (episodes.length === 0 && contentId) {
      episodes.push({
        id: `kclub:ep:${contentId}:${contentId}:1`,
        slug: `${slug}-1x1`,
        s: 1,
        e: 1,
      });
    }

    return episodes;
  }

  // ── Fan-out de streams ──
  private async contentDetail(
    idOrSlug: string,
    env?: Env
  ): Promise<KisskhClubContentDetail | null> {
    const kv = env?.STREAM_CACHE;
    const key = `${CONTENT_CACHE_PREFIX}${idOrSlug}`;
    if (kv) {
      const cached = await cacheGet(key, kv);
      if (cached && typeof cached === "object") {
        return cached as KisskhClubContentDetail;
      }
    }

    return this.fetchMetaPage(idOrSlug, env);
  }

  private async contentIdBySlug(slug: string, env?: Env): Promise<string> {
    const s = slug.trim();
    if (!s) return "";
    const kv = env?.STREAM_CACHE;
    const key = `${SLUG_CACHE_PREFIX}${s}`;
    if (kv) {
      const cached = await cacheGet(key, kv);
      if (typeof cached === "string" && cached) return cached;
    }

    const detail = await this.contentDetail(s, env);
    if (detail?.id) {
      if (kv) void cacheSet(key, detail.id, CONTENT_CACHE_TTL, kv);
      return detail.id;
    }

    return "";
  }

  override async toEpSlug(rawId: string, env?: Env): Promise<string> {
    const parts = rawId.split(":");
    // kclub:ep:{contentId}:{episodeId}:{num}
    if (parts.length >= 5 && parts[1] === "ep") {
      const contentId = parts[2];
      const epNum = parts[4];
      const detail = await this.contentDetail(contentId, env);
      const slug = detail?.slug || `kisskhclub-${contentId}`;
      return `${slug}-1x${epNum}`;
    }
    return rawId.slice(this.prefix.length + 1);
  }

  protected override buildPageUrl(slug: string): string {
    return slug;
  }

  protected override extractEmbeds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // ── Streams ──
  override async getStreams(rawId: string, env: Env): Promise<{ streams: unknown[] }> {
    let contentId = "";
    let episodeId = "";
    let epNum = "1";

    if (rawId.startsWith("kclub:ep:")) {
      const epPart = rawId.slice("kclub:ep:".length);
      const parts = epPart.split(":");
      contentId = parts[0];
      episodeId = parts[1] || parts[0];
      epNum = parts[2] || "1";
    } else {
      // Formato "kclub:{slug}-SxE" del fan-out
      const epSlug = rawId.replace(/^kclub:/, "");
      const m = epSlug.match(/^(.+)-(\d+)x(\d+)$/);
      if (!m) return { streams: [] };

      const [, slug, , numStr] = m;
      const num = Number(numStr) || 1;

      contentId = await this.contentIdBySlug(slug, env);
      if (!contentId) return { streams: [] };

      const detail = await this.contentDetail(contentId, env);
      const ep = (detail?.episodes || []).find((e) => e.number === num);
      if (ep) {
        episodeId = ep.id;
      } else if (num === 1) {
        episodeId = contentId;
      } else {
        return { streams: [] };
      }
      epNum = String(num);
    }

    if (!contentId || !episodeId) return { streams: [] };

    const apiUrl = `${KISSKHCLUB_BASE}/api/frontend/content/${encodeURIComponent(
      contentId
    )}/episodes/${encodeURIComponent(episodeId)}`;

    let resText = "";
    try {
      resText = await this.fetchBody(apiUrl, env);
    } catch (e) {
      console.error(`[kisskhclub] error fetching episode ${apiUrl}: ${e}`);
      return { streams: [] };
    }

    if (!resText) return { streams: [] };

    let playData: KisskhClubEpisodePlayback | null = null;
    try {
      playData = JSON.parse(resText);
    } catch (e) {
      console.error(`[kisskhclub] error parseando playback JSON: ${e}`);
      return { streams: [] };
    }

    const videoUrl = playData?.episode?.video_url?.trim();
    if (!videoUrl) return { streams: [] };

    const { add, streams } = makeStreamDeduper();
    const denoBase = denoBaseFromEnv(env);

    // Subtítulos
    const rawTracks = playData?.episode?.tracks || [];
    const subTracks = rawTracks
      .filter((t) => t.file && /^https?:\/\//i.test(t.file))
      .map((t, idx) => {
        const langCode = (t.srclang || "en").toLowerCase().slice(0, 3);
        const isSpanish = langCode === "es" || /spanish|español/i.test(t.label || "");
        const label = t.label || (isSpanish ? "Español" : t.srclang || "Subtitle");
        return {
          id: `kclub-sub-${idx}-${langCode}`,
          url: t.file,
          ext: "vtt" as const,
          lang: isSpanish ? "es" : langCode,
          label,
        };
      });

    // Fallback: si no hay tracks pero sí main_sub_url
    if (subTracks.length === 0 && playData?.episode?.main_sub_url) {
      const mainUrl = playData.episode.main_sub_url;
      if (/^https?:\/\//i.test(mainUrl)) {
        subTracks.push({
          id: "kclub-sub-main-en",
          url: mainUrl,
          ext: "vtt" as const,
          lang: "en",
          label: "English",
        });
      }
    }

    // Priorizar español luego inglés
    subTracks.sort((a, b) => {
      const prio = (l: string) => (l === "es" ? 0 : l === "en" ? 1 : 2);
      return prio(a.lang) - prio(b.lang);
    });

    const isHls = /\.m3u8/i.test(videoUrl);
    const isHlsCdn = /hlscdn\.vip/i.test(videoUrl);

    if (isHls && denoBase) {
      add({
        url: `${denoBase}/hls?u=${encodeURIComponent(videoUrl)}&r=${encodeURIComponent(
          `${KISSKHCLUB_BASE}/`
        )}`,
        name: "KissKH.club HLS",
        title: "▶ KissKH.club — HLS",
        behaviorHints: {
          notWebReady: false,
          filename: `kisskhclub-${contentId}-${epNum}.m3u8`,
          bingeGroup: `kclub-hls-${contentId}`,
        },
        ...(subTracks.length ? { subtitles: subTracks } : {}),
      });
    } else if (isHls) {
      add({
        externalUrl: videoUrl,
        name: "KissKH.club 🌐",
        title: "🌐 HLS — KissKH.club",
      });
    } else if (isHlsCdn && denoBase) {
      // hlscdn.vip exige Referer: https://kisskh.club/
      add({
        url: `${denoBase}/mp4?url=${encodeURIComponent(videoUrl)}&r=${encodeURIComponent(
          `${KISSKHCLUB_BASE}/`
        )}`,
        name: "KissKH.club MP4",
        title: "▶ KissKH.club — directo",
        behaviorHints: {
          notWebReady: false,
          filename: `kisskhclub-${contentId}-${epNum}.mp4`,
          bingeGroup: `kclub-mp4-${contentId}`,
        },
        ...(subTracks.length ? { subtitles: subTracks } : {}),
      });
    } else {
      add({
        url: videoUrl,
        name: "KissKH.club MP4",
        title: "▶ KissKH.club — directo",
        behaviorHints: {
          notWebReady: false,
          filename: `kisskhclub-${contentId}-${epNum}.mp4`,
          bingeGroup: `kclub-mp4-${contentId}`,
        },
        ...(subTracks.length ? { subtitles: subTracks } : {}),
      });
    }

    return { streams };
  }
}

export const kisskhClubSource = new KisskhClubSource();
