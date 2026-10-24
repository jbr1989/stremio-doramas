import { Env, MetaPreview } from "../types";
import {
  denoBaseFromEnv,
  fetchHtml,
  fetchTmdb,
  makeStreamDeduper,
  toMetaPreview,
} from "../utils";
import { genreSlug } from "../genres";
import { buildSeriesMeta, ogMetaFromHtml } from "./dooplay";
import { addEmbedStreams } from "../extractors";

/** Tarjeta de catálogo del hook parseCards. El id completo lo arma la base
 * con `cardId(entry)` ("{prefix}:{slug}", con hook para ids de 3 segmentos). */
export interface SourceCard {
  slug: string;
  name: string;
  poster: string;
  /** "series" | "movie" — lo usan los filtros y los ids de 3 segmentos. */
  type?: string;
}

/** Episodio del hook listEpisodes: con slug (scraping, feed) o id (API). */
export interface SourceEpisode {
  id?: string;
  slug?: string;
  s: number;
  e: number;
  thumb?: string;
}

/** Info TMDB que usa el ensamblado del meta (retorno de fetchTmdb). */
type TmdbInfo = NonNullable<Awaited<ReturnType<typeof fetchTmdb>>>;

/**
 * Clase base de fuente (patrón Template Method) alineada al protocolo
 * Stremio: cada fuente implementa SOLO su traducción del sitio a los tres
 * endpoints del addon (catalog → {metas}, meta → {meta}, stream → {streams}).
 *
 *   getCatalog: ramas search → genre → page. Obligatorios: buildListUrl +
 *               parseCards. Opcionales: buildSearchUrl, buildGenreUrl,
 *               filterCards, pageSize, cardId.
 *
 *   getMeta:    ficha → basics → genres → TMDB → episodios → ensamblado
 *               (buildSeriesMeta). Obligatorios: buildSeriesPageUrl +
 *               listEpisodes. Opcionales: parseMetaBasics, parseGenres,
 *               fetchMetaPage, videoId. Ramas movie (kplay/yandi):
 *               la subclase sobrecarga getMeta entero con buildMovieMeta.
 *
 *   getStreams: página de episodio → embeds → addEmbedStreams con dedupe.
 *               Obligatorios: buildPageUrl + extractEmbeds. Opcionales:
 *               parseId, fetchBody, fetchEpisodePage (rescate/racer).
 *
 * Ver doramas.ts / kdramasplay.ts / etc. (migración pendiente).
 */
export abstract class SourceBase {
  /** Prefijo de id (idPrefix del manifest) p. ej. "kplay". */
  abstract get prefix(): string;

  /** Nombre visible en streams/cards ("KDramas Play"). */
  abstract get label(): string;

  // ─────────────────────────────────────────────────────────────────────────
  // getStreams — GET /stream/{type}/{id}.json → { streams }
  // ─────────────────────────────────────────────────────────────────────────

  /** Parseo del id de video → slug de página. Default: quitar "{prefix}:". */
  protected parseId(rawId: string): string {
    return rawId.slice(this.prefix.length + 1);
  }

  /** Fetch genérico de página (default fetchHtml; sobrecargar si la fuente
   * tiene fetcher propio — racer, GraphQL, bootstrapData…). */
  protected async fetchBody(url: string, env: Env): Promise<string> {
    try {
      return await fetchHtml(url, env);
    } catch {
      return "";
    }
  }

  /**
   * Fetch del HTML de la página del episodio. Default: buildPageUrl +
   * fetchBody (un solo intento). El rescate de slug NO es universal
   * (kisskh/pandrama/doramasflix no descargan una página de episodio):
   * las fuentes que lo necesitan lo implementan aquí con el helper
   * fetchWithSlugRescue (slugmap.ts).
   */
  protected async fetchEpisodePage(slug: string, env: Env): Promise<string> {
    return this.fetchBody(this.buildPageUrl(slug), env);
  }

  /** Dónde vive el player del episodio. */
  protected abstract buildPageUrl(slug: string): string;

  /** Slug limpio para los behaviorHints (filename). Las fuentes con ids de
   * 3 segmentos ("yandi:ep:x" → parseId deja "ep:x") lo limpian aquí. */
  protected emitSlug(slug: string): string {
    return slug;
  }

  // hostFallback del título external de addEmbedStreams (único consumidor:
  // tudorama pasa el nombre del server del tema corvus). Sin hook = sin hint.
  protected hostFor?(embed: string): string | undefined;

  /** Cómo leer los embeds del player (AJAX DooPlay, data-url, tokens…). */
  protected abstract extractEmbeds(
    html: string,
    slug: string,
    env?: Env
  ): Promise<string[]>;

  async getStreams(rawId: string, env: Env): Promise<{ streams: unknown[] }> {
    const slug = this.parseId(rawId);
    const html = await this.fetchEpisodePage(slug, env);
    if (!html) return { streams: [] };

    const denoBase = denoBaseFromEnv(env);
    const { add, streams } = makeStreamDeduper();
    for (const embed of await this.extractEmbeds(html, slug, env)) {
      if (!embed) continue;
      await addEmbedStreams({
        embed,
        epSlug: this.emitSlug(slug),
        label: this.label,
        prefix: this.prefix,
        denoBase,
        add,
        hostFallback: this.hostFor?.(embed),
        env,
      });
    }
    return { streams };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getCatalog — GET /catalog/{type}/{prefix}/{extra}.json → { metas }
  // ─────────────────────────────────────────────────────────────────────────

  /** Tamaño de página upstream (skip de Stremio ÷ pageSize + 1). */
  protected get pageSize(): number {
    return 24;
  }

  protected pageFromSkip(skip?: string): number {
    return Math.floor(parseInt(skip || "0", 10) / this.pageSize) + 1;
  }

  protected buildSearchUrl?(q: string): string;

  /** Archivo de género; sin hook = la fuente no soporta géneros. */
  protected buildGenreUrl?(gslug: string, page: number): string;

  /** Dónde está el listado de series (rama page; el directorio por defecto). */
  protected buildListUrl?(page: number): string;

  /** Cómo leer tarjetas del HTML/JSON de cualquier página de catálogo. */
  protected parseCards?(data: string | unknown): SourceCard[];

  /** id de catálogo de una tarjeta. Default: "{prefix}:{slug}". */
  protected cardId(entry: SourceCard): string {
    return `${this.prefix}:${entry.slug}`;
  }

  /** Filtrado post-página (fallback local de search, ajuste sólo-series). */
  protected filterCards?(
    cards: SourceCard[],
    q: string,
    isSearch: boolean
  ): SourceCard[];

  async getCatalog(
    extra: Record<string, string>,
    env?: Env
  ): Promise<{ metas: MetaPreview[] }> {
    const toMetas = (cards: SourceCard[]) =>
      cards.map((c) =>
        toMetaPreview({ id: this.cardId(c), name: c.name, poster: c.poster })
      );

    const q = (extra.search || "").trim();
    if (q) {
      if (!this.buildSearchUrl || !this.parseCards) return { metas: [] };
      const cards = this.parseCards(
        await this.fetchBody(this.buildSearchUrl(q), env!)
      );
      const filtered = this.filterCards
        ? this.filterCards(cards, q, true)
        : cards;
      return { metas: toMetas(filtered.length > 0 ? filtered : cards) };
    }

    const g = (extra.genre || "").trim();
    if (g) {
      // Label ES → slug con la lista maestra canónica (src/genres.ts).
      const gslug = genreSlug(this.prefix, g);
      if (!gslug || !this.buildGenreUrl || !this.parseCards)
        return { metas: [] };
      const gurl = this.buildGenreUrl(gslug, this.pageFromSkip(extra.skip));
      if (!gurl) return { metas: [] };
      const cards = this.parseCards(await this.fetchBody(gurl, env!));
      return {
        metas: toMetas(
          this.filterCards ? this.filterCards(cards, "", false) : cards
        ),
      };
    }

    if (!this.buildListUrl || !this.parseCards) return { metas: [] };
    const cards = this.parseCards(
      await this.fetchBody(
        this.buildListUrl(this.pageFromSkip(extra.skip)),
        env!
      )
    );
    return { metas: toMetas(cards) };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getMeta — GET /meta/{type}/{id}.json → { meta: MetaDetail | null }
  // (solo series; las ramas movie sobrecargan getMeta con buildMovieMeta)
  // ─────────────────────────────────────────────────────────────────────────

  /** Dónde vive la ficha de la serie. */
  protected buildSeriesPageUrl?(slug: string): string;

  /** Fetch de la ficha. Default: buildSeriesPageUrl + fetchBody (HTML);
   * fuentes JSON (kisskh, feeds Blogger) lo sobrecargan. */
  protected async fetchMetaPage(
    slug: string,
    env?: Env
  ): Promise<string | unknown> {
    return this.buildSeriesPageUrl
      ? this.fetchBody(this.buildSeriesPageUrl(slug), env!)
      : "";
  }

  /** name/poster/description. Default: ogMetaFromHtml (sitios DooPlay). */
  protected parseMetaBasics?(
    data: string | unknown,
    slug: string
  ): { name: string; poster: string; description: string };

  /** Géneros de la ficha. Default: []. */
  protected parseGenres?(data: string | unknown): string[];

  /** Episodios (scraping real, API, feed o rango sintético).
   * Recibe el TMDB ya buscado (dyt/pandrama derivan de él el epCount) y el
   * env (dsub hace fetch de feeds aquí). */
  protected listEpisodes?(
    data: string | unknown,
    slug: string,
    tmdb: TmdbInfo | null,
    env?: Env
  ): Promise<SourceEpisode[]> | SourceEpisode[];

  /** id del video de un episodio. Default: "{prefix}:{slug o id}". */
  protected videoId(ep: SourceEpisode): string {
    return `${this.prefix}:${ep.id ?? ep.slug ?? ""}`;
  }

  async getMeta(
    id: string,
    tmdbKey: string,
    env?: Env
  ): Promise<{ meta: unknown }> {
    const slug = this.parseId(id);
    const data = await this.fetchMetaPage(slug, env);
    if (!data) return { meta: null };

    const basics = this.parseMetaBasics
      ? this.parseMetaBasics(data, slug)
      : typeof data === "string"
      ? ogMetaFromHtml(data, slug)
      : { name: slug, poster: "", description: "" };

    const genres = this.parseGenres ? this.parseGenres(data) : [];

    const tmdb: TmdbInfo | null = basics.name
      ? await fetchTmdb(basics.name, tmdbKey)
      : null;

    const rawEps = (await this.listEpisodes?.(data, slug, tmdb, env)) ?? [];
    const sorted = [...rawEps].sort((a, b) => a.s - b.s || a.e - b.e);

    return buildSeriesMeta({
      id,
      name: basics.name,
      poster: basics.poster,
      description: basics.description,
      genres,
      tmdb,
      videos: sorted.map((ep) => ({
        id: ep.id ?? this.videoId(ep),
        season: ep.s,
        episode: ep.e,
        thumbnail: ep.thumb,
      })),
    });
  }
}
