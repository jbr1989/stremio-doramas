import { Env } from "../types";
import {
  cleanTitle,
  denoBaseFromEnv,
  fetchHtml,
  fetchTmdb,
  makeStreamDeduper,
  toMetaPreview,
} from "../utils";
import { addEmbedStreams } from "../extractors";

const KISSKH_BASE = "https://kisskh.co";

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
    resText = await fetchHtml(url, env);
  } catch {
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
  const pageUrl = `${KISSKH_BASE}/api/DramaList/Drama/${dramaId}?is_q=true`;

  let resText = "";
  try {
    resText = await fetchHtml(pageUrl, env);
  } catch {
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

  const apiUrl = `${KISSKH_BASE}/api/Episode/${epId}`;
  let resText = "";
  try {
    resText = await fetchHtml(apiUrl, env);
  } catch {
    resText = "";
  }

  const embedUrls = new Set<string>();

  if (resText) {
    try {
      const data = JSON.parse(resText);
      if (data.Video || data.video) {
        embedUrls.add(data.Video || data.video);
      }
      if (data.Video2 || data.video2) {
        embedUrls.add(data.Video2 || data.video2);
      }
      if (Array.isArray(data.videos)) {
        for (const v of data.videos) {
          if (v.url || v.src) embedUrls.add(v.url || v.src);
        }
      }
    } catch {
      for (const m of resText.matchAll(
        /(https?:\/\/[^"'\s\\]+\.(?:m3u8|mp4)[^"'\s\\]*)/gi
      )) {
        embedUrls.add(m[1]);
      }
    }
  }

  if (embedUrls.size === 0) return { streams: [] };

  const denoBase = denoBaseFromEnv(env);
  const { add, streams } = makeStreamDeduper();

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
