import { Env } from "../types";
import { genreLabelForMeta, genreSlug } from "../genres";
import {
  cacheGet,
  cacheSet,
  CHROME_UA,
  decodeEntities,
  denoBaseFromEnv,
  fetchTmdb,
  makeStreamDeduper,
  netFetch,
  STREAMWISH_HOSTS_RE,
  toMetaPreview,
} from "../utils";
import { extractMp4upload } from "../extractors";

const PANDRAMA_BASE = "https://www.pandrama.tv";

// /explorar acepta filters=<encodeURIComponent(btoa(JSON))>. mainTypes id 2
// es "Drama" (el tipo principal del sitio — todos los dramas asiáticos);
// los géneros son IDS numéricos (value-lists API, src/genres.ts) con
// operator hasAll. Excluye server-side "Shorts" (mainType 4) y películas
// (mainType 1). Pagina con &page=N (Laravel: per_page=48, total).
//
// Formato confirmado in-vivo (oct. 2026): el propio SPA compone
// encodeURIComponent(btoa(JSON.stringify(filters))) y el filtro de género
// devuelve catálogos propios (romance/boys-love/animación verificados).
function pandramaExplorePath(genres?: number[]): string {
  const filters: { key: string; value: number[]; operator: "hasAll" }[] = [
    { key: "mainTypes", value: [2], operator: "hasAll" },
  ];
  if (genres?.length) {
    filters.push({ key: "genres", value: genres, operator: "hasAll" });
  }
  const b64 = encodeURIComponent(btoa(JSON.stringify(filters)));
  return `${PANDRAMA_BASE}/explorar?filters=${b64}&order=views_day:desc`;
}

const PANDRAMA_PAGE_SIZE = 48;

// El fan-out de src/index.ts consulta las demás fuentes con un slug canónico
// "titulo-NxM", pero los IDs pandrama son videos (`pandrama:{titleId}:ep:{videoId}`).
// Esta función resuelve el video a episodio vía /ver/{videoId} (que trae
// episodePage.title.slug y episode.season_number/episode_number) y cachea el
// resultado en KV: acierto 24h, fallo 15 min (para no martillar /ver en bucle).
const PANDRAMA_FANOUT_TTL = 24 * 60 * 60;
const PANDRAMA_FANOUT_MISS_TTL = 15 * 60;

export async function pandramaEpCanonicalSlug(
  videoId: string,
  env: Env
): Promise<string> {
  const key = `pandrama:fanout:v1:${videoId}`;
  const cached = (await cacheGet(key, env.STREAM_CACHE)) as
    | { slug?: string }
    | null;
  if (cached) return cached.slug || "";

  let slug = "";
  try {
    const data = await fetchPandramaData(`/ver/${videoId}`, env);
    const page = data?.loaders?.episodePage;
    const titleSlug = String(page?.title?.slug || "").toLowerCase();
    const s = Number(page?.episode?.season_number || 1);
    const e = Number(page?.episode?.episode_number || 1);
    if (titleSlug) slug = `${titleSlug}-${s}x${e}`;
  } catch {
    slug = "";
  }
  await cacheSet(
    key,
    { slug },
    slug ? PANDRAMA_FANOUT_TTL : PANDRAMA_FANOUT_MISS_TTL,
    env.STREAM_CACHE
  );
  return slug;
}

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

// Defensa por si la fuente vuelve a mezclar shorts: main_type llega como
// "Shorts" (catálogo) o "shorts" (búsqueda), así que se compara en minúsculas.
function isPandramaShort(item: any): boolean {
  const types = Array.isArray(item?.main_types) ? item.main_types : [];
  if (types.some((t: any) => String(t?.name || "").toLowerCase() === "shorts")) return true;
  return String(item?.main_type || "").toLowerCase() === "shorts";
}

export async function getPandramaCatalog(
  extra: Record<string, string>,
  env?: Env
) {
  const q = (extra.search || "").trim();
  if (q) {
    const data = await fetchPandramaData(`/search/${encodeURIComponent(q)}`, env);
    const results = data?.loaders?.searchPage?.results || [];
    const items = results.filter((item: any) => !isPandramaShort(item));
    const metas = items.map((item: any) =>
      toMetaPreview({
        id: `pandrama:${item.id}:${item.slug || "dorama"}`,
        name: decodeEntities(item.name || "Dorama"),
        poster: normalizePoster(item.poster),
      })
    );
    return { metas };
  }

  // Género (label ES → id pandrama vía la lista maestra, src/genres.ts).
  // El filtro genres=[id] hasAll devuelve el catálogo propio del género
  // (validado in-vivo); paginado y shape de respuesta idénticos al directorio.
  const g = (extra.genre || "").trim();
  if (g) {
    const genreId = genreSlug("pandrama", g);
    if (!genreId) return { metas: [] };
    const gpage = Math.floor(Number(extra.skip || 0) / PANDRAMA_PAGE_SIZE) + 1;
    const data = await fetchPandramaData(
      `${pandramaExplorePath([Number(genreId)])}&page=${gpage}`,
      env
    );
    const items = (
      data?.loaders?.channelPage?.channel?.content?.data || []
    ).filter((item: any) => !isPandramaShort(item));
    const metas = items.map((item: any) =>
      toMetaPreview({
        id: `pandrama:${item.id}:${item.slug || "dorama"}`,
        name: decodeEntities(item.name || "Dorama"),
        poster: normalizePoster(item.poster),
      })
    );
    return { metas };
  }

  const page = Math.floor(Number(extra.skip || 0) / PANDRAMA_PAGE_SIZE) + 1;
  const data = await fetchPandramaData(
    `${pandramaExplorePath()}&page=${page}`,
    env
  );
  const items = (data?.loaders?.channelPage?.channel?.content?.data || []).filter(
    (item: any) => !isPandramaShort(item)
  );
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

  // Géneros de la ficha: titlePage.title.genres llega inline en el propio
  // bootstrapData con {id, name, display_name} (no hay scraping ni llamadas
  // extra: el /api/v1/value-lists/genres existe pero es innecesario). La
  // lista maestra registra los slugs pandrama como IDs numéricos
  // (src/genres.ts), así que id=12 → "Acción y aventura" canónica mejor que
  // el "Action & Adventure" de la API; los no registrados muestran su
  // display_name tal cual (decisión del usuario). Dedup por label, en orden
  // de llegada de la API.
  const genres: string[] = [];
  const gSeen = new Set<string>();
  for (const g of titleObj.genres || []) {
    if (!g?.id && g?.id !== 0) continue;
    const label = genreLabelForMeta(
      "pandrama",
      String(g.id),
      g.display_name || g.name
    );
    if (!label || gSeen.has(label)) continue;
    gSeen.add(label);
    genres.push(label);
  }

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
        // El bootstrapData trae el still de TMDB por episodio; si falta, usa
        // el póster de la serie.
        thumbnail: normalizePoster(ep.poster) || poster,
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
      genres,
      videos,
    },
  };
}

export async function getPandramaStreams(
  rawId: string,
  env: Env
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

  const denoBase = denoBaseFromEnv(env);

  const { add, streams } = makeStreamDeduper();

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

    // StreamWish or mirrors (STREAMWISH_HOSTS_RE — sincronizado con deno/fetch.ts)
    if (STREAMWISH_HOSTS_RE.test(src)) {
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
