import { Env } from "../types";
import { kisskhKkeyFn } from "../vendor/kisskh/kisskhKey";
import { cleanTitle, fetchHtml } from "../utils";
import { addEmbedStreams } from "../extractors";
import { denoBaseFromEnv, makeStreamDeduper } from "../utils";
import { SourceBase, SourceCard, SourceEpisode } from "./sourceBase";

const KISSKH_BASE = "https://kisskh.co";
// Constantes del cliente oficial (fijas en el bundle de Angular):
// appVer / viGuid / platformVer / appName — el server no valida contra
// cookie ni sesión (probe: firma con guids fijos funciona).
const KISSKH_APP_VER = "2.8.10";
const KISSKH_GUID = "62f176f3bb1b5b8e70e39932ad34a0c7";
const KISSKH_SUB_GUID = "VgV52sWhwvBSf8BsM3BRY9weWiiCbtGp";
const KISSKH_PLATFORM_VER = 4830201;
const KISSKH_APP = "kisskh";

/** KissKH: API JSON propia (Angular firmado con kkey). Catálogo y meta van
 * por la base (hooks de fetch/parse); getStreams y su pipeline (subs, MP4
 * directo, HLS→relay /hls) es override completo — NO es el esqueleto HTML
 * universal. */
class KisskhSource extends SourceBase {
  get prefix() {
    return "kisskh";
  }
  get label() {
    return "KissKH";
  }

  // Episodio = "kisskh:ep:{id-numérico}" (listEpisodes). Los ids de catálogo
  // son "kisskh:{dramaId}" y no llevan el marcador "ep:".
  override isEpisodeId(rawId: string): boolean {
    return /^kisskh:ep:\d+$/.test(rawId);
  }

  // ── Fetch: toda la fuente narra el API con allowShort (respuestas cortas
  // válidas del JSON — el default de fetchHtml las trataría como fracaso). ──
  protected override async fetchBody(url: string, env: Env): Promise<string> {
    try {
      return await fetchHtml(url, env, { allowShort: true });
    } catch {
      return "";
    }
  }

  // ── Catálogo: buildSearchUrl/buildListUrl/parseCards encajan en el template ──
  protected buildSearchUrl(q: string): string {
    return `${KISSKH_BASE}/api/DramaList/Search?q=${encodeURIComponent(q)}`;
  }

  protected buildListUrl(page: number): string {
    return `${KISSKH_BASE}/api/DramaList/List?page=${page}&type=0&sub=0`;
  }

  // Sin género (el API no lo ofrece) → la rama de la base devuelve {metas: []}.
  protected parseCards(resText: string): SourceCard[] {
    try {
      const items = JSON.parse(resText);
      const list = Array.isArray(items) ? items : items?.data || [];
      const cards: SourceCard[] = [];
      for (const item of list) {
        const slug = String(item.id || item.dramaId || "");
        const title = item.title || item.name || "";
        if (!slug || slug === "undefined" || !title) continue;
        cards.push({
          slug,
          type: "series",
          name: cleanTitle(title) || title,
          poster: item.thumbnail || item.image || item.poster || "",
        });
      }
      return cards;
    } catch {
      // HTML fallback parsing (defensivo: por si el API vuelve a la SPA)
      const cards: SourceCard[] = [];
      for (const m of resText.matchAll(
        /<a[^>]+href=["']\/Drama\/([^"'\?\/]+)["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["'][^>]*alt=["']([^"']*)["']/gi
      )) {
        if (m[1] && m[3])
          cards.push({
            slug: m[1],
            type: "series",
            name: cleanTitle(m[3]) || m[3],
            poster: m[2],
          });
      }
      return cards;
    }
  }

  // ── Meta: JSON directo de /api/DramaList/Drama/{id} ──
  private sitePoster = "";

  protected override async fetchMetaPage(
    dramaId: string,
    env?: Env
  ): Promise<unknown> {
    const pageUrl = `${KISSKH_BASE}/api/DramaList/Drama/${dramaId}?isq=false`;
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
    this.sitePoster = d.thumbnail || d.image || "";
    return {
      name: cleanTitle(title) || `Drama ${dramaId}`,
      poster: this.sitePoster,
      description: d.description || d.summary || "",
    };
  }

  // Episodios del API: {id, number} (floor). Video id "kisskh:ep:{id}".
  protected override listEpisodes(data: unknown): SourceEpisode[] {
    const d = (data || {}) as any;
    const rawEps: any[] = d.episodes || d.episodesList || [];
    if (!Array.isArray(rawEps)) return [];
    return rawEps.map((ep) => ({
      id: `kisskh:ep:${ep.id}`,
      slug: `${ep.id}`,
      s: 1,
      e: Math.floor(parseFloat(ep.number || ep.ep || "1")),
      thumb: this.sitePoster,
    }));
  }

  // ── Streams (override completo — pipeline KISSKH, no el esqueleto HTML) ──
  protected buildPageUrl(slug: string): string {
    // No aplica: el flujo va por API firmado con kkey (fetchEpisodePage
    // tampoco se usa — getStreams sigue directamente).
    return slug;
  }

  protected extractEmbeds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  async getStreams(rawId: string, env: Env) {
    let epId = "";
    if (rawId.startsWith("kisskh:ep:")) {
      epId = rawId.slice("kisskh:ep:".length);
    } else {
      epId = rawId.replace(/^kisskh:/, "");
    }

    if (!epId) return { streams: [] };

    // (2026) /api/Episode/<id> fue retirada del sitio (responde la SPA HTML).
    // Endpoint firmado: /api/DramaList/Episode/<epId>.png con kkey calculado
    // por common.js (copiado literal en src/vendor/kisskh/kisskhKey.js). Respuesta:
    // { Video: mp4/hls directo, Video_tmp, ThirdParty: embed, Type: 0=mp4, 1=hls }.
    let kkey = "";
    try {
      kkey = kisskhKkeyFn(
        Number(epId),
        null,
        KISSKH_APP_VER,
        KISSKH_GUID,
        KISSKH_PLATFORM_VER,
        KISSKH_APP, KISSKH_APP, KISSKH_APP, KISSKH_APP, KISSKH_APP, KISSKH_APP
      );
    } catch (e) {
      console.error(`[kisskh] kkey falló para ep ${epId}: ${e}`);
      return { streams: [] };
    }

    const apiUrl = `${KISSKH_BASE}/api/DramaList/Episode/${epId}.png?err=false&ts=null&time=null&kkey=${kkey}`;
    let resText = "";
    try {
      resText = await this.fetchBody(apiUrl, env);
    } catch (e) {
      console.error(`[kisskh] streams falló para ${apiUrl}: ${e}`);
      resText = "";
    }

    // El CDN del mp4 no valida los params ip/verify (probe: 206 con query
    // vacía o basura) → el Video directo se sirve sin proxy; el verify se
    // hornea para la IP del que pide el JSON, igual funciona desde otra IP.
    const directMp4 = new Set<string>();
    const embedUrls = new Set<string>();

    if (resText) {
      try {
        const data = JSON.parse(resText);
        if (typeof data.Video === "string" && /^https?:\/\//.test(data.Video))
          directMp4.add(data.Video);
        if (
          typeof data.Video_tmp === "string" &&
          /^https?:\/\//.test(data.Video_tmp)
        )
          directMp4.add(data.Video_tmp);
        if (
          typeof data.ThirdParty === "string" &&
          /^https?:\/\//.test(data.ThirdParty)
        )
          embedUrls.add(data.ThirdParty);
        // Forma local (por si el sitio vuelve a server descriptor arrays).
        if (Array.isArray(data.videos)) {
          for (const v of data.videos) {
            const u = v?.url || v?.src;
            if (typeof u === "string" && /^https?:\/\//.test(u)) {
              if (/\.(m3u8|mp4)/.test(u)) directMp4.add(u);
              else embedUrls.add(u);
            }
          }
        }
      } catch {
        for (const m of resText.matchAll(
          /(https?:\/\/[^"'\s\\]+\.(?:m3u8|mp4)[^"'\s\\]*)/gi
        )) {
          directMp4.add(m[1]);
        }
      }
    }

    if (directMp4.size === 0 && embedUrls.size === 0) return { streams: [] };

    const denoBase = denoBaseFromEnv(env);
    const { add, streams } = makeStreamDeduper();

    // Subtítulos: /api/Sub/<epId>?kkey=<firma con subGuid> → [{src, label,
    // land, default}] con .srt directos. Prioridad es → en (default) → resto.
    let subTracks: {
      id: string;
      url: string;
      ext: "srt";
      lang: string;
      label: string;
    }[] = [];
    try {
      const subKey = kisskhKkeyFn(
        Number(epId),
        null,
        KISSKH_APP_VER,
        KISSKH_SUB_GUID,
        KISSKH_PLATFORM_VER,
        KISSKH_APP, KISSKH_APP, KISSKH_APP, KISSKH_APP, KISSKH_APP, KISSKH_APP
      );
      const subText = await this.fetchBody(
        `${KISSKH_BASE}/api/Sub/${epId}?kkey=${subKey}`,
        env
      );
      const raw: any[] = JSON.parse(subText);
      if (Array.isArray(raw)) {
        const prio = (land: string) =>
          land === "es" ? 0 : land === "en" ? 1 : 2;
        subTracks = raw
          .filter((s) => typeof s?.src === "string" && /^https?:\/\//.test(s.src))
          .sort((a, b) => prio(a.land || "zz") - prio(b.land || "zz"))
          .slice(0, 4)
          .map((s) => ({
            id: `kisskh-sub-${s.land || s.label}`,
            url: s.src,
            ext: "srt" as const,
            lang: s.land || "xx",
            label: String(s.label || s.land || "sub"),
          }));
      }
    } catch (e) {
      console.error(`[kisskh] subs falló para ep ${epId}: ${e}`);
    }

    for (const url of directMp4) {
      const isHls = /\.m3u8/i.test(url);
      if (isHls && denoBase) {
        // HLS: Stremio exige CORS → relay /hls del Deno.
        add({
          url: `${denoBase}/hls?u=${encodeURIComponent(url)}&r=${encodeURIComponent(
            "https://kisskh.co/"
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
          externalUrl: url,
          name: "KissKH 🌐",
          title: "🌐 HLS — KissKH",
        });
      } else {
        add({
          url,
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

    for (const embed of embedUrls) {
      await addEmbedStreams({
        embed,
        epSlug: epId,
        label: "KissKH",
        prefix: "kisskh",
        denoBase,
        add,
        env,
      });
    }

    return { streams };
  }
}

export const kisskhSource = new KisskhSource();
