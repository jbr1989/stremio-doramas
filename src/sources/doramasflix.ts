import { Env } from "../types";
import { genreLabelForMeta, genreSlug } from "../genres";
import { CHROME_UA, cleanTitle, decodeEntities, denoBaseFromEnv, fetchTmdb, makeStreamDeduper, netFetch, toMetaPreview } from "../utils";
import { addEmbedStreams } from "../extractors";
import { resolveEpisodeSlug, searchVariants } from "./slugmap";

const GRAPHQL_ENDPOINT = "https://user-api.seriesapi.co/graphql";
const DORAMASFLIX_BASE = "https://doramasflix.in";
// Espejos: los 4 dominios son la misma plataforma con el mismo backend
// (user-api.seriesapi.co — verificado in-vivo: misma BD, mismos _id).
// Si un origen falla (red/timeout/HTTP), se reintenta con el siguiente.
const GQL_ORIGINS = [
  DORAMASFLIX_BASE,            // doramasflix.in (primario)
  "https://doramasia.com",     // espejo actual
  "https://doramasflix.io",    // espejo: misma marca, web alternativa
  "https://doramasmp4.io",     // espejo: otra marca, mismo backend
];

async function fetchGql(
  query: string,
  variables: Record<string, any> = {},
  timeoutMs = 12000
): Promise<any> {
  const errors: string[] = [];
  for (const base of GQL_ORIGINS) {
    try {
      const res = await netFetch("direct", GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: base,
          Referer: `${base}/`,
          "User-Agent": CHROME_UA,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const json: any = await res.json();
      if (json.errors && json.errors.length > 0) {
        throw new Error(`GraphQL: ${json.errors[0].message}`);
      }

      return json.data;
    } catch (e) {
      errors.push(`${base}: ${e instanceof Error ? e.message : String(e)}`);
      // Red fallida con este origen -> probar el siguiente (failover secuencial).
    }
  }
  throw new Error(`Doramasflix GraphQL fallo en todos los orígenes — ${errors.join(" | ")}`);
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
      const name = cleanTitle(item.name || item.name_es || item.slug);
      return toMetaPreview({
        id: `dflix:${item.slug}`,
        name,
        poster,
      });
    });
    return { metas };
  }

  // Género vía la GraphQL nativa del sitio (query paginationDorama — la MISMA
  // que usa su página SSR /generos/{slug}; capturada del tráfico real y
  // validada in-vivo: romance count=1658, drama 2451…). Paginación page/limit
  // con perPage=24 (el valor del sitio). Sort default del backend
  // (_ID_DESC — recientes), igual que el sitio.
  const g = (extra.genre || "").trim();
  if (g) {
    const gslug = genreSlug("dflix", g);
    if (!gslug) return { metas: [] };
    const gpage = Math.floor(parseInt(extra.skip || "0", 10) / 24) + 1;
    const gqlGenre = `
      query PaginationDorama($limit: Int, $filter: FilterDoramasInput, $page: Int) {
        paginationDorama(limit: $limit, filter: $filter, page: $page) {
          items {
            slug
            name
            name_es
            poster_path
          }
        }
      }
    `;
    const gdata = await fetchGql(gqlGenre, {
      page: gpage,
      limit: 24,
      filter: { genreSlug: gslug, isTVShow: false },
    });
    const gitems = gdata?.paginationDorama?.items || [];
    const gmetas = gitems.map((item: any) => {
      const poster = item.poster_path
        ? `https://image.tmdb.org/t/p/w342${item.poster_path}`
        : "";
      const name = cleanTitle(item.name || item.name_es || item.slug);
      return toMetaPreview({
        id: `dflix:${item.slug}`,
        name,
        poster,
      });
    });
    return { metas: gmetas };
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
    const name = cleanTitle(item.name || item.name_es || item.slug);
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
        genres {
          slug
          name
        }
      }
    }
  `;
  const data = await fetchGql(query, { slug });
  const detail = data?.detailDorama;
  if (!detail) {
    return { meta: null };
  }

  const name = cleanTitle(detail.name || detail.name_es || slug);
  const poster = detail.poster_path
    ? `https://image.tmdb.org/t/p/w500${detail.poster_path}`
    : "";
  const background = detail.backdrop_path
    ? `https://image.tmdb.org/t/p/w1280${detail.backdrop_path}`
    : poster;
  const description = decodeEntities(detail.overview || "").trim();

  // Géneros de la ficha: relation genres {slug, name} de la propia GraphQL
  // (campo validado in-vivo contra la API de producción — los descartes
  // genreSlug/genre/tags no existen en el tipo Dorama y matarían la query
  // entera: MUST VALIDAR cualquier campo nuevo en una query de prueba antes
  // de agregarlo aquí). Etiqueta: canónica ES de la lista maestra (dflix
  // registra sus slugs, src/genres.ts) o el name de la API tal cual —
  // DECISION DEL USUARIO para los no registrados — último recurso, slug
  // humanizado. Las entradas con slug null (p.ej. "TV Movie" en listGenres)
  // se saltan. Dedup por label con la orden de la API.
  const genres: string[] = [];
  const gSeen = new Set<string>();
  for (const g of detail.genres || []) {
    if (!g?.slug) continue;
    const label = genreLabelForMeta("dflix", g.slug.toLowerCase(), g.name);
    if (!label || gSeen.has(label)) continue;
    gSeen.add(label);
    genres.push(label);
  }

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
      genres,
      videos: episodes.map((ep) => ({
        id: ep.id,
        title: ep.title,
        season: ep.season,
        episode: ep.episode,
        // dflix no expone still por episodio: su listEpisodes exigiría 1
        // llamada GraphQL por capítulo — caemos al póster de la serie.
        thumbnail: poster,
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


  const denoBase = denoBaseFromEnv(env);

  const { add, streams } = makeStreamDeduper();

  for (const item of rawLinks) {
    if (!item.link) continue;
    const decodedEmbed = decodeEmbedUrl(item.link);
    if (!decodedEmbed) continue;
    await addEmbedStreams({
      embed: decodedEmbed,
      epSlug,
      label: "Doramasflix",
      prefix: "dflix",
      denoBase,
      add,
    });
  }

  return { streams };
}
