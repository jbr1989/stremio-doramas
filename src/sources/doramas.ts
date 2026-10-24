import { Env } from "../types";
import { cleanTitle, racerFetch } from "../utils";
import {
  dooPlayerAjaxEmbed,
  dooplayEpisodeList,
  dooplayEpThumbs,
  genresFromDooPlay,
  ogMetaFromHtml,
} from "./dooplay";
import { fetchWithSlugRescue, resolveEpisodeSlug, searchVariants } from "./slugmap";
import { SourceBase, SourceCard, SourceEpisode } from "./sourceBase";

interface DoramaSource {
  prefix: string;
  base: string;
  label: string;
  /** Base del archivo de género del sitio: "genero" (doramaslat) o "genre"
   * (doramedplay). Consultas: {base}/{genreBase}/{slug}/page/N/. */
  genreBase: string;
}

export const DORAMA_SOURCES: Record<string, DoramaSource> = {
  dlat: {
    prefix: "dlat",
    base: "https://doramaslat.com",
    label: "Doramas Latino",
    genreBase: "genero",
  },
  dplay: {
    prefix: "dplay",
    base: "https://doramedplay.net",
    label: "Doramed Play",
    genreBase: "genre",
  },
};

/** Una clase, dos sitios: dlat y dplay comparten scraper/tema DooPlay y solo
 * cambian base/label/genreBase (config DoramaSource). */
class DoramaDooPlaySource extends SourceBase {
  constructor(private cfg: DoramaSource) {
    super();
  }

  get prefix() {
    return this.cfg.prefix;
  }
  get label() {
    return this.cfg.label;
  }

  private get base() {
    return this.cfg.base;
  }

  // ── Streams ──
  // El racer (direct vs relay Deno, minLen 400) es de esta familia de sitios.
  protected override async fetchPage(url: string, env: Env): Promise<string> {
    try {
      return await racerFetch(url, env, { minLen: 400, proxyTimeoutMs: 12000 });
    } catch {
      return "";
    }
  }

  // Guard DooPlay: emite slugs "-1x2" canónicos; sin ese sufijo (id traído de
  // otro sitio con formato distinto) no tiene sentido gastar un fetch.
  protected override async fetchEpisodePage(
    slug: string,
    env: Env
  ): Promise<string> {
    if (!/-\d+x\d+$/.test(slug)) return "";
    return fetchWithSlugRescue(
      (s) => `${this.base}/episodes/${s}/`,
      slug,
      env,
      (u, e) => this.fetchPage(u, e),
      (s, e) => resolveDooPlayEpisodeSlug(this.cfg, s, e),
      this.prefix
    );
  }

  protected buildPageUrl(slug: string): string {
    return `${this.base}/episodes/${slug}/`;
  }

  // Player DooPlay: <li dooplay_player_option data-post/nume/type> →
  // doo_player_ajax → embed URL.
  protected async extractEmbeds(
    html: string,
    _slug: string,
    _env?: Env
  ): Promise<string[]> {
    const options: { post: string; nume: string; type: string }[] = [];
    for (const li of html.matchAll(/<li[^>]*dooplay_player_option[^>]*>/gi)) {
      const tag = li[0];
      const post = tag.match(/data-post=["']([^"']+)["']/i)?.[1];
      const nume = tag.match(/data-nume=["']([^"']+)["']/i)?.[1];
      const type = tag.match(/data-type=["']([^"']+)["']/i)?.[1] || "tv";
      if (post && nume) options.push({ post, nume, type });
    }
    if (options.length === 0) return [];

    const embeds = await Promise.all(
      options.map((o) => dooPlayerAjaxEmbed(this.base, o.post, o.nume, o.type))
    );
    return embeds.filter((u): u is string => !!u);
  }

  // ── Catálogo ──
  // Página por skip: mismo divisor 45 que el catálogo /tvshows/ (alldoramas
  // declara page:45). El archivo real pagina 60 posts/página mezclados, así
  // que la granularidad del skip es aproximada — aceptable: Stremio tolera
  // páginas de largo variable y parciales.
  protected get pageSize(): number {
    return 45;
  }

  protected buildSearchUrl(q: string): string {
    return `${this.base}/?s=${encodeURIComponent(q)}`;
  }

  protected buildGenreUrl(gslug: string, page: number): string {
    return page > 1
      ? `${this.base}/${this.cfg.genreBase}/${gslug}/page/${page}/`
      : `${this.base}/${this.cfg.genreBase}/${gslug}/`;
  }

  protected buildListUrl(page: number): string {
    return page > 1
      ? `${this.base}/tvshows/page/${page}/`
      : `${this.base}/tvshows/`;
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
        ? `${this.base}${rawPoster}`
        : "";
      results.push({
        slug,
        name: cleanTitle(rawName) || slug,
        poster,
      });
    };
    for (const m of html.matchAll(
      /<img[^>]+(?:data-src|src)="([^"]+)"[^>]*alt="([^"]*)"[\s\S]{0,220}?\/tvshows\/([a-z0-9-]+)\//gi
    )) {
      push(m[3], m[1], m[2]);
    }
    for (const m of html.matchAll(
      /\/tvshows\/([a-z0-9-]+)\/"[^>]*>[\s\S]{0,80}?<img[^>]+(?:data-src|src)="([^"]+)"[^>]*alt="([^"]*)"/gi
    )) {
      push(m[1], m[2], m[3]);
    }
    return results.slice(0, 100);
  }

  // ── Meta ──
  private sitePoster = "";

  // ogMetaFromHtml (default de la base) ya matchea el OpenGraph de estos
  // sitios; solo capturamos el poster para el fallback thumb de episodios.
  protected override parseMetaBasics(html: string, slug: string) {
    const og = ogMetaFromHtml(html, slug);
    this.sitePoster = og.poster;
    return og;
  }

  // Géneros de la ficha: bloque sgeneros del tema (server-rendered, cada
  // sitio linkea su propia base: "genero"/"genre" — ver DoramaSource). Label
  // canónico (src/genres.ts) o texto del sitio tal cual (dooplay.ts).
  protected override parseGenres(html: string): string[] {
    return genresFromDooPlay(html, this.cfg.genreBase, this.prefix);
  }

  // Grilla DooPlay: episodios /episodes/{slug}-SxE/ con thumbs de la grilla
  // (dooplayEpisodeList + dooplayEpThumbs — antes copiado inline aquí).
  protected override listEpisodes(
    html: string,
    _slug: string,
    tmdb: { poster?: string } | null
  ): SourceEpisode[] {
    const thumbs = dooplayEpThumbs(html, this.base, "episodes", 220);
    return dooplayEpisodeList(html, "episodes").map((ep) => ({
      slug: ep.slug,
      s: ep.s,
      e: ep.e,
      thumb: thumbs.get(ep.slug) || tmdb?.poster || this.sitePoster,
    }));
  }
}

/** Resuelve el epSlug propio de un sitio DooPlay (dlat=doramaslat, dplay=
 * doramedplay) para un epSlug venido de otro sitio (mapping por título, ver
 * slugmap.ts). Antes solo dplay resolvía; hoy AMBOS participan: cuando el id
 * llega con prefijo kplay/dflix/dplay, doramaslat también busca su propio
 * slug de episodio en vez de 404-ear en silencio. */
async function resolveDooPlayEpisodeSlug(
  src: DoramaSource,
  epSlug: string,
  env: Env
): Promise<string | null> {
  return resolveEpisodeSlug(
    {
      site: src.prefix,
      searchSeries: (title) =>
        (async () => {
          const slugs = new Set<string>();
          // El LIKE de WP matchea por frase: la frase completa a veces no está
          // literalmente en el título del sitio — prueba además las 2 primeras
          // palabras significativas ("light shop" → "light-shop-subtitulado").
          for (const v of searchVariants(title)) {
            const html = await racerFetch(
              `${src.base}/?s=${encodeURIComponent(v)}`,
              env,
              { minLen: 400, proxyTimeoutMs: 12000 }
            );
            for (const m of html.matchAll(/\/tvshows\/([a-z0-9-]+)\//gi))
              slugs.add(m[1]);
          }
          return [...slugs];
        })(),
      fetchEpisodes: (seriesSlug) =>
        (async () => {
          const html = await racerFetch(
            `${src.base}/tvshows/${seriesSlug}/`,
            env,
            { minLen: 400, proxyTimeoutMs: 12000 }
          );
          const episodes: { s: number; e: number; epSlug: string }[] = [];
          const seen = new Set<string>();
          for (const m of html.matchAll(
            /\/episodes\/([a-z0-9-]+-(\d+)x(\d+))\/?/gi
          )) {
            if (seen.has(m[1])) continue;
            seen.add(m[1]);
            episodes.push({
              epSlug: m[1],
              s: parseInt(m[2], 10),
              e: parseInt(m[3], 10),
            });
          }
          return episodes;
        })(),
    },
    epSlug,
    env
  );
}

// Una clase, dos instancias.
const dlatSource = new DoramaDooPlaySource(DORAMA_SOURCES.dlat);
const dplaySource = new DoramaDooPlaySource(DORAMA_SOURCES.dplay);

// Wrappers con las firmas históricas (registry.ts y alldoramas.ts discrepan
// el src por parámetro; index.ts las sigue tal cual).
export async function getDoramaCatalog(
  src: DoramaSource,
  extra: Record<string, string>,
  env?: Env
) {
  return (src.prefix === "dlat" ? dlatSource : dplaySource).getCatalog(
    extra,
    env
  );
}

export async function getDoramaMeta(
  src: DoramaSource,
  id: string,
  tmdbKey: string,
  env?: Env
) {
  return (src.prefix === "dlat" ? dlatSource : dplaySource).getMeta(
    id,
    tmdbKey,
    env
  );
}

export async function getDoramaStreams(
  src: DoramaSource,
  rawId: string,
  env: Env
) {
  return (src.prefix === "dlat" ? dlatSource : dplaySource).getStreams(
    rawId,
    env
  );
}
