import { Env } from "../lib/types";
import {
  CHROME_UA,
  cleanTitle,
  decodeEntities,
  fetchHtml,
  netFetch,
  fetchTmdb,
} from "../lib/utils";
import { buildSeriesMeta, genresFromBadgeBlock } from "../lib/dooplay";
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

// ── AJAX de episodios (caplist) ─────────────────────────────────────────────
// La ficha server-rendered expone el postId del listado en
// `<section class="caplist" data-ajax="…/ajax/ajax_pagination/{id}">` y el
// `<meta name="csrf-token">`. El AJAX NO requiere login ni "sesión" especial —
// solo el par CSRF-token + cookie de sesión que revela el MISMO GET de la
// ficha (validación Laravel). Verificado contra producción:
//   POST /ajax/caplist/{id}  (X-CSRF-TOKEN + cookie de la ficha, p=N)
//   → {"default":"…/img/capblank.png","caps":[{"episodio":1,"url":
//      "…/ver/{serie}-episodio-1","thumb":"…/thumbs/portada/…"}]}
// caps:[] o página incompleta = fin de la lista. Sin cookies
// responde {"message":"CSRF token mismatch."} y con GET, 405.

/** GET de la ficha capturando la sesión del sitio (Set-Cookie) y el CSRF
 *  token: el par que exige el AJAX de caplist. Sin login real — el token es
 *  session-bound, no post-bound (el de cualquier ficha abrió otra serie). */
async function dytFichaWithCookie(
  url: string,
  env: Env
): Promise<{ html: string; cookie: string; csrf: string }> {
  try {
    const r = await netFetch("dyt-ficha", url, {
      headers: { "User-Agent": CHROME_UA, Referer: `${DORAMASYT_BASE}/` },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return { html: "", cookie: "", csrf: "" };
    const html = await r.text();
    // Headers.getSetCookie(): limpiar los cookie-ovu del challenge de CF y
    // quedarse con name=value de cada cookie (el post solo necesita eso).
    const getter = (r.headers as Headers & { getSetCookie?: () => string[] })
      .getSetCookie?.bind(r.headers);
    const cookie = (getter ? getter() : [])
      .map((c) => c.split(";")[0])
      .filter(Boolean)
      .join("; ");
    const csrf =
      html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i)?.[1] || "";
    return { html, cookie, csrf };
  } catch {
    return { html: "", cookie: "", csrf: "" };
  }
}

/** Caps de un episodio AJAX. Se paginan todas las "páginas" (50/pág) hasta
 *  caps:[] o hasta la página llena (el sitio no expone el total). */
interface DytPageResult {
  /** "…/img/capblank.png" — thumb placeholder: si caps.trumb==default no vale
   *  como still real y se cae al póster de la serie/TMDB. */
  default?: string;
  caps?: { episodio?: number; url?: string; thumb?: string }[];
}
interface DytCap {
  episodio: number;
  slug: string;
  thumb: string;
}
async function dytCapsFromAjax(
  html: string,
  session: { cookie: string; csrf: string; referer: string }
): Promise<DytCap[]> {
  const postId = html.match(
    /data-ajax="[^"]*\/ajax\/ajax_pagination\/(\d+)/i
  )?.[1];
  if (!postId) return [];
  const out: DytCap[] = [];
  const seen = new Set<number>();
  for (let p = 1; p <= 8; p++) {
    let added = 0;
    try {
      const r = await netFetch(
        "dyt-caps",
        `${DORAMASYT_BASE}/ajax/caplist/${postId}`,
        {
          method: "POST",
          headers: {
            "User-Agent": CHROME_UA,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-TOKEN": session.csrf,
            Referer: session.referer,
            Cookie: session.cookie,
          },
          body: `p=${p}`,
          signal: AbortSignal.timeout(9000),
        }
      );
      if (!r.ok) break;
      const data = (await r.json()) as DytPageResult;
      for (const c of data.caps ?? []) {
        const n = c.episodio ?? 0;
        // url real del episodio ("/ver/{serie}-episodio-N"): se acabó
        // adivinar la plantilla base con el regex del ep1 del ficha.
        const slug = (c.url || "").match(/\/ver\/([a-z0-9-]+)\/?$/i)?.[1];
        if (!n || !slug || seen.has(n)) continue;
        seen.add(n);
        out.push({
          episodio: n,
          slug,
          // thumbs/portada: sin thumb válida → cae al poster serie/TMDB.
          thumb: c.thumb && c.thumb !== data.default ? c.thumb : "",
        });
        added++;
      }
      // Página no llena → fin de listado (perpage=50 del AJAX de dyt).
      if (added < 50) break;
    } catch (e) {
      console.log(`[dyt] caplist p=${p} falló: ${e}`);
      break;
    }
  }
  return out;
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

  // ── Fan-out: rescate de slug (slugmap) ──
  // Resuelve el epSlug propio de doramasyt para un epSlug venido de otro
  // sitio (mapping por título, ver slugmap.ts). Búsqueda por /buscar
  // (HTML, slugs /dorama/{slug}/); el listado de episodios va REAL por el
  // AJAX caplist del ficha (misma sesión del GET) — el rango sintético
  // 1..32 solo queda como fallback si el AJAX no responde.
  protected override async resolveEpisodeSlug(
    epSlug: string,
    env: Env
  ): Promise<string | null> {
    return resolveEpisodeSlug(
      {
        site: this.prefix,
        searchSeries: (title) =>
          (async () => {
            const slugs = new Set<string>();
            for (const v of searchVariants(title)) {
              let html = "";
              try {
                html = await fetchHtml(
                  `${DORAMASYT_BASE}/buscar?q=${encodeURIComponent(v)}`,
                  env
                );
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
            const fichaUrl = `${DORAMASYT_BASE}/dorama/${seriesSlug}`;
            const { html, cookie, csrf } = await dytFichaWithCookie(
              fichaUrl,
              env
            );
            if (html && cookie && csrf) {
              const caps = await dytCapsFromAjax(html, {
                cookie,
                csrf,
                referer: fichaUrl,
              });
              if (caps.length > 0) {
                return caps.map((c) => ({
                  s: 1,
                  e: c.episodio,
                  epSlug: c.slug,
                }));
              }
              console.log(
                `[dyt] rescate ${seriesSlug}: caplist vacío — plantilla sintética`
              );
            }
            // Fallback (antes era el camino primario): deduce la plantilla
            // "{serieSlug}-episodio-N" probando 1..32 como su paginador.
            const ep1Match = html.match(
              /\/ver\/([a-z0-9-]+-episodio-)1["'\s>]/i
            );
            const base = ep1Match
              ? ep1Match[1]
              : `${seriesSlug.replace(/-sub-espanol$/, "")}-episodio-`;
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
      (s, e) => this.resolveEpisodeSlug(s, e),
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

  // parseMetaBasics → listEpisodesDyt (el hook no recibe poster, lo guardo aquí).
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

  // getMeta re-implementado para enhebrar la sesión del ficha (CSRF+cookie)
  // hacia el AJAX de episodios por-request, sin estado mutable en el
  // singleton: el par se capturó en el MISMO GET de la ficha que se parsea.
  // (La base no puede: su fetchMetaPage/fetchBody devuelve solo el HTML.)
  override async getMeta(
    id: string,
    tmdbKey: string,
    env?: Env
  ): Promise<{ meta: unknown }> {
    const slug = this.parseId(id);
    const fichaUrl = this.buildSeriesPageUrl!(slug);
    const { html, cookie, csrf } = await dytFichaWithCookie(fichaUrl, env!);
    if (!html) return { meta: null };

    const basics = this.parseMetaBasics(html, slug);
    const gens = this.parseGenres(html);
    const tmdb = basics.name ? await fetchTmdb(basics.name, tmdbKey) : null;

    const rawEps = await this.listEpisodesDyt(html, slug, tmdb, {
      cookie,
      csrf,
      referer: fichaUrl,
    });
    const sorted = [...rawEps].sort((a, b) => a.s - b.s || a.e - b.e);

    return buildSeriesMeta({
      id,
      name: basics.name,
      poster: basics.poster,
      description: basics.description,
      genres: gens,
      tmdb,
      videos: sorted.map((ep) => ({
        id: ep.id ?? this.videoId(ep),
        season: ep.s,
        episode: ep.e,
        thumbnail: ep.thumb,
      })),
    });
  }

  /** Episodios REALES vía el AJAX caplist del ficha (número exacto, slug
   *  real de la URL /ver/ y thumb real por episodio). El rango sintético
   *  1..32 (rango el antiguo primario con epCount por TMDB 24/32) queda SOLO
   *  como fallback con log si el AJAX no respondió. */
  private async listEpisodesDyt(
    html: string,
    slug: string,
    tmdb: {
      poster?: string;
      background?: string;
      description?: string;
      year?: string;
    } | null,
    session: { cookie: string; csrf: string; referer: string }
  ): Promise<SourceEpisode[]> {
    if (session.cookie && session.csrf) {
      const caps = await dytCapsFromAjax(html, session);
      if (caps.length > 0) {
        return caps.map((c) => ({
          slug: c.slug,
          s: 1,
          e: c.episodio,
          thumb: c.thumb || tmdb?.poster || this.sitePoster,
        }));
      }
      console.log(`[dyt] ${slug}: caplist sin caps — fallback sintético`);
    } else {
      console.log(`[dyt] ${slug}: ficha sin sesión (cookie/csrf) — fallback sintético`);
    }

    // Fallback (antes era el camino primario — bug): rango sintético
    // 1..32 desde el patrón del ep1. Solo mientras exista la sintaxis.
    const ep1Match = html.match(/\/ver\/([a-z0-9-]+-episodio-)1["'\s>]/i);
    const baseEpSlug = ep1Match
      ? ep1Match[1]
      : `${slug.replace(/-sub-espanol$/, "")}-episodio-`;
    const eps: SourceEpisode[] = [];
    for (let i = 1; i <= 32; i++) {
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
