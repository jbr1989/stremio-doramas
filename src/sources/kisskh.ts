import { Env } from "../lib/types";
import { cleanTitle, fetchHtml } from "../lib/utils";
import { denoBaseFromEnv, makeStreamDeduper } from "../lib/utils";
import { SourceBase, SourceCard, SourceEpisode } from "../lib/sourceBase";

const KISSKH_BASE = "https://kisskh.club";

/** KissKH: API JSON propia (Next.js en https://kisskh.club).
 * Catálogo y meta usan la base (hooks de fetch/parse); getStreams y su
 * pipeline (tracks VTT, MP4 directo con relay /mp4 referer o HLS)
 * sobreescriben getStreams. */
class KisskhSource extends SourceBase {
  readonly prefix = "kisskh";
  readonly label = "KissKH";
  readonly catalogId = "kisskh";

  // Episodio = "kisskh:{dramaId}:ep:{episodeId}".
  // Los ids de catálogo son "kisskh:{dramaId}" (id numérico o slug).
  readonly epIdPattern = "(?:[^:]+:ep:[^:]+|ep:\\d+)";

  // ── Fetch: allowShort para respuestas JSON cortas válidas ──
  protected override async fetchBody(url: string, env: Env): Promise<string> {
    try {
      return await fetchHtml(url, env, { allowShort: true });
    } catch {
      return "";
    }
  }

  // ── Catálogo ──
  protected buildSearchUrl(q: string): string {
    return `${KISSKH_BASE}/api/frontend/drama?q=${encodeURIComponent(q)}`;
  }

  protected buildListUrl(page: number): string {
    const limit = 24;
    const offset = Math.max(0, (page - 1) * limit);
    return `${KISSKH_BASE}/api/frontend/drama?offset=${offset}&limit=${limit}&feature=updated`;
  }

  protected parseCards(resText: string): SourceCard[] {
    try {
      const data = JSON.parse(resText);
      const list = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data)
        ? data
        : data?.data?.show || [];
      const cards: SourceCard[] = [];
      for (const item of list) {
        const slug = String(item.id || item.slug || "");
        const title = item.title || item.name || "";
        if (!slug || slug === "undefined" || !title) continue;
        cards.push({
          slug,
          type: item.type === 2 ? "movie" : "series",
          name: cleanTitle(title) || title,
          poster: item.thumbnail || item.poster || item.image || "",
        });
      }
      return cards;
    } catch {
      return [];
    }
  }

  // ── Meta: JSON directo de /api/frontend/content/{dramaId} ──
  private sitePoster = "";
  private currentDramaId = "";

  protected override async fetchMetaPage(
    dramaId: string,
    env?: Env
  ): Promise<unknown> {
    const pageUrl = `${KISSKH_BASE}/api/frontend/content/${encodeURIComponent(dramaId)}`;
    let resText = "";
    try {
      resText = await this.fetchBody(pageUrl, env!);
    } catch (e) {
      console.error(`[kisskh] meta falló para ${pageUrl}: ${e}`);
      return "";
    }
    try {
      return JSON.parse(resText || "null") ?? "";
    } catch {
      return "";
    }
  }

  protected override parseMetaBasics(data: unknown, dramaId: string) {
    const d = (data || {}) as any;
    const title = d.title || d.name || "";
    this.sitePoster = d.thumbnail || d.image || d.poster || "";
    this.currentDramaId = String(d.id || dramaId);
    return {
      name: cleanTitle(title) || `Drama ${dramaId}`,
      poster: this.sitePoster,
      description: d.description || d.summary || "",
    };
  }

  // Episodios del API: {id, number, title, isPlayable, ...}
  // Video id "kisskh:{dramaId}:ep:{episodeId}".
  protected override listEpisodes(data: unknown): SourceEpisode[] {
    const d = (data || {}) as any;
    const rawEps: any[] = d.episodes || [];
    if (!Array.isArray(rawEps)) return [];
    const dramaId = this.currentDramaId || String(d.id || "");
    return rawEps
      .filter((ep) => ep.isPlayable !== false)
      .map((ep) => ({
        id: `kisskh:${dramaId}:ep:${ep.id}`,
        slug: `${dramaId}:ep:${ep.id}`,
        s: 1,
        e: Math.floor(parseFloat(ep.number || ep.ep || "1")),
        thumb: this.sitePoster,
      }));
  }

  // ── Streams ──
  protected buildPageUrl(slug: string): string {
    return slug;
  }

  protected extractEmbeds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  async getStreams(rawId: string, env: Env) {
    let dramaId = "";
    let epId = "";

    if (rawId.startsWith("kisskh:")) {
      const rest = rawId.slice("kisskh:".length);
      if (rest.includes(":ep:")) {
        const parts = rest.split(":ep:");
        dramaId = parts[0];
        epId = parts[1];
      } else if (rest.startsWith("ep:")) {
        epId = rest.slice(3);
      } else {
        epId = rest;
      }
    } else {
      epId = rawId;
    }

    if (!epId) return { streams: [] };

    // Si no tenemos dramaId pero sí epId, podemos consultar el episodio directamente si dramaId = epId,
    // o intentar /api/frontend/content/{dramaId}/episodes/{epId}.
    const contentKey = dramaId || epId;
    const apiUrl = `${KISSKH_BASE}/api/frontend/content/${encodeURIComponent(contentKey)}/episodes/${encodeURIComponent(epId)}`;
    let resText = "";
    try {
      resText = await this.fetchBody(apiUrl, env);
    } catch (e) {
      console.error(`[kisskh] streams falló para ${apiUrl}: ${e}`);
      resText = "";
    }

    let episodeData: any = null;
    if (resText) {
      try {
        const parsed = JSON.parse(resText);
        if (parsed.status === "ok" && parsed.episode) {
          episodeData = parsed.episode;
        }
      } catch (e) {
        console.error(`[kisskh] parse error for ${apiUrl}: ${e}`);
      }
    }

    if (!episodeData?.video_url) {
      return { streams: [] };
    }

    const videoUrl = episodeData.video_url;
    const denoBase = denoBaseFromEnv(env);
    const { add, streams } = makeStreamDeduper();

    // Subtítulos
    const subTracks: {
      id: string;
      url: string;
      ext: "vtt";
      lang: string;
      label: string;
    }[] = [];

    const tracks: any[] = Array.isArray(episodeData.tracks) ? episodeData.tracks : [];
    const prio = (lang: string) => {
      const l = (lang || "").toLowerCase();
      if (l === "es" || l === "spanish") return 0;
      if (l === "en" || l === "english") return 1;
      return 2;
    };

    tracks
      .filter((t) => typeof t?.file === "string" && /^https?:\/\//.test(t.file))
      .sort((a, b) => prio(a.srclang) - prio(b.srclang))
      .forEach((t) => {
        subTracks.push({
          id: `kisskh-sub-${t.srclang || t.label}`,
          url: t.file,
          ext: "vtt" as const,
          lang: t.srclang || "xx",
          label: String(t.label || t.srclang || "sub"),
        });
      });

    const isHls = /\.m3u8/i.test(videoUrl);
    if (isHls && denoBase) {
      add({
        url: `${denoBase}/hls?u=${encodeURIComponent(videoUrl)}&r=${encodeURIComponent(
          "https://kisskh.club/"
        )}`,
        name: "KissKH HLS",
        title: "▶ KissKH — HLS",
        behaviorHints: {
          notWebReady: false,
          filename: `${epId}.m3u8`,
          bingeGroup: "kisskh-hls",
        },
        ...(subTracks.length ? { subtitles: subTracks } : {}),
      });
    } else if (isHls) {
      add({
        externalUrl: videoUrl,
        name: "KissKH 🌐",
        title: "🌐 HLS — KissKH",
      });
    } else {
      // Para MP4 (como hlscdn.vip que exige Referer kisskh.club para no devolver 403)
      if (denoBase) {
        add({
          url: `${denoBase}/mp4?url=${encodeURIComponent(videoUrl)}&r=${encodeURIComponent(
            "https://kisskh.club/"
          )}`,
          name: "KissKH MP4",
          title: "▶ KissKH — directo",
          behaviorHints: {
            notWebReady: false,
            filename: `${epId}.mp4`,
            bingeGroup: "kisskh-mp4",
          },
          ...(subTracks.length ? { subtitles: subTracks } : {}),
        });
      } else {
        add({
          url: videoUrl,
          name: "KissKH MP4",
          title: "▶ KissKH — directo",
          behaviorHints: {
            notWebReady: false,
            filename: `${epId}.mp4`,
            bingeGroup: "kisskh-mp4",
          },
          ...(subTracks.length ? { subtitles: subTracks } : {}),
        });
      }
    }

    return { streams };
  }
}

export const kisskhSource = new KisskhSource();
