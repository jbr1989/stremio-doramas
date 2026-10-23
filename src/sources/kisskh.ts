import { Env } from "../types";
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

function normalizePoster(rawPoster?: string): string {
  if (!rawPoster) return "";
  if (rawPoster.startsWith("http")) return rawPoster;
  return `${KISSKH_BASE}${rawPoster.startsWith("/") ? "" : "/"}${rawPoster}`;
}

export function canonicalKisskhSlug(slug: string): string {
  if (/-\d+x\d+$/.test(slug)) return slug;
  return slug;
}

export async function getKisskhCatalog(
  extra: Record<string, string>,
  env?: Env
) {
  const q = (extra.search || "").trim();
  const skip = parseInt(extra.skip || "0", 10);
  const page = Math.floor(skip / 25) + 1;

  let url = "";
  if (q) {
    url = `${KISSKH_BASE}/api/DramaList/Search?q=${encodeURIComponent(q)}`;
  } else {
    url = `${KISSKH_BASE}/api/DramaList/Drama?page=${page}&type=0&sub=0`;
  }

  let htmlOrJson = "";
  try {
    htmlOrJson = await fetchHtml(url, env);
  } catch (e) {
    console.log(`[kisskh] fetch catalog failed: ${e}`);
    htmlOrJson = "";
  }

  if (!htmlOrJson) return { metas: [] };

  try {
    const data = JSON.parse(htmlOrJson);
    const items = Array.isArray(data)
      ? data
      : Array.isArray(data?.data)
      ? data.data
      : [];

    const metas = items
      .filter((item: any) => item && item.id)
      .map((item: any) =>
        toMetaPreview({
          id: `kisskh:${item.id}`,
          name: cleanTitle(item.title || "Dorama"),
          poster: normalizePoster(item.thumbnail),
        })
      );

    return { metas };
  } catch (e) {
    console.log(`[kisskh] JSON parse catalog failed: ${e}`);
    return { metas: [] };
  }
}

export async function getKisskhMeta(
  id: string,
  tmdbKey: string,
  env?: Env
) {
  const dramaId = id.replace(/^kisskh:/, "");
  const url = `${KISSKH_BASE}/api/DramaList/Drama/${dramaId}`;

  let htmlOrJson = "";
  try {
    htmlOrJson = await fetchHtml(url, env);
  } catch (e) {
    console.log(`[kisskh] fetch meta failed for ${id}: ${e}`);
    return { meta: null };
  }

  try {
    const data = JSON.parse(htmlOrJson);
    if (!data || !data.id) return { meta: null };

    const name = cleanTitle(data.title || "Dorama");
    const poster = normalizePoster(data.thumbnail);
    const description = decodeEntities(data.description || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const tmdb = await fetchTmdb(name, tmdbKey);

    const episodes = Array.isArray(data.episodes) ? data.episodes : [];
    const videos = episodes.map((ep: any) => {
      const epNum = Number(ep.number) || 1;
      const epId = ep.id;
      return {
        id: `kisskh:ep:${epId}`,
        title: `T1 · Episodio ${epNum}`,
        season: 1,
        episode: epNum,
        thumbnail: tmdb?.poster || poster,
      };
    });

    return {
      meta: {
        id,
        type: "series",
        name,
        poster: tmdb?.poster || poster,
        background: tmdb?.background || poster,
        description: tmdb?.description || description,
        posterShape: "poster",
        releaseInfo: tmdb?.year || (data.status ? String(data.status) : ""),
        genres: [],
        videos,
      },
    };
  } catch (e) {
    console.log(`[kisskh] JSON parse meta failed for ${id}: ${e}`);
    return { meta: null };
  }
}

export async function getKisskhStreams(rawId: string, env: Env) {
  let episodeId = "";

  if (rawId.startsWith("kisskh:")) {
    const content = rawId.slice("kisskh:".length);
    if (content.startsWith("ep:")) {
      episodeId = content.slice(3);
    } else {
      // Formato slug o dramaId-1xN
      const sxeM = content.match(/^(.*?)-(\d+)x(\d+)$/);
      if (sxeM) {
        const dramaCandidate = sxeM[1];
        const targetE = parseInt(sxeM[3], 10);
        if (/^\d+$/.test(dramaCandidate)) {
          // Es un ID numérico de drama
          try {
            const metaRes = await fetchHtml(
              `${KISSKH_BASE}/api/DramaList/Drama/${dramaCandidate}`,
              env
            );
            const data = JSON.parse(metaRes);
            const ep = (data?.episodes || []).find(
              (e: any) => (Number(e.number) || 1) === targetE
            );
            if (ep?.id) episodeId = String(ep.id);
          } catch {}
        } else {
          // Búsqueda por slug / nombre
          try {
            const searchRes = await fetchHtml(
              `${KISSKH_BASE}/api/DramaList/Search?q=${encodeURIComponent(
                dramaCandidate.replace(/-/g, " ")
              )}`,
              env
            );
            const searchData = JSON.parse(searchRes);
            const items = Array.isArray(searchData) ? searchData : [];
            const best = items[0];
            if (best?.id) {
              const metaRes = await fetchHtml(
                `${KISSKH_BASE}/api/DramaList/Drama/${best.id}`,
                env
              );
              const data = JSON.parse(metaRes);
              const ep = (data?.episodes || []).find(
                (e: any) => (Number(e.number) || 1) === targetE
              );
              if (ep?.id) episodeId = String(ep.id);
            }
          } catch {}
        }
      }
    }
  } else {
    // rawId sin prefijo (ej: desde fan-out epSlug)
    const sxeM = rawId.match(/^(.*?)-(\d+)x(\d+)$/);
    if (sxeM) {
      const dramaName = sxeM[1].replace(/-/g, " ");
      const targetE = parseInt(sxeM[3], 10);
      try {
        const searchRes = await fetchHtml(
          `${KISSKH_BASE}/api/DramaList/Search?q=${encodeURIComponent(
            dramaName
          )}`,
          env
        );
        const searchData = JSON.parse(searchRes);
        const items = Array.isArray(searchData) ? searchData : [];
        const best = items[0];
        if (best?.id) {
          const metaRes = await fetchHtml(
            `${KISSKH_BASE}/api/DramaList/Drama/${best.id}`,
            env
          );
          const data = JSON.parse(metaRes);
          const ep = (data?.episodes || []).find(
            (e: any) => (Number(e.number) || 1) === targetE
          );
          if (ep?.id) episodeId = String(ep.id);
        }
      } catch {}
    }
  }

  if (!episodeId) {
    return { streams: [] };
  }

  const url = `${KISSKH_BASE}/api/DramaList/Episode/${episodeId}.png?`;
  let htmlOrJson = "";
  try {
    htmlOrJson = await fetchHtml(url, env);
  } catch (e) {
    console.log(`[kisskh] fetch episode streams failed for ${episodeId}: ${e}`);
    return { streams: [] };
  }

  const { add, streams } = makeStreamDeduper();
  const denoBase = denoBaseFromEnv(env);

  try {
    const data = JSON.parse(htmlOrJson);
    const videoUrl = data?.Video || data?.video || "";
    const thirdParty = data?.ThirdParty || data?.thirdParty || "";

    if (videoUrl && typeof videoUrl === "string") {
      const isM3u8 = videoUrl.includes(".m3u8");
      add({
        url: videoUrl,
        name: isM3u8 ? "KissKH HLS" : "KissKH MP4",
        title: `▶ Directo — KissKH`,
        behaviorHints: {
          notWebReady: false,
          filename: isM3u8 ? "episode.m3u8" : "episode.mp4",
          bingeGroup: isM3u8 ? "kisskh-hls" : "kisskh-mp4",
        },
      });
    }

    if (thirdParty && typeof thirdParty === "string") {
      await addEmbedStreams({
        embed: thirdParty,
        epSlug: `kisskh:ep:${episodeId}`,
        label: "KissKH",
        prefix: "kisskh",
        denoBase,
        add,
        env,
      });
    }
  } catch (e) {
    console.log(`[kisskh] JSON parse episode stream failed for ${episodeId}: ${e}`);
  }

  return { streams };
}
