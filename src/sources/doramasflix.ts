import { Env } from "../types";
import { CHROME_UA, decodeEntities, fetchTmdb, netFetch, toMetaPreview } from "../utils";
import { extractMp4upload } from "../extractors";
import { resolveEpisodeSlug, searchVariants } from "./slugmap";

const GRAPHQL_ENDPOINT = "https://user-api.seriesapi.co/graphql";
const DORAMASFLIX_BASE = "https://doramasflix.in";

async function fetchGql(
  query: string,
  variables: Record<string, any> = {},
  timeoutMs = 12000
): Promise<any> {
  const res = await netFetch("direct", GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: DORAMASFLIX_BASE,
      Referer: `${DORAMASFLIX_BASE}/`,
      "User-Agent": CHROME_UA,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`Doramasflix GraphQL HTTP ${res.status}`);
  }

  const json: any = await res.json();
  if (json.errors && json.errors.length > 0) {
    throw new Error(`Doramasflix GraphQL error: ${json.errors[0].message}`);
  }

  return json.data;
}

export function cleanDoramasflixTitle(s: string): string {
  let t = decodeEntities(s).replace(/^\s*Ver\s+/i, "");
  t = t.split(/\s+[–—|]\s+/)[0];
  t = t.split(
    /\s+(?:subtitulad[oa]|doblad[oa]|online|en\s+hd|sub\s+(?:esp|sp)\w*|castellano|latino)\b/i
  )[0];
  return t
    .replace(/\s*\((?:en\s+emisi[oó]n|finalizado)\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function getDoramasflixCatalog(
  extra: Record<string, string>,
  env?: Env
) {
  const q = (extra.search || "").trim();
  if (q) {
    const page = Math.floor(parseInt(extra.skip || "0", 10) / 20) + 1;
    const query = `
      query SearchFullDoramas($input: String!, $page: Int, $perPage: Int) {
        searchFullDoramas(input: $input, page: $page, perPage: $perPage) {
          items {
            _id
            slug
            name
            name_es
            poster_path
          }
        }
      }
    `;
    const data = await fetchGql(query, { input: q, page, perPage: 20 });
    const items = data?.searchFullDoramas?.items || [];
    const metas = items.map((item: any) => {
      const poster = item.poster_path
        ? `https://image.tmdb.org/t/p/w342${item.poster_path}`
        : "";
      const name = cleanDoramasflixTitle(item.name || item.name_es || item.slug);
      return toMetaPreview({
        id: `dflix:${item.slug}`,
        name,
        poster,
      });
    });
    return { metas };
  }

  const page = Math.floor(parseInt(extra.skip || "0", 10) / 20) + 1;
  const limit = 20 * page;
  const query = `
    query ListDoramas($limit: Int) {
      listDoramas(limit: $limit) {
        _id
        name
        name_es
        slug
        poster_path
      }
    }
  `;
  const data = await fetchGql(query, { limit });
  const items = (data?.listDoramas || []).slice((page - 1) * 20, page * 20);
  const metas = items.map((item: any) => {
    const poster = item.poster_path
      ? `https://image.tmdb.org/t/p/w342${item.poster_path}`
      : "";
    const name = cleanDoramasflixTitle(item.name || item.name_es || item.slug);
    return toMetaPreview({
      id: `dflix:${item.slug}`,
      name,
      poster,
    });
  });

  return { metas };
}

export async function getDoramasflixMeta(
  id: string,
  tmdbKey: string,
  env?: Env
) {
  const slug = id.replace("dflix:", "");
  const query = `
    query DetailDoramaSlug($slug: String!) {
      detailDorama(filter: { slug: $slug }) {
        _id
        name
        slug
        name_es
        overview
        poster_path
        backdrop_path
        number_of_seasons
        number_of_episodes
        seasons {
          _id
          season_number
          number_of_episodes
        }
      }
    }
  `;
  const data = await fetchGql(query, { slug });
  const detail = data?.detailDorama;
  if (!detail) {
    return { meta: null };
  }

  const name = cleanDoramasflixTitle(detail.name || detail.name_es || slug);
  const poster = detail.poster_path
    ? `https://image.tmdb.org/t/p/w500${detail.poster_path}`
    : "";
  const background = detail.backdrop_path
    ? `https://image.tmdb.org/t/p/w1280${detail.backdrop_path}`
    : poster;
  const description = decodeEntities(detail.overview || "").trim();

  const episodes: { id: string; season: number; episode: number; title: string }[] = [];
  const seasons = detail.seasons || [];
  if (seasons.length > 0) {
    for (const s of seasons) {
      const seasonNum = s.season_number || 1;
      const count = s.number_of_episodes || detail.number_of_episodes || 1;
      for (let ep = 1; ep <= count; ep++) {
        const epSlug = `${slug}-${seasonNum}x${ep}`;
        episodes.push({
          id: `dflix:${epSlug}`,
          season: seasonNum,
          episode: ep,
          title: `T${seasonNum} · Episodio ${ep}`,
        });
      }
    }
  } else {
    const count = detail.number_of_episodes || 1;
    for (let ep = 1; ep <= count; ep++) {
      const epSlug = `${slug}-1x${ep}`;
      episodes.push({
        id: `dflix:${epSlug}`,
        season: 1,
        episode: ep,
        title: `T1 · Episodio ${ep}`,
      });
    }
  }

  const tmdb = await fetchTmdb(name, tmdbKey);

  return {
    meta: {
      id,
      type: "series",
      name,
      poster: tmdb?.poster || poster,
      background: tmdb?.background || background,
      description: tmdb?.description || description,
      posterShape: "poster",
      releaseInfo: tmdb?.year || "",
      videos: episodes.map((ep) => ({
        id: ep.id,
        title: ep.title,
        season: ep.season,
        episode: ep.episode,
      })),
    },
  };
}

function decodeEmbedUrl(url: string): string {
  if (!url || !url.includes("/e/")) return url;
  try {
    const jwtToken = url.split("/e/")[1];
    const payloadB64 = jwtToken.split(".")[1];
    if (!payloadB64) return url;
    // Replace URL-safe base64 characters if any
    const b64 = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const payloadStr = atob(b64);
    const payload = JSON.parse(payloadStr);
    if (payload && payload.link) {
      const decodedLink = atob(payload.link);
      return decodedLink || url;
    }
  } catch {}
  return url;
}

const EPISODE_DETAIL_QUERY = `
  query EpisodeDetailSlug($slug: String!) {
    detailEpisode(filter: { slug: $slug }) {
      _id
      name
      slug
      episode_number
      season_number
    }
  }
`;

/** `_id` + `slug` del episodio por slug sintético ({serieSlug}-{s}x{e}) —
 * o null si el slug no existe en su BD (detailEpisode null) o la GraphQL
 * falla/transcurre con error. Null NO distingue not-found de error: el
 * llamador decide si resuelve o termina. */
async function getEpisodeBySlug(
  epSlug: string
): Promise<{ id: string; slug: string } | null> {
  try {
    const data = await fetchGql(EPISODE_DETAIL_QUERY, { slug: epSlug });
    const ep = data?.detailEpisode;
    return ep?._id ? { id: ep._id, slug: ep.slug } : null;
  } catch {
    return null;
  }
}

/** Resuelve el epSlug propio de doramasflix para un epSlug venido de otro
 * sitio (mapping por título, ver slugmap.ts). dflix no tiene HTML que raspar:
 * la búsqueda es su GraphQL `searchFullDoramas` (por nombre, ya existente en
 * el catálogo) y el id del episodio se RECOMPOne aritméticamente con el
 * serieSlug de su BD: sus slugs de episodio siguen el patrón
 * `{serieSlug}-{s}x{e}` (el mismo que genera getDoramasflixMeta). */
export async function resolveDflixEpisodeSlug(
  epSlug: string,
  env: Env
): Promise<string | null> {
  const SEARCH_QUERY = `
    query SearchFullDoramas($input: String!, $page: Int, $perPage: Int) {
      searchFullDoramas(input: $input, page: $page, perPage: $perPage) {
        items { _id slug }
      }
    }
  `;
  return resolveEpisodeSlug(
    {
      site: "dflix",
      searchSeries: (title) =>
        (async () => {
          const slugs = new Set<string>();
          for (const v of searchVariants(title)) {
            const data = await fetchGql(SEARCH_QUERY, {
              input: v,
              page: 1,
              perPage: 20,
            });
            for (const it of data?.searchFullDoramas?.items || [])
              if (it?.slug) slugs.add(it.slug);
          }
          return [...slugs];
        })(),
      fetchEpisodes: (seriesSlug) =>
        (async () => {
          // detailDorama (query del meta) trae seasons {season_number,
          // number_of_episodes}: de ahí sale el mapa completo SxE → slug con
          // el mismo criterio que getDoramasflixMeta usa para sus videos.
          const detail = await getDoramasflixMeta(
            `dflix:${seriesSlug}`,
            "", // sin TMDB: solo se necesitan las seasons
            env
          );
          const videos = (detail.meta as any)?.videos || [];
          const list: { s: number; e: number; epSlug: string }[] = [];
          for (const v of videos)
            if (v?.season && v?.episode)
              list.push({
                s: v.season,
                e: v.episode,
                epSlug: `${seriesSlug}-${v.season}x${v.episode}`,
              });
          return list;
        })(),
    },
    epSlug,
    env
  );
}

export async function getDoramasflixStreams(
  rawId: string,
  env: Env,
  request: Request
) {
  const epSlug = rawId.replace("dflix:", "");

  const found = await getEpisodeBySlug(epSlug);
  let epId = found?.id || "";
  if (!epId) {
    // Slug venido de otro sitio (o fallo transitorio): resolver por título y
    // recomponer el id dflix (dflix:{serieSlug}-{s}x{e}) para reintentar. El
    // re-intent vale aunque coincida el slug: barato (1 GraphQL) y cubre el
    // caso de la primera query muerta por red.
    const resolved = await resolveDflixEpisodeSlug(epSlug, env);
    if (resolved) {
      if (resolved !== epSlug)
        console.log(`[dflix] slug resuelto: ${epSlug} → ${resolved}`);
      const found2 = await getEpisodeBySlug(resolved);
      epId = found2?.id || "";
    }
  }
  if (!epId) return { streams: [] };

  const linksQuery = `
    query EpisodeLinksOnline($episode_id: ID!) {
      getEpisodeLinks(id: $episode_id) {
        links_online {
          _id
          server
          lang
          link
        }
      }
    }
  `;

  let rawLinks = [];

  try {
    const linksData = await fetchGql(linksQuery, { episode_id: epId });
    rawLinks = linksData?.getEpisodeLinks?.links_online || [];

    console.log(`[dflix] ${rawLinks.length} links para ${epSlug}`);

    if (rawLinks.length === 0) return { streams: [] };
  } catch (e) {
    console.error(`Error fetching Doramasflix episode links: ${e}`);
    return { streams: [] };
  }


  const denoBase = (env.FETCH_PROXY_URL || "")
    .trim()
    .replace(/\/fetch\/?$/, "")
    .replace(/\/$/, "");

  const streams: any[] = [];
  const seenUrl = new Set<string>();

  const add = (s: any) => {
    const k = s.url || s.externalUrl;
    if (k && !seenUrl.has(k)) {
      seenUrl.add(k);
      streams.push(s);
    }
  };

  for (const item of rawLinks) {
    if (!item.link) continue;
    const decodedEmbed = decodeEmbedUrl(item.link);
    if (!decodedEmbed) continue;

    const host =
      decodedEmbed.match(/https?:\/\/(?:www\.)?([a-z0-9-]+)\./i)?.[1] || "host";

    const ext = () =>
      add({
        externalUrl: decodedEmbed,
        name: "Doramasflix 🌐",
        title: `🌐 ${host} — Doramasflix`,
      });

    if (
      // Espejos de StreamWish admitidos — mantén sincronizado con deno/fetch.ts
      // (allowlist de /streamwish) y con las otras fuentes.
      /streamwish|embedwish|wishfast|sfastwish|swishsrv|streamaly|streamis|flaswish|do7go|playmogo/i.test(
        decodedEmbed
      )
    ) {
      if (denoBase) {
        add({
          url: `${denoBase}/streamwish?url=${encodeURIComponent(decodedEmbed)}`,
          name: "Doramasflix HLS",
          title: `▶ streamwish — Doramasflix`,
          behaviorHints: {
            notWebReady: false,
            filename: `${epSlug}.m3u8`,
            bingeGroup: "dflix-streamwish",
          },
        });
      } else ext();
      continue;
    }

    if (decodedEmbed.includes("mp4upload.com")) {
      const u = await extractMp4upload(decodedEmbed);
      if (u) {
        add({
          url: u,
          name: "Doramasflix MP4",
          title: `▶ mp4upload — Doramasflix`,
          behaviorHints: {
            notWebReady: false,
            filename: `${epSlug}.mp4`,
            bingeGroup: "dflix-mp4upload",
          },
        });
        continue;
      }
    }

    ext();
  }

  return { streams };
}
