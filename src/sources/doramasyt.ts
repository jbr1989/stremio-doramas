import { Env } from "../lib/types";
import { CHROME_UA, cleanTitle, decodeEntities, fetchHtml, netFetch } from "../lib/utils";
import { genresFromBadgeBlock } from "../lib/dooplay";
import { fetchWithSlugRescue, resolveEpisodeSlug, searchVariants } from "../lib/slugmap";
import { SourceBase, SourceCard, SourceEpisode } from "../lib/sourceBase";

const DORAMASYT_BASE = "https://www.doramasyt.com";

// DoramasYT emite slugs "titulo(-latino)?-episodio-N"; las demás fuentes exigen
// "titulo-NxM" (guard de doramas.ts y parseSxE de slugmap.ts). Convierte el slug
// propio a la forma canónica para que getStreams pueda hacer el fan-out.
export function canonicalDytSlug(slug: string): string {
  if (/-\d+x\d+$/.test(slug)) return slug;
  const m = slug.match(/^(.*?)-episodio-(\d+)$/i);
  if (!m) return slug;
  return `${m[1]}-1x${parseInt(m[2], 10)}`;
}

async function resolveDytEpisodeSlug(
  epSlug: string,
  env: Env
): Promise<string | null> {
  return resolveEpisodeSlug(
    {
      site: "dyt",
      searchSeries: (title) =>
        (async () => {
          const slugs = new Set<string>();
          for (const v of searchVariants(title)) {
            let html = "";
            try {
              html = await fetchHtml(`${DORAMASYT_BASE}/buscar?q=${encodeURIComponent(v)}`, env);
            } catch {
              html = "";
            }
            for (const m of html.matchAll(/\/dorama\/([a-z0-9-]+)/gi))
              slugs.add(m[1]);
          }
          return [...slugs];
        })(),
      fetchEpisodes: (seriesSlug) =>
        (async () => {
          let html = "";
          try {
            html = await fetchHtml(`${DORAMASYT_BASE}/dorama/${seriesSlug}`, env);
          } catch {
            html = "";
          }
          const ep1Match = html.match(/\/ver\/([a-z0-9-]+-episodio-)1["'\s>]/i);
          const base = ep1Match ? ep1Match[1] : `${seriesSlug.replace(/-sub-espanol$/, "")}-episodio-`;
          const episodes: { s: number; e: number; epSlug: string }[] = [];
          for (let i = 1; i <= 32; i++) {
            episodes.push({ s: 1, e: i, epSlug: `${base}${i}` });
          }
          return episodes;
        })(),
    },
    epSlug,
    env
  );
}

class DoramaYtSource extends SourceBase {
  readonly prefix = "dyt";
  readonly label = "DoramasYT";
  readonly catalogId = "doramasyt";

  // DYT usa "titulo-episodio-N": a la forma canónica "titulo-1xN" para que
  // las demás fuentes (que guardan sobre -\d+x\d+$) acepten el slug.
  override async toEpSlug(rawId: string, _env?: Env): Promise<string> {
    return canonicalDytSlug(rawId.slice(this.prefix.length + 1));
  }

  // ── Streams ──
  protected buildPageUrl(slug: string): string {
    return `${DORAMASYT_BASE}/ver/${slug}`;
  }

  // Tokens data-player de los botones → GET /reproductor?video=token → iframe.
  protected async extractEmbeds(
    html: string,
    slug: string
  ): Promise<string[]> {
    const playerTokens: { token: string; server: string }[] = [];
    for (const m of html.matchAll(
      /<button[^>]*data-player="([^"]+)"[^>]*>(.*?)<\/button>/gi
    )) {
      playerTokens.push({ token: m[1], server: m[2].trim() });
    }
    if (playerTokens.length === 0) return [];

    const embeds = await Promise.all(
      playerTokens.map(async (p) => {
        try {
          const r = await netFetch(
            "direct",
            `${DORAMASYT_BASE}/reproductor?video=${encodeURIComponent(p.token)}`,
            {
              headers: {
                "User-Agent": CHROME_UA,
                Referer: `${DORAMASYT_BASE}/ver/${slug}`,
              },
              signal: AbortSignal.timeout(9000),
            }
          );
          if (!r.ok) return null;
          const pageHtml = await r.text();
          const iframeSrc =
            pageHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1];
          if (!iframeSrc) return null;
          let url = iframeSrc.trim();
          if (url.startsWith("//")) url = `https:${url}`;
          return /^https?:\/\//i.test(url) ? url : null;
        } catch {
          return null;
        }
      })
    );
    return embeds.filter((u): u is string => !!u);
  }

  // El rescate de slug NO es común (SourceBase no lo hace): decisión de
  // esta fuente (su /ver/ es sensible a slugs envejecidos del catálogo).
  protected override async fetchEpisodePage(
    slug: string,
    env: Env
  ): Promise<string> {
    return fetchWithSlugRescue(
      (s) => `${DORAMASYT_BASE}/ver/${s}`,
      slug,
      env,
      (u, e) => this.fetchBody(u, e),
      resolveDytEpisodeSlug,
      this.prefix
    );
  }

  // ── Catálogo ──
  // doramasyt pagina sus archivos (género y directorio) con ?p=N — el
  // /page/N/ da 404 y ?page= redirige a ?p=. (pageSize = 24, el default.)

  protected buildSearchUrl(q: string): string {
    return `${DORAMASYT_BASE}/buscar?q=${encodeURIComponent(q)}`;
  }

  protected buildGenreUrl(gslug: string, page: number): string {
    return page > 1
      ? `${DORAMASYT_BASE}/genero/${gslug}?p=${page}`
      : `${DORAMASYT_BASE}/genero/${gslug}`;
  }

  protected buildListUrl(page: number): string {
    return page > 1 ? `${DORAMASYT_BASE}/doramas?p=${page}` : `${DORAMASYT_BASE}/doramas`;
  }

  // /buscar?q= a veces no encuentra nada server-side: fallback al listado
  // (el filtro local de filterCards recorta a lo relevante). En la base
  // estricta no hay hook de fetch de búsqueda: se absorbe aquí reintentando
  // solo cuando la URL es de búsqueda y la página vino sin tarjetas.
  protected override async fetchBody(url: string, env: Env): Promise<string> {
    const html = await super.fetchBody(url, env);
    if (
      url.startsWith(`${DORAMASYT_BASE}/buscar`) &&
      html &&
      !html.includes("/dorama/")
    ) {
      try {
        return await fetchHtml(`${DORAMASYT_BASE}/doramas`, env);
      } catch {
        return html;
      }
    }
    return html;
  }

  protected parseCards(html: string): SourceCard[] {
    const results: SourceCard[] = [];
    const seen = new Set<string>();

    const push = (slug: string, rawPoster: string, rawName: string) => {
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      const poster = rawPoster.startsWith("http")
        ? rawPoster
        : rawPoster
        ? `${DORAMASYT_BASE}${rawPoster}`
        : "";
      results.push({
        slug,
        name: cleanTitle(rawName) || slug,
        poster,
      });
    };

    for (const m of html.matchAll(
      /\/dorama\/([a-z0-9-]+)"[\s\S]*?data-src="([^"]+)"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi
    )) {
      push(m[1], m[2], m[3].trim());
    }

    for (const m of html.matchAll(
      /\/dorama\/([a-z0-9-]+)"[\s\S]*?alt="Ver\s+([^"]+?)\s+online[\s\S]*?data-src="([^"]+)"/gi
    )) {
      push(m[1], m[3], m[2].trim());
    }

    return results.slice(0, 100);
  }

  // /buscar no filtra server-side: recorte local del resultado (la template
  // de la base ya reintenta con las cards sin filtrar si esto vacía).
  protected override filterCards(
    cards: SourceCard[],
    q: string,
    isSearch: boolean
  ): SourceCard[] {
    if (!isSearch || !q) return cards;
    const lc = q.toLowerCase();
    return cards.filter(
      (c) => c.name.toLowerCase().includes(lc) || c.slug.toLowerCase().includes(lc)
    );
  }

  // ── Meta ──
  protected buildSeriesPageUrl(slug: string): string {
    return `${DORAMASYT_BASE}/dorama/${slug}`;
  }

  // parseMetaBasics → listEpisodes (el hook no recibe poster, lo guardo aquí).
  private sitePoster = "";

  // doramasyt no es DooPlay puro: el <h1> manda sobre og:title, el poster
  // puede venir de data-src /thumbs/imagen/ y la sinopsis de un <p> llano.
  protected override parseMetaBasics(html: string, slug: string) {
    const name =
      cleanTitle(
        html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
          html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] ||
          html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ||
          slug
      ) || slug;

    const poster =
      html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1] ||
      html.match(/data-src=["'](https?:\/\/[^"'\s]+\/thumbs\/imagen\/[^"'\s]+)["']/i)?.[1] ||
      "";

    const description = decodeEntities(
      html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1] ||
        html.match(/<p>([\s\S]*?)<\/p>/i)?.[1] ||
        ""
    )
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return { name, poster: (this.sitePoster = poster), description };
  }

  // Géneros de la ficha: badges del bloque lh-lg (server-rendered, base
  // /genero/ sin slash final). Label canónico (src/genres.ts) o texto del
  // sitio tal cual (dooplay.ts).
  protected override parseGenres(html: string): string[] {
    return genresFromBadgeBlock(html, "genero", "dyt");
  }

  // doramasyt no expone el listado real de episodios (llega por AJAX con
  // sesión): rango sintético 1..epCount a partir del patrón del ep1. El
  // epCount sale de TMDB (24 tiene año; 32 sin match).
  protected override listEpisodes(
    html: string,
    slug: string,
    tmdb: {
      poster?: string;
      background?: string;
      description?: string;
      year?: string;
    } | null
  ): SourceEpisode[] {
    const ep1Match = html.match(/\/ver\/([a-z0-9-]+-episodio-)1["'\s>]/i);
    const baseEpSlug = ep1Match ? ep1Match[1] : `${slug.replace(/-sub-espanol$/, "")}-episodio-`;
    const epCount = tmdb?.year ? 24 : 32;

    const eps: SourceEpisode[] = [];
    for (let i = 1; i <= epCount; i++) {
      eps.push({
        slug: `${baseEpSlug}${i}`,
        s: 1,
        e: i,
        // doramasyt no expone stills por episodio — caemos al póster de la serie.
        thumb: tmdb?.poster || this.sitePoster,
      });
    }
    return eps;
  }

  protected override videoId(ep: SourceEpisode): string {
    return `dyt:${canonicalDytSlug(ep.slug ?? "")}`;
  }
}

export const doramaYtSource = new DoramaYtSource();
