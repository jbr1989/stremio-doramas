import { Env } from "../lib/types";
import { CHROME_UA, cleanTitle, decodeEntities, netFetch, racerFetch } from "../lib/utils";
import {
  genresFromListItems,
  imgFromTag,
} from "../lib/dooplay";
import { fetchWithSlugRescue, resolveEpisodeSlug, searchVariants } from "../lib/slugmap";
import { SourceBase, SourceCard, SourceEpisode } from "../lib/sourceBase";

const TUDORAMA_BASE = "https://tudorama.com";
const TUDORAMA_LABEL = "TuDorama";
const TUDORAMA_PREFIX = "tudorama";

/** TuDorama (tema propio "corvus", no DooPlay): mismo esqueleto de la base
 * con overrides — racer propio (minLen 300), player vía AJAX corvus + CDN
 * wrappers, meses SxE con sufijo `-s1x4`, meta/genre con taxonomía propia. */
class TudoramaSource extends SourceBase {
  readonly prefix = TUDORAMA_PREFIX;
  readonly label = TUDORAMA_LABEL;
  readonly catalogId = "tudorama";

  // ── Streams ──
  // Racer (direct vs relay Deno, minLen 300) de esta familia de sitios.
  protected override async fetchBody(url: string, env: Env): Promise<string> {
    try {
      return await racerFetch(url, env, { minLen: 300, proxyTimeoutMs: 12000 });
    } catch {
      return "";
    }
  }

  // El catálogo de yandi/stremio emite "-1x4" canónico; el sitio nombra sus
  // páginas "-s1x4" — buildPageUrl normaliza los formatos (-1x[2] ↔ -s1x2).
  protected buildPageUrl(epSlug: string): string {
    const sxe = epSlug.match(/-(?:s)?(\d+)x(\d+)$/i);
    const pageSlug = sxe
      ? `${epSlug.replace(/-(?:s)?\d+x\d+$/i, "")}-s${sxe[1]}x${sxe[2]}`
      : epSlug;
    return `${TUDORAMA_BASE}/ver/${pageSlug}/`;
  }

  // Ficha de serie: /serie/{slug}/ (el listado de episodios vive ahí).
  protected buildSeriesPageUrl(slug: string): string {
    return `${TUDORAMA_BASE}/serie/${slug}/`;
  }

  // Rescate propio: resolveTudoramaEpisodeSlug devuelve el epSlug en el
  // formato del propio sitio; urlFor (buildPageUrl) re-normaliza a la vez.
  protected override async fetchEpisodePage(
    slug: string,
    env: Env
  ): Promise<string> {
    return fetchWithSlugRescue(
      (s) => this.buildPageUrl(s),
      slug,
      env,
      (u, e) => this.fetchBody(u, e),
      (s, e) => resolveTudoramaEpisodeSlug(s, e),
      this.prefix
    );
  }

  // Player tema corvus: data-id + data-nonce → POST admin-ajax
  // (action=corvus_get_servers) → [{url, name, type}] — y si el AJAX no trae
  // nada, scrape de los cdn.tudorama.com/stream/ links del HTML (aún
  // wrappers con iframe → se resuelve embed dentro de este hook).
  protected async extractEmbeds(
    html: string,
    slug: string,
    _env?: Env
  ): Promise<string[]> {
    const postId = html.match(/data-id=["'](\d+)["']/i)?.[1];
    const nonce = html.match(/data-nonce=["']([a-z0-9]+)["']/i)?.[1];

    let serverItems: { url: string; name: string; type: string }[] = [];

    if (postId && nonce) {
      try {
        const res = await netFetch(
          "direct",
          `${TUDORAMA_BASE}/wp-admin/admin-ajax.php`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "User-Agent": CHROME_UA,
              // Referer de la página del episodio con el formato adecuado.
              Referer: this.buildPageUrl(slug),
            },
            body: `action=corvus_get_servers&post_id=${encodeURIComponent(
              postId
            )}&nonce=${encodeURIComponent(nonce)}`,
            signal: AbortSignal.timeout(9000),
          }
        );
        if (res.ok) {
          const data: any = await res.json();
          if (Array.isArray(data)) {
            serverItems = data.map((item) => ({
              url: item.url || item.link || "",
              name: item.name || item.server || "server",
              type: item.type || "embed",
            }));
          }
        }
      } catch {
        // ignore
      }
    }

    // Fallback: si AJAX no devolvió nada, scrape de links en el HTML
    if (serverItems.length === 0) {
      for (const m of html.matchAll(
        /https?:\/\/cdn\.tudorama\.com\/stream\/[^\s"']+/gi
      )) {
        serverItems.push({ url: m[0], name: "server", type: "embed" });
      }
    }

    // Wrappers cdn.tudorama.com/stream/ → resolve iframe.src real
    const resolvedEmbeds = await Promise.all(
      serverItems.map(async (item) => {
        let embedUrl = item.url;
        if (embedUrl.includes("cdn.tudorama.com/stream/")) {
          try {
            const r = await netFetch("direct", embedUrl, {
              headers: {
                Referer: `${TUDORAMA_BASE}/`,
                "User-Agent": CHROME_UA,
              },
              signal: AbortSignal.timeout(8000),
            });
            const pageHtml = await r.text();
            const iframeSrc =
              pageHtml.match(/iframe\.src\s*=\s*["']([^"']+)["']/i)?.[1] ||
              pageHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1];
            if (iframeSrc) embedUrl = iframeSrc;
          } catch {
            // keep original
          }
        }
        return { ...item, embedUrl };
      })
    );

    hostByName.clear();
    for (const item of resolvedEmbeds) {
      if (item.embedUrl) hostByName.set(item.embedUrl, item.name);
    }
    return resolvedEmbeds.map((item) => item.embedUrl).filter(Boolean);
  }

  // hostFallback del título external: nombre del server tema corvus.
  protected override hostFor(embed: string): string | undefined {
    return hostByName.get(embed);
  }

  // ── Catálogo ──
  protected buildSearchUrl(q: string): string {
    return `${TUDORAMA_BASE}/?s=${encodeURIComponent(q)}`;
  }

  // Archivo /genres/{slug}/ — es la base que el propio sitio usa en sus
  // fichas (su directorio vive en /genero/series/, distinta taxonomía) —
  // paginado con /page/N/.
  protected buildGenreUrl(gslug: string, page: number): string {
    return page > 1
      ? `${TUDORAMA_BASE}/genres/${gslug}/page/${page}/`
      : `${TUDORAMA_BASE}/genres/${gslug}/`;
  }

  // Directorio: archive /genero/series/ (NO /serie/ — verificado in-vivo).
  protected buildListUrl(page: number): string {
    return page > 1
      ? `${TUDORAMA_BASE}/genero/series/page/${page}/`
      : `${TUDORAMA_BASE}/genero/series/`;
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
        ? `${TUDORAMA_BASE}${rawPoster}`
        : "";
      results.push({
        slug,
        type: "series",
        name: cleanTitle(rawName) || slug,
        poster,
      });
    };

    // <article> ... <a href="/serie/{slug}/"> <img src ... alt="{title}">
    for (const m of html.matchAll(
      /href=["'](?:https?:\/\/tudorama\.com)?\/serie\/([a-z0-9-]+)\/["'][^>]*>[\s\S]{0,300}?<img[^>]+(?:data-src|src)=["']([^"']+)["'][^>]*alt=["']([^"']*)["']/gi
    )) {
      push(m[1], m[2], m[3]);
    }
    // Orden alternativo en el HTML
    for (const m of html.matchAll(
      /<img[^>]+(?:data-src|src)=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][\s\S]{0,300}?href=["'](?:https?:\/\/tudorama\.com)?\/serie\/([a-z0-9-]+)\/["']/gi
    )) {
      push(m[3], m[1], m[2]);
    }

    return results.slice(0, 100);
  }

  // ── Meta ──
  private sitePoster = "";

  // Tema propio: og:title → <h1> → <title>; og:image → <picture> img;
  // og:description → p.hero__overview.
  protected override parseMetaBasics(html: string, slug: string) {
    const name =
      cleanTitle(
        html.match(/<meta[^>]+property="og:title"[^>]+content=["']([^"']+)["']/i)?.[1] ||
          html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
          html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ||
          slug
      ) || slug;

    const poster =
      html.match(/<meta[^>]+property="og:image"[^>]+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/<picture[^>]*>\s*<img[^>]+(?:data-src|src)=["']([^"']+)["']/i)?.[1] ||
      "";

    const description = decodeEntities(
      html.match(/<meta[^>]+property="og:description"[^>]+content=["']([^"']+)["']/i)?.[1] ||
        html.match(/<p[^>]+class=["']hero__overview["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ||
        ""
    )
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return { name, poster: (this.sitePoster = poster), description };
  }

  // Géneros de la ficha: <li><a href="…/genres/{slug}/"> del sitio (las
  // anclas sueltas son géneros de las cards "similares" — excluidas por
  // exigir <li>; verificado in-vivo 3 vs 20). Label canónico (src/genres.ts)
  // o texto del sitio tal cual (dooplay.ts).
  protected override parseGenres(html: string): string[] {
    return genresFromListItems(html, "genres", TUDORAMA_PREFIX);
  }

  // Grilles d'épisodes: /ver/{seriesSlug}-s{S}x{E}/; fallback /ver/{slug}
  // suelto parseando el SxE del propio slug. Thumbs <div="lep__thumbnail">
  // precede al href (task ≤ 420; imgFromTag del tema).
  protected override listEpisodes(
    html: string,
    _slug: string
  ): SourceEpisode[] {
    const episodes: { slug: string; s: number; e: number }[] = [];
    const seen = new Set<string>();

    for (const m of html.matchAll(/\/ver\/([a-z0-9-]+)-s(\d+)x(\d+)\/?/gi)) {
      const epKey = `${m[1]}-s${m[2]}x${m[3]}`;
      if (seen.has(epKey)) continue;
      seen.add(epKey);
      episodes.push({
        slug: epKey,
        s: parseInt(m[2], 10),
        e: parseInt(m[3], 10),
      });
    }

    // Secondary regex fallback for /ver/{slug}/
    if (episodes.length === 0) {
      for (const m of html.matchAll(/\/ver\/([a-z0-9-]+)\/?/gi)) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        const sxeM = m[1].match(/-s?(\d+)x(\d+)$/i);
        const s = sxeM ? parseInt(sxeM[1], 10) : 1;
        const e = sxeM ? parseInt(sxeM[2], 10) : 1;
        episodes.push({ slug: m[1], s, e });
      }
    }

    // Thumbs <div="lep__thumbnail"> precede al href (window 420; imgFromTag
    // preferencia data-src + nunca "data:").
    const thumbs = new Map<string, string>();
    const pushThumb = (epSlug: string, raw: string) => {
      if (thumbs.has(epSlug)) return;
      const thumb = raw.startsWith("http")
        ? raw
        : raw.startsWith("//")
        ? `https:${raw}`
        : raw.startsWith("/")
        ? `${TUDORAMA_BASE}${raw}`
        : "";
      if (thumb) thumbs.set(epSlug, thumb);
    };
    for (const m of html.matchAll(
      /<img\b([^>]*)>[\s\S]{0,420}?href=["'](?:https?:\/\/tudorama\.com)?\/ver\/([a-z0-9-]+)-s(\d+)x(\d+)\/["']/gi
    )) {
      const raw = imgFromTag(m[1]);
      if (raw) pushThumb(`${m[2]}-s${m[3]}x${m[4]}`, raw);
    }

    return episodes.map((ep) => ({
      slug: ep.slug,
      s: ep.s,
      e: ep.e,
      thumb: thumbs.get(ep.slug) || this.sitePoster,
    }));
  }

  // video id canónico: el sitio emite "-s1x4", el resto del addon "-1x4".
  protected override videoId(ep: SourceEpisode): string {
    return `${TUDORAMA_PREFIX}:${(ep.slug ?? "").replace(
      /-s(\d+)x(\d+)$/,
      "-$1x$2"
    )}`;
  }
}

// (la firma de extractEmbeds/hostFor es por-embed; el nombre se conoce solo
// dentro del AJAX del episodio).
const hostByName = new Map<string, string>();

async function resolveTudoramaEpisodeSlug(
  epSlug: string,
  env: Env
): Promise<string | null> {
  return resolveEpisodeSlug(
    {
      site: TUDORAMA_PREFIX,
      searchSeries: async (title) => {
        const slugs = new Set<string>();
        for (const v of searchVariants(title)) {
          const html = await racerFetch(
            `${TUDORAMA_BASE}/?s=${encodeURIComponent(v)}`,
            env,
            { minLen: 300, proxyTimeoutMs: 12000 }
          );
          for (const m of html.matchAll(/\/serie\/([a-z0-9-]+)\//gi)) {
            slugs.add(m[1]);
          }
        }
        return [...slugs];
      },
      fetchEpisodes: async (seriesSlug) => {
        const html = await racerFetch(
          `${TUDORAMA_BASE}/serie/${seriesSlug}/`,
          env,
          { minLen: 300, proxyTimeoutMs: 12000 }
        );
        const episodes: { s: number; e: number; epSlug: string }[] = [];
        const seen = new Set<string>();
        for (const m of html.matchAll(
          /\/ver\/([a-z0-9-]+)-s(\d+)x(\d+)\/?/gi
        )) {
          const rawSlug = `${m[1]}-s${m[2]}x${m[3]}`;
          if (seen.has(rawSlug)) continue;
          seen.add(rawSlug);
          episodes.push({
            epSlug: `${m[1]}-1x${m[3]}`,
            s: parseInt(m[2], 10),
            e: parseInt(m[3], 10),
          });
        }
        return episodes;
      },
    },
    epSlug,
    env
  );
}

export const tudoramaSource = new TudoramaSource();
