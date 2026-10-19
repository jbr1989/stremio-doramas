import { Env } from "../types";
import { CHROME_UA, decodeEntities, fetchTmdb, netFetch, toMetaPreview } from "../utils";
import { extractMp4upload } from "../extractors";

const PANDRAMA_BASE = "https://www.pandrama.tv";

export async function fetchPandramaData(path: string, env?: Env): Promise<any | null> {
  const url = path.startsWith("http") ? path : `${PANDRAMA_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  const proxyBase = env?.FETCH_PROXY_URL?.trim();

  const pull = async (name: string, r: Promise<Response>) => {
    const res = await r;
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const txt = await res.text();
    if (txt.length < 300) throw new Error(`${name}: text too short (${txt.length}b)`);
    return txt;
  };

  const racers: Promise<string>[] = [
    pull(
      "direct",
      netFetch("direct", url, {
        headers: {
          "User-Agent": CHROME_UA,
          Referer: `${PANDRAMA_BASE}/`,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(8000),
      })
    ),
  ];

  if (proxyBase) {
    racers.push(
      pull(
        "relay",
        netFetch("proxy", `${proxyBase}?url=${encodeURIComponent(url)}`, {
          headers: { "User-Agent": CHROME_UA },
          signal: AbortSignal.timeout(11000),
        })
      )
    );
  }

  try {
    const html = await Promise.any(racers);
    const m = html.match(/window\.bootstrapData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (!m) return null;
    return JSON.parse(m[1]);
  } catch (e) {
    console.log(`[pandrama] fetchPandramaData failed for ${path}: ${e}`);
    return null;
  }
}

function normalizePoster(rawPoster?: string): string {
  if (!rawPoster) return "";
  if (rawPoster.startsWith("http")) return rawPoster;
  return `${PANDRAMA_BASE}/${rawPoster.replace(/^\//, "")}`;
}

export async function getPandramaCatalog(
  extra: Record<string, string>,
  env?: Env
) {
  const q = (extra.search || "").trim();
  if (q) {
    const data = await fetchPandramaData(`/search/${encodeURIComponent(q)}`, env);
    const results = data?.loaders?.searchPage?.results || [];
    const metas = results.map((item: any) =>
      toMetaPreview({
        id: `pandrama:${item.id}:${item.slug || "dorama"}`,
        name: decodeEntities(item.name || "Dorama"),
        poster: normalizePoster(item.poster),
      })
    );
    return { metas };
  }

  const data = await fetchPandramaData("/channel/agregado-recientemente", env);
  const items = data?.loaders?.channelPage?.channel?.content?.data || [];
  const metas = items.map((item: any) =>
    toMetaPreview({
      id: `pandrama:${item.id}:${item.slug || "dorama"}`,
      name: decodeEntities(item.name || "Dorama"),
      poster: normalizePoster(item.poster),
    })
  );
  return { metas };
}

export async function getPandramaMeta(
  id: string,
  tmdbKey: string,
  env?: Env
) {
  // id format: pandrama:{titleId}:{slug} or pandrama:{titleId}
  const raw = id.slice("pandrama:".length);
  const parts = raw.split(":");
  const titleId = parts[0];
  const slug = parts[1] || "dorama";

  const data = await fetchPandramaData(`/titulo/${titleId}/${slug}`, env);
  const titlePage = data?.loaders?.titlePage;
  if (!titlePage || !titlePage.title) {
    return { meta: null };
  }

  const titleObj = titlePage.title;
  const name = decodeEntities(titleObj.name || "Dorama");
  const poster = normalizePoster(titleObj.poster);
  const description = decodeEntities(titleObj.description || "");
  const episodesData = titlePage.episodes?.data || [];

  const videos: any[] = [];
  if (Array.isArray(episodesData) && episodesData.length > 0) {
    episodesData.forEach((ep: any) => {
      const s = ep.season_number || 1;
      const e = ep.episode_number || 1;
      const videoId = ep.primary_video?.id || ep.id;
      videos.push({
        id: `pandrama:${titleObj.id}:ep:${videoId}`,
        title: `T${s} · Episodio ${e}`,
        season: s,
        episode: e,
      });
    });
  } else if (titleObj.primary_video?.id) {
    videos.push({
      id: `pandrama:${titleObj.id}:ep:${titleObj.primary_video.id}`,
      title: name,
      season: 1,
      episode: 1,
    });
  }

  const tmdb = await fetchTmdb(name, tmdbKey);

  return {
    meta: {
      id,
      type: "series",
      name,
      poster: tmdb?.poster || poster,
      background: tmdb?.background || poster,
      description: tmdb?.description || description,
      posterShape: "poster",
      releaseInfo: tmdb?.year || (titleObj.year ? String(titleObj.year) : ""),
      videos,
    },
  };
}

export async function getPandramaStreams(
  rawId: string,
  env: Env,
  request: Request
) {
  let videoId: string | null = null;
  let epSlug = "";

  if (rawId.startsWith("pandrama:")) {
    const content = rawId.slice("pandrama:".length);
    if (content.includes(":ep:")) {
      videoId = content.split(":ep:")[1];
    } else {
      epSlug = content;
    }
  } else {
    epSlug = rawId;
  }

  // Si no tenemos videoId pero tenemos epSlug (ej: tu-taxi-personal-1x1 desde fan-out)
  if (!videoId && epSlug) {
    const sxeM = epSlug.match(/^(.*?)-(\d+)x(\d+)$/);
    if (sxeM) {
      const seriesSlug = sxeM[1];
      const targetS = parseInt(sxeM[2], 10);
      const targetE = parseInt(sxeM[3], 10);

      // Búsqueda por slug o título
      const searchData = await fetchPandramaData(`/search/${encodeURIComponent(seriesSlug.replace(/-/g, " "))}`, env);
      const results = searchData?.loaders?.searchPage?.results || [];
      const best = results[0];
      if (best?.id) {
        const titleData = await fetchPandramaData(`/titulo/${best.id}/${best.slug || "dorama"}`, env);
        const episodes = titleData?.loaders?.titlePage?.episodes?.data || [];
        const ep = episodes.find(
          (e: any) => (e.season_number || 1) === targetS && (e.episode_number || 1) === targetE
        );
        if (ep?.primary_video?.id) {
          videoId = String(ep.primary_video.id);
        }
      }
    }
  }

  if (!videoId) {
    return { streams: [] };
  }

  const data = await fetchPandramaData(`/ver/${videoId}`, env);
  const epPage = data?.loaders?.episodePage;
  if (!epPage) return { streams: [] };

  const altVideos: any[] = epPage.alternative_videos || [];
  if (altVideos.length === 0 && epPage.current_video) {
    altVideos.push(epPage.current_video);
  }

  const denoBase = (env.FETCH_PROXY_URL || "")
    .trim()
    .replace(/\/fetch\/?$/, "")
    .replace(/\/$/, "");

  const streams: any[] = [];
  const seen = new Set<string>();

  const add = (s: any) => {
    const k = s.url || s.externalUrl;
    if (k && !seen.has(k)) {
      seen.add(k);
      streams.push(s);
    }
  };

  for (const v of altVideos) {
    let src = v.src || "";
    if (!src) continue;
    if (src.startsWith("/")) src = `${PANDRAMA_BASE}${src}`;

    const serverName = v.server_info?.display_name || v.name || "Pandrama";

    // Direct HLS stream
    if (src.includes(".m3u8") || v.type === "shaka" || src.includes("pandrama.tv/hls")) {
      add({
        url: src,
        name: "Pandrama HLS",
        title: `▶ ${serverName} — Pandrama`,
        behaviorHints: {
          notWebReady: false,
          filename: "episode.m3u8",
          bingeGroup: "pandrama-hls",
        },
      });
      add({
        externalUrl: src,
        name: "Pandrama 🌐",
        title: `🌐 ${serverName} (HLS Directo) — Pandrama`,
      });
      continue;
    }

    // StreamWish or mirrors
    if (
      /streamwish|embedwish|wishfast|sfastwish|swishsrv|streamaly|streamis|flaswish|do7go|playmogo/i.test(
        src
      )
    ) {
      if (denoBase) {
        add({
          url: `${denoBase}/streamwish?url=${encodeURIComponent(src)}`,
          name: "Pandrama HLS",
          title: `▶ ${serverName} — Pandrama`,
          behaviorHints: {
            notWebReady: false,
            filename: "episode.m3u8",
            bingeGroup: "pandrama-streamwish",
          },
        });
      } else {
        add({
          externalUrl: src,
          name: "Pandrama 🌐",
          title: `🌐 ${serverName} — Pandrama`,
        });
      }
      continue;
    }

    if (src.includes("mp4upload.com")) {
      const u = await extractMp4upload(src);
      if (u) {
        add({
          url: u,
          name: "Pandrama MP4",
          title: `▶ mp4upload — Pandrama (${serverName})`,
          behaviorHints: {
            notWebReady: false,
            filename: "episode.mp4",
            bingeGroup: "pandrama-mp4upload",
          },
        });
        continue;
      }
    }

    // Default externalUrl fallback for any other embed (bysekoze, lulustream, vk, etc)
    add({
      externalUrl: src,
      name: "Pandrama 🌐",
      title: `🌐 ${serverName} — Pandrama`,
    });
  }

  return { streams };
}
