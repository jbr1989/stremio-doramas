import { Env, MetaPreview } from "../lib/types";
import { genreLabelForMeta, genreSlug } from "../genres";
import { cleanTitle, decodeEntities, denoBaseFromEnv, fetchTmdb, makeStreamDeduper, toMetaPreview } from "../lib/utils";
import { addEmbedStreams } from "../lib/extractors";
import { gqlFetch } from "../lib/gql";
import { resolveEpisodeSlug, searchVariants } from "../lib/slugmap";
import { SourceBase } from "../lib/sourceBase";

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

/** Doramasflix: GraphQL nativa de su backend (sin HTML que raspar) — los
 * tres templates son override completo. La clase aporta identidad + los
 * overrides (el failover de orígenes es el transporte propio). */
class DoramasflixSource extends SourceBase {
  readonly prefix = "dflix";
  readonly label = "Doramasflix";
  readonly catalogId = "doramasflix";

  // No aplican (no hay HTML de episodio que bajar ni embeds de player):
  // los streams van por GraphQL getEpisodeLinks.
  protected buildPageUrl(slug: string): string {
    return slug;
  }

  protected extractEmbeds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // ── Catálogo (override: 3 ramas con queries GraphQL distintas — la
  // búsqueda pagina perPage=20, el género 24 con filter genreSlug, el
  // directorio recupera limit=20*page y corta en memoria) ──
  override async getCatalog(
    extra: Record<string, string>,
    _env?: Env
  ): Promise<{ metas: MetaPreview[] }> {
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
      const data = await gqlFetch(GRAPHQL_ENDPOINT, query, { input: q, page, perPage: 20 }, GQL_ORIGINS);
      const items = data?.searchFullDoramas?.items || [];
      return { metas: items.map(dflixCardMeta) };
    }

    // Género vía la GraphQL nativa del sitio (query paginationDorama — la
    // MISMA que usa su página SSR /generos/{slug}; capturada del tráfico real
    // y validada in-vivo: romance count=1658, drama 2451…). Paginación
    // page/limit con perPage=24 (el valor del sitio). Sort default del
    // backend (_ID_DESC — recientes), igual que el sitio.
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
      const gdata = await gqlFetch(GRAPHQL_ENDPOINT, gqlGenre, {
        page: gpage,
        limit: 24,
        filter: { genreSlug: gslug, isTVShow: false },
      }, GQL_ORIGINS);
      const gitems = gdata?.paginationDorama?.items || [];
      return { metas: gitems.map(dflixCardMeta) };
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
    const data = await gqlFetch(GRAPHQL_ENDPOINT, query, { limit }, GQL_ORIGINS);
    const items = (data?.listDoramas || []).slice((page - 1) * 20, page * 20);
    return { metas: items.map(dflixCardMeta) };
  }

  // ── Meta (override: detailDorama — seasons de la GraphQL, no scraping) ──
  override async getMeta(
    id: string,
    tmdbKey: string
  ): Promise<{ meta: unknown }> {
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
    const data = await gqlFetch(GRAPHQL_ENDPOINT, query, { slug }, GQL_ORIGINS);
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

    const episodes: {
      id: string;
      season: number;
      episode: number;
      title: string;
    }[] = [];
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

  // ── Streams (override completo: GraphQL getEpisodeLinks por episode-id) ──
  override async getStreams(rawId: string, env: Env) {
    const epSlug = rawId.replace("dflix:", "");

    const found = await this.getEpisodeBySlug(epSlug);
    let epId = found?.id || "";
    if (!epId) {
      // Slug venido de otro sitio (o fallo transitorio): resolver por título
      // y recomponer el id dflix (dflix:{serieSlug}-{s}x{e}) para reintentar.
      // El re-intent vale aunque coincida el slug: barato (1 GraphQL) y
      // cubre el caso de la primera query muerta por red.
      const resolved = await this.resolveEpisodeSlug(epSlug, env);
      if (resolved) {
        if (resolved !== epSlug)
          console.log(`[dflix] slug resuelto: ${epSlug} → ${resolved}`);
        const found2 = await this.getEpisodeBySlug(resolved);
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
      const linksData = await gqlFetch(GRAPHQL_ENDPOINT, linksQuery, { episode_id: epId }, GQL_ORIGINS);
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
        env,
      });
    }

    return { streams };
  }

  // ── Fan-out: rescate de slug (slugmap) ──
  // Resuelve el epSlug propio de doramasflix para un epSlug venido de otro
  // sitio (mapping por título, ver slugmap.ts). dflix no tiene HTML que
  // raspar: la búsqueda es su GraphQL `searchFullDoramas` (por nombre, ya
  // existente en el catálogo) y el id del episodio se RECOMPONE
  // aritméticamente con el serieSlug de su BD: sus slugs de episodio siguen
  // el patrón `{serieSlug}-{s}x{e}` (el mismo que genera el meta).
  protected override async resolveEpisodeSlug(
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
        site: this.prefix,
        searchSeries: (title) =>
          (async () => {
            const slugs = new Set<string>();
            for (const v of searchVariants(title)) {
              const data = await gqlFetch(GRAPHQL_ENDPOINT, SEARCH_QUERY, {
                input: v,
                page: 1,
                perPage: 20,
              }, GQL_ORIGINS);
              for (const it of data?.searchFullDoramas?.items || [])
                if (it?.slug) slugs.add(it.slug);
            }
            return [...slugs];
          })(),
        fetchEpisodes: (seriesSlug) =>
          (async () => {
            // detailDorama (query del meta) trae seasons {season_number,
            // number_of_episodes}: de ahí sale el mapa completo SxE → slug
            // con el mismo criterio que el meta usa para sus videos.
            const detail = await this.getMeta(
              `dflix:${seriesSlug}`,
              "" // sin TMDB: solo se necesitan las seasons
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

  /** `_id` + `slug` del episodio por slug sintético ({serieSlug}-{s}x{e}) —
   * o null si el slug no existe en su BD (detailEpisode null) o la GraphQL
   * falla. Null NO distingue not-found de error: el llamador decide si
   * resuelve (via hook) o termina. */
  private async getEpisodeBySlug(
    epSlug: string
  ): Promise<{ id: string; slug: string } | null> {
    try {
      const data = await gqlFetch(GRAPHQL_ENDPOINT, EPISODE_DETAIL_QUERY, { slug: epSlug }, GQL_ORIGINS);
      const ep = data?.detailEpisode;
      return ep?._id ? { id: ep._id, slug: ep.slug } : null;
    } catch {
      return null;
    }
  }
}

// Card de catálogo de cualquier query (searchFullDoramas/paginationDorama/
// listDoramas): poster = TMDB CDN con la propia poster_path del backend; el
// id = "dflix:{slug}" (el guard/base cumple con el fan-out de otros sits
// (aunque este no viene de driver HTML).
function dflixCardMeta(item: any) {
  const poster = item.poster_path
    ? `https://image.tmdb.org/t/p/w342${item.poster_path}`
    : "";
  const name = cleanTitle(item.name || item.name_es || item.slug);
  return toMetaPreview({
    id: `dflix:${item.slug}`,
    name,
    poster,
  });
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

export const doramasflixSource = new DoramasflixSource();
