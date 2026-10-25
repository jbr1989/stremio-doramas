import { Env } from "../lib/types";
import { cleanTitle, fetchHtml, fetchTmdb } from "../lib/utils";
import {
  buildMovieMeta,
  buildSeriesMeta,
  dooplayEpisodeList,
  genresFromDooPlay,
  ogMetaFromHtml,
} from "../lib/dooplay";
import { fetchWithSlugRescue, resolveEpisodeSlug, searchVariants } from "../lib/slugmap";
import { SourceBase, SourceCard } from "../lib/sourceBase";

const YANDI_BASE = "https://yandispoiler.net";

/** Config de los clones del tema "3-segmentos": yandi y kdramasplay son
 * hermanos (mismo layout, ids {prefix}:{type}:{slug}) que difieren en base
 * y en la torta del archivo de género. */
export interface YandiCfg {
  prefix: string;
  label: string;
  base: string;
  /** Ruta del directorio de series: "series" (ambos). */
  seriesPath: string;
  /** Ruta del player de episodios: "episodios" (ambos). */
  epPath: string;
  /** Ruta del archivo de película: "peliculas" (ambos). */
  moviePath: string;
  /** Base taxonomía de género en el catálogo: "generos" (yandi) /
   * "genero" (kplay). */
  genreBase: string;
}

/** Classe base de los clones theme-3-segmentos (yandi, kdramasplay).
 * Las hijas solo pisan lo genuinamente distinto: player (extractEmbeds),
 * thumbs/grilla de episodios en el meta, parser de cards y rescatador de
 * slug. */
export class YandiSource extends SourceBase {
  constructor(private cfg: YandiCfg) {
    super();
  }

  get prefix() {
    return this.cfg.prefix;
  }
  get label() {
    return this.cfg.label;
  }

  // ── Streams ──
  // Ids de 3 segmentos: "{prefix}:ep:{slug}" / "{prefix}:movie:{slug}". El
  // parseId default deja "ep:{slug}" / "movie:{slug}" — buildPageUrl
  // discrimina el subtipo.
  protected buildPageUrl(idSlug: string): string {
    return idSlug.startsWith("movie:")
      ? `${this.cfg.base}/${this.cfg.moviePath}/${idSlug.slice(6)}/`
      : `${this.cfg.base}/${this.cfg.epPath}/${idSlug.slice(3)}/`;
  }

  // El rescate de slug no es común (la base no lo hace): el catálogo envejece
  // igual que el DooPlay hispano. Solo la rama "ep"; las películas van con
  // fetch directo.
  protected override async fetchEpisodePage(
    idSlug: string,
    env: Env
  ): Promise<string> {
    if (idSlug.startsWith("movie:"))
      return this.fetchBody(this.buildPageUrl(idSlug), env);
    const slug = idSlug.slice(3);
    return fetchWithSlugRescue(
      (s) => `${this.cfg.base}/${this.cfg.epPath}/${s}/`,
      slug,
      env,
      (u, e) => this.fetchBody(u, e),
      (s, e) => this.resolveEpisodeSlug?.(s, e) ?? Promise.resolve(null),
      this.prefix
    );
  }

  /** Rescatador de slug (slugmap). yandi usa el buscador del sitio (default);
   * kplay lo pisa con el REST+nonce de DooPlay. */
  protected async resolveEpisodeSlug(
    epSlug: string,
    env: Env
  ): Promise<string | null> {
    return resolveYandiEpisodeSlug(epSlug, env);
  }

  // Ids de 3 segmentos: quitar "ep:"/"movie:" para los behaviorHints.
  protected override emitSlug(idSlug: string): string {
    return idSlug.replace(/^(?:ep|movie):/, "");
  }

  // Episodio = "ep:slug-1x2" o película = "movie:slug" (1x1). Los ids de
  // serie del catálogo son "series:slug" y no pasan el filtro.
  override isEpisodeId(rawId: string): boolean {
    const idSlug = rawId.slice(this.prefix.length + 1);
    return /^(?:ep:.+-\d+x\d+|movie:.+)$/.test(idSlug);
  }

  // ── Fan-out de streams (registry) ──
  // Id propio → slug canónico compartido entre fuentes. kplay y yandi usan
  // el mismo formato de id (independiente del prefijo: partes[1]), así que
  // kplay lo hereda de aquí. Las películas se representan como 1x1.
  toEpSlug(rawId: string): string {
    const parts = rawId.split(":");
    if (parts[1] === "ep") return parts.slice(2).join(":");
    if (parts[1] === "movie") return `${parts.slice(2).join(":")}-1x1`;
    return parts.slice(1).join(":");
  }

  // Slug canónico → id propio de episodio (fan-out inverso).
  buildId(epSlug: string): string {
    return `${this.prefix}:ep:${epSlug}`;
  }

  // Embeds por defecto del tema: data-url="https://..." del player del
  // episodio (sin fetch extra). Kplay lo pisa (AJAX DooPlay).
  protected async extractEmbeds(
    html: string,
    _slug: string,
    _env?: Env
  ): Promise<string[]> {
    const embeds: string[] = [];
    for (const m of html.matchAll(/data-url=["'](https?:\/\/[^"']+)["']/gi)) {
      const u = m[1].trim();
      if (u && !embeds.includes(u)) embeds.push(u);
    }
    return embeds;
  }

  // ── Catálogo ──
  protected buildSearchUrl(q: string): string {
    return `${this.cfg.base}/?s=${encodeURIComponent(q)}`;
  }

  // Archivo de género SIN paginación upstream (?page=2 repite la página 1):
  // el skip de Stremio se ignora en esta rama.
  protected buildGenreUrl(gslug: string, _page: number): string {
    return `${this.cfg.base}/${this.cfg.genreBase}/${gslug}/`;
  }

  protected buildListUrl(page: number): string {
    return page > 1
      ? `${this.cfg.base}/${this.cfg.seriesPath}/page/${page}/`
      : `${this.cfg.base}/${this.cfg.seriesPath}/`;
  }

  // Ids de 3 segmentos: "{prefix}:{series|movie}:{slug}".
  protected override cardId(entry: SourceCard): string {
    return `${this.prefix}:${entry.type}:${entry.slug}`;
  }

  // El archivo de género mezcla series+películas: solo series. La búsqueda
  // no filtra.
  protected override filterCards(
    cards: SourceCard[],
    _q: string,
    isSearch: boolean
  ): SourceCard[] {
    return isSearch ? cards : cards.filter((c) => c.type !== "movie");
  }

  // Parser de cards del tema (yandi): anchors con data-ptype (dos variantes:
  // img dentro del anchor / img fuera, hasta próximo anchor o item del tema)
  // + variante "sideranking" (poster en data-bg-url ANTES del anchor).
  // Kplay lo pisa con sus 2 regex simples.
  protected parseCards(html: string): SourceCard[] {
    const results: SourceCard[] = [];
    const seen = new Map<string, SourceCard>();
    const push = (
      type: "series" | "movie",
      slug: string,
      rawPoster: string,
      rawName: string
    ) => {
      if (!slug) return;
      const key = `${type}:${slug}`;
      const poster = rawPoster.startsWith("http")
        ? rawPoster
        : rawPoster
        ? `${this.cfg.base}${rawPoster}`
        : "";
      const name = cleanTitle(rawName) || slug;
      const existing = seen.get(key);
      // Fusiona duplicados: la primera aparición gana, pero se completa
      // name/poster si faltan (p. ej. anchor vacío seguido de su <img>).
      if (existing) {
        if (!existing.poster && poster) existing.poster = poster;
        if (existing.name === slug && name !== slug) existing.name = name;
        return;
      }
      const entry = { slug, type, name, poster };
      seen.set(key, entry);
      results.push(entry);
    };

    // Cards del tema Dooplay. Dos variantes:
    //  a) <a href=".../series/<slug>/" data-ptype="tvshows" title="TITULO">
    //       <img class="thumb" alt="TITULO" src="poster.jpg">  (img dentro)
    //     </a>
    //  b) <a href="..." title="TITULO"></a> ... <img data-original poster>(img fuera)
    // En ambas el <img> usa "alt" ANTES de "src" y lazyload "data-src"/"data-original".
    const anchorRe = /<a\s[^>]*href="[^"]*\/(?<dir>series|peliculas)\/(?<slug>[a-z0-9-]+)\/"[^>]*>/gi;
    for (const m of html.matchAll(anchorRe)) {
      const openTag = m[0];
      const idx = m.index ?? 0;
      // Ventana hasta el próximo anchor o item del tema (evita colarse el
      // poster de la card siguiente); el <img> queda dentro de la ventana.
      const nextA = html.indexOf("<a ", idx + openTag.length);
      const nextItem = html.indexOf('<div id="item-', idx + openTag.length);
      const end = Math.min(
        nextA === -1 ? html.length : nextA,
        nextItem === -1 ? html.length : nextItem,
        idx + 1500
      );
      const block = html.slice(idx, end);
      const ptype = (openTag.match(/data-ptype="([^"]*)"/i)?.[1] || "").toLowerCase();
      const type: "series" | "movie" = ptype.startsWith("tv")
        ? "series"
        : ptype === "movie"
        ? "movie"
        : m.groups!.dir.toLowerCase() === "peliculas"
        ? "movie"
        : "series";
      // poster: dentro del atributo del propio anchor o la ventana.
      const poster = (
        block.slice(openTag.length).match(/(?:data-src|data-original|src)="([^"]+)"/i)?.[1] ||
        ""
      ).trim();
      // Variante "sideranking" (trending lateral): el anchor no trae <img> y
      // el poster vive en el <li> contenedor ANTES del anchor (data-bg-url).
      const back = html.slice(Math.max(0, idx - 600), idx);
      const bgPoster = back.match(/data-bg-url="([^"]+)"/i)?.[1] || "";
      const name = (
        openTag.match(/title="([^"]*)"/i)?.[1] ||
        block.match(/alt="([^"]*)"/i)?.[1] ||
        ""
      ).trim();
      push(type, m.groups!.slug, poster || bgPoster, name);
    }

    // Fallback: markup sin data-ptype (img con src antes de alt y link después)
    for (const m of html.matchAll(
      /<img[^>]+(?:data-src|src)="([^"]+)"[^>]*alt="([^"]*)"[\s\S]{0,250}?\/(series|peliculas)\/([a-z0-9-]+)\//gi
    )) {
      const type = m[3].toLowerCase() === "peliculas" ? "movie" : "series";
      push(type, m[4], m[1], m[2]);
    }
    for (const m of html.matchAll(
      /\/(series|peliculas)\/([a-z0-9-]+)\/"[^>]*>[\s\S]{0,100}?<img[^>]+(?:data-src|src)="([^"]+)"[^>]*alt="([^"]*)"/gi
    )) {
      const type = m[1].toLowerCase() === "peliculas" ? "movie" : "series";
      push(type, m[2], m[3], m[4]);
    }
    return results.slice(0, 100);
  }

  // ── Meta ──
  // Thumbs de la grilla de episodios; yandi no tiene → Map vacío (poster).
  // Kplay lo pisa con dooplayEpThumbs (window 220).
  protected episodeThumbs(_html: string): Map<string, string> {
    return new Map();
  }

  // Ids de 3 segmentos y rama movie — sobrecarga completa del template:
  // movie → buildMovieMeta; series → buildSeriesMeta con grilla DooPlay
  // (/{epPath}/{slug}-SxE/) y thumbnail = poster de la ficha (sin stills).
  async getMeta(
    id: string,
    tmdbKey: string,
    env?: Env
  ): Promise<{ meta: unknown }> {
    const parts = id.split(":");
    if (parts.length < 3) return { meta: null };
    const type = parts[1]; // "series" or "movie"
    const slug = parts[2];

    let html = "";
    try {
      html = await fetchHtml(
        type === "movie"
          ? `${this.cfg.base}/${this.cfg.moviePath}/${slug}/`
          : `${this.cfg.base}/${this.cfg.seriesPath}/${slug}/`,
        env
      );
    } catch {
      return { meta: null };
    }
    if (!html) return { meta: null };

    const og = ogMetaFromHtml(html, slug);
    const genres = genresFromDooPlay(html, "genero", this.prefix);
    const tmdb = await fetchTmdb(og.name, tmdbKey);

    if (type === "movie") {
      return buildMovieMeta({
        id,
        slug,
        name: og.name,
        poster: og.poster,
        description: og.description,
        genres,
        tmdb,
      });
    }

    const thumbs = this.episodeThumbs(html);
    return buildSeriesMeta({
      id,
      name: og.name,
      poster: og.poster,
      description: og.description,
      genres,
      tmdb,
      // Sin stills por episodio → poster siempre.
      videos: dooplayEpisodeList(html, this.cfg.epPath).map((ep) => ({
        id: `${this.prefix}:ep:${ep.slug}`,
        season: ep.s,
        episode: ep.e,
        thumbnail: thumbs.get(ep.slug) || og.poster,
      })),
    });
  }
}

async function resolveYandiEpisodeSlug(
  epSlug: string,
  env: Env
): Promise<string | null> {
  return resolveEpisodeSlug(
    {
      site: "yandi",
      searchSeries: async (title) => {
        const variants = searchVariants(title);
        const html = await fetchHtml(
          `${YANDI_BASE}/?s=${encodeURIComponent(variants[0])}`,
          env
        );
        const slugs = [
          ...new Set(
            [...html.matchAll(/\/series\/([a-z0-9-]+)\//gi)].map((m) => m[1])
          ),
        ];
        return slugs;
      },
      fetchEpisodes: async (seriesSlug) => {
        const html = await fetchHtml(
          `${YANDI_BASE}/series/${seriesSlug}/`,
          env
        );
        return dooplayEpisodeList(html, "episodios").map((ep) => ({
          epSlug: ep.slug,
          s: ep.s,
          e: ep.e,
        }));
      },
    },
    epSlug,
    env
  );
}

export const yandiSource = new YandiSource({
  prefix: "yandi",
  label: "Yandispoiler",
  base: YANDI_BASE,
  seriesPath: "series",
  epPath: "episodios",
  moviePath: "peliculas",
  genreBase: "generos",
});

