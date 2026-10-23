import { Env } from "../types";
import { genreSlug } from "../genres";
import { kisskhKkeyFn } from "../kisskhKey";
import {
  cleanTitle,
  decodeEntities,
  denoBaseFromEnv,
  fetchHtml,
  fetchTmdb,
  makeStreamDeduper,
  toMetaPreview,
} from "../utils";
import { addEmbedStreams } from "../extractors";

const KISSKH_BASE = "https://kisskh.co";
// Constantes del cliente oficial (fijas en el bundle de Angular):
// appVer / viGuid / platformVer / appName — el server no valida contra
// cookie ni sesión (probe: firma con guids fijos funciona).
const KISSKH_APP_VER = "2.8.10";
const KISSKH_GUID = "62f176f3bb1b5b8e70e39932ad34a0c7";
const KISSKH_PLATFORM_VER = 4830201;
const KISSKH_APP = "kisskh";

export function canonicalKisskhSlug(slug: string): string {
  if (/-\d+x\d+$/.test(slug)) return slug;
  const m = slug.match(/^(.*?)-episode-(\d+)$/i) || slug.match(/^(.*?)-ep-(\d+)$/i);
  if (m) return `${m[1]}-1x${parseInt(m[2], 10)}`;
  return slug;
}

export async function getKisskhCatalog(
  extra: Record<string, string>,
  env?: Env
) {
  const q = (extra.search || "").trim();
  let url = "";

  if (q) {
    url = `${KISSKH_BASE}/api/DramaList/Search?q=${encodeURIComponent(q)}`;
  } else {
    const page = Math.floor(parseInt(extra.skip || "0", 10) / 24) + 1;
    url = `${KISSKH_BASE}/api/DramaList/List?page=${page}&type=0&sub=0`;
  }

  let resText = "";
  try {
    resText = await fetchHtml(url, env, { allowShort: true });
  } catch (e) {
    console.error(`[kisskh] catalog falló para ${url}: ${e}`);
    resText = "";
  }

  if (!resText) return { metas: [] };

  try {
    const items = JSON.parse(resText);
    const list = Array.isArray(items) ? items : items?.data || [];
    const metas = list
      .map((item: any) => {
        const id = item.id || item.dramaId;
        const title = item.title || item.name || "";
        const poster = item.thumbnail || item.image || item.poster || "";
        return {
          id: `kisskh:${id}`,
          name: cleanTitle(title) || title,
          poster,
        };
      })
      .filter((m: any) => m.id !== "kisskh:undefined" && m.name);

    return { metas: metas.map(toMetaPreview) };
  } catch {
    // HTML fallback parsing
    const metas: any[] = [];
    for (const m of resText.matchAll(
      /<a[^>]+href=["']\/Drama\/([^"'\?\/]+)["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["'][^>]*alt=["']([^"']*)["']/gi
    )) {
      metas.push({
        id: `kisskh:${m[1]}`,
        name: cleanTitle(m[3]) || m[3],
        poster: m[2],
      });
    }
    return { metas: metas.map(toMetaPreview) };
  }
}

export async function getKisskhMeta(
  id: string,
  tmdbKey: string,
  env?: Env
) {
  const dramaId = id.replace(/^kisskh:/, "").split(":")[0];
  const pageUrl = `${KISSKH_BASE}/api/DramaList/Drama/${dramaId}?isq=false`;

  let resText = "";
  try {
    resText = await fetchHtml(pageUrl, env, { allowShort: true });
  } catch (e) {
    console.error(`[kisskh] meta falló para ${pageUrl}: ${e}`);
    resText = "";
  }

  let title = "";
  let poster = "";
  let description = "";
  let episodes: { id: number | string; number: number }[] = [];

  if (resText) {
    try {
      const data = JSON.parse(resText);
      title = data.title || data.name || "";
      poster = data.thumbnail || data.image || "";
      description = data.description || data.summary || "";
      const rawEps = data.episodes || data.episodesList || [];
      if (Array.isArray(rawEps)) {
        episodes = rawEps.map((ep: any) => ({
          id: ep.id,
          number: Math.floor(parseFloat(ep.number || ep.ep || "1")),
        }));
      }
    } catch {
      // JSON parse failed
    }
  }

  const name = cleanTitle(title) || `Drama ${dramaId}`;
  const tmdb = await fetchTmdb(name, tmdbKey);

  const videos = episodes.map((ep) => ({
    id: `kisskh:ep:${ep.id}`,
    title: `T1 · Episodio ${ep.number}`,
    season: 1,
    episode: ep.number,
    thumbnail: poster,
  }));

  return {
    meta: {
      id,
      type: "series",
      name,
      poster: tmdb?.poster || poster,
      background: tmdb?.background || poster,
      description: tmdb?.description || description,
      posterShape: "poster",
      releaseInfo: tmdb?.year || "",
      genres: [],
      videos,
    },
  };
}

export async function getKisskhStreams(rawId: string, env: Env) {
  let epId = "";
  if (rawId.startsWith("kisskh:ep:")) {
    epId = rawId.slice("kisskh:ep:".length);
  } else {
    epId = rawId.replace(/^kisskh:/, "");
  }

  if (!epId) return { streams: [] };

  // (2026) /api/Episode/<id> fue retirada del sitio (responde la SPA HTML).
  // Nuevo endpoint, firmado: /api/DramaList/Episode/<epId>.png con kkey
  // calculado por common.js (copiado literal en kisskhKey.js). Respuesta:
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
    resText = await fetchHtml(apiUrl, env, { allowShort: true });
  } catch (e) {
    console.error(`[kisskh] streams falló para ${apiUrl}: ${e}`);
    resText = "";
  }

  // El CDN del mp4 no valida los params ip/verify (probe: 206 con query vacía
  // o basura) → el Video directo se sirve sin proxy; el verify se hornea para
  // la IP del que pide el JSON, igual funciona desde otra IP.
  const directMp4 = new Set<string>();
  const embedUrls = new Set<string>();

  if (resText) {
    try {
      const data = JSON.parse(resText);
      if (typeof data.Video === "string" && /^https?:\/\//.test(data.Video)) {
        directMp4.add(data.Video);
      }
      if (typeof data.Video_tmp === "string" && /^https?:\/\//.test(data.Video_tmp)) {
        directMp4.add(data.Video_tmp);
      }
      if (typeof data.ThirdParty === "string" && /^https?:\/\//.test(data.ThirdParty)) {
        embedUrls.add(data.ThirdParty);
      }
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

  for (const url of directMp4) {
    const isHls = /\.m3u8/i.test(url);
    if (isHls && denoBase) {
      // HLS: Stremio exige CORS → relay /hls del Deno.
      add({
        url: `${denoBase}/hls?u=${encodeURIComponent(url)}&r=${encodeURIComponent("https://kisskh.co/")}`,
        name: "KissKH HLS",
        title: "▶ KissKH — HLS",
        behaviorHints: {
          notWebReady: false,
          filename: `${epId}.m3u8`,
          bingeGroup: "kisskh-hls",
        },
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
