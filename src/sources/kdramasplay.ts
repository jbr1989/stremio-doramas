import { Env } from "../lib/types";
import { CHROME_UA, cleanTitle, fetchHtml, netFetch } from "../lib/utils";
import { dooPlayerAjaxEmbed, dooplayEpisodeList, dooplayEpThumbs } from "../lib/dooplay";
import { resolveEpisodeSlug, searchVariants } from "../lib/slugmap";
import { YandiSource } from "./yandispoiler";
import { SourceCard } from "../lib/sourceBase";

const KPLAY_BASE = "https://kdramasplay.com";

/** Resuelve el epSlug propio de kdramasplay para un epSlug venido de otro
 * sitio (mapping por título, ver slugmap.ts). Devuelve null si no hay match.
 *
 * Búsqueda: el `?s=` de kdramasplay NO emite resultados server-side (grid lo
 * llena el livesearch) — el buscador real es la REST de DooPlay
 * `/wp-json/dooplay/search/?keyword=&nonce=`, que devuelve HTTP 200 con JSON
 * `{id: {title, url, img}}` (o `{error:"no_posts"|"no_verify_nonce"}`). El
 * nonce (`"nonce":"…"` en el config `dtGonza`) sale de la misma página `?s=`
 * que ya descargamos, así que cada resolución hace 1 fetch de página + 1-2
 * REST. El REST matchea por frase: si la frase completa no da nada se prueba
 * con la palabra más larga del título. */
async function resolveKplayEpisodeSlug(
  epSlug: string,
  env: Env
): Promise<string | null> {
  const restSearch = async (
    kw: string,
    nonce: string
  ): Promise<string[]> => {
    if (!kw.trim() || !nonce) return [];
    try {
      const r = await netFetch(
        "kplaysearch",
        `${KPLAY_BASE}/wp-json/dooplay/search/?keyword=${encodeURIComponent(
          kw
        )}&nonce=${encodeURIComponent(nonce)}`,
        {
          headers: {
            "User-Agent": CHROME_UA,
            "X-Requested-With": "XMLHttpRequest",
            Referer: `${KPLAY_BASE}/`,
          },
          signal: AbortSignal.timeout(8000),
        }
      );
      if (!r.ok) return [];
      const data: unknown = await r.json().catch(() => null);
      if (!data || typeof data !== "object" || "error" in (data as object))
        return [];
      const slugs: string[] = [];
      for (const v of Object.values(data as Record<string, { url?: string }>)) {
        const m = (v?.url || "").match(/\/series\/([a-z0-9-]+)\//i);
        if (m) slugs.push(m[1]);
      }
      return [...new Set(slugs)];
    } catch {
      return [];
    }
  };

  return resolveEpisodeSlug(
    {
      site: "kplay",
      searchSeries: (title) =>
        (async () => {
          const variants = searchVariants(title);
          const html = await fetchHtml(
            `${KPLAY_BASE}/?s=${encodeURIComponent(variants[0])}`,
            env
          );
          // Server-side del grid (suele venir vacío) + nonce fresco del tema.
          const slugs = [
            ...new Set(
              [...html.matchAll(/\/series\/([a-z0-9-]+)\//gi)].map((m) => m[1])
            ),
          ];
          const nonce =
            html.match(/"nonce":"([a-f0-9]{10})"/)?.[1] || "";
          for (const v of variants) {
            slugs.push(...(await restSearch(v, nonce)));
          }
          return [...new Set(slugs)];
        })(),
      fetchEpisodes: (seriesSlug) =>
        (async () => {
          const html = await fetchHtml(
            `${KPLAY_BASE}/series/${seriesSlug}/`,
            env
          );
          return dooplayEpisodeList(html, "episodios").map((ep) => ({
            epSlug: ep.slug,
            s: ep.s,
            e: ep.e,
          }));
        })(),
    },
    epSlug,
    env
  );
}

/** Kplay hereda el layout 3-segmentos de yandi; pisa solo lo genuinamente
 * distinto: player AJAX DooPlay, grilla de thumbs en el meta, parser de
 * cards simple y rescatador de slug REST+nonce. */
export class KplaySource extends YandiSource {
  constructor() {
    super({
      prefix: "kplay",
      label: "KDramas Play",
      base: KPLAY_BASE,
      seriesPath: "series",
      epPath: "episodios",
      moviePath: "peliculas",
      genreBase: "genero",
    });
  }

  // Player DooPlay: <li dooplay_player_option data-post/nume/type> →
  // doo_player_ajax. El type fallback depende del subtipo del id.
  protected override async extractEmbeds(
    html: string,
    idSlug: string,
    _env?: Env
  ): Promise<string[]> {
    const options: { post: string; nume: string; type: string }[] = [];
    for (const li of html.matchAll(/<li[^>]*dooplay_player_option[^>]*>/gi)) {
      const tag = li[0];
      const post = tag.match(/data-post=["']([^"']+)["']/i)?.[1];
      const nume = tag.match(/data-nume=["']([^"']+)["']/i)?.[1];
      const type =
        tag.match(/data-type=["']([^"']+)["']/i)?.[1] ||
        (idSlug.startsWith("movie:") ? "movie" : "tv");
      if (post && nume) options.push({ post, nume, type });
    }
    if (options.length === 0) return [];

    const embeds = await Promise.all(
      options.map((o) =>
        dooPlayerAjaxEmbed(KPLAY_BASE, o.post, o.nume, o.type, "kplay")
      )
    );
    return embeds.filter((u): u is string => !!u);
  }

  // Grilla de thumbs de episodios (misma de doramas.ts: la <img> del propio
  // <li> precede al href — ver dooplayEpThumbs).
  protected override episodeThumbs(html: string): Map<string, string> {
    return dooplayEpThumbs(html, KPLAY_BASE, "episodios", 220);
  }

  protected override async resolveEpisodeSlug(
    epSlug: string,
    env: Env
  ): Promise<string | null> {
    return resolveKplayEpisodeSlug(epSlug, env);
  }

  // Parser de cards: 2 regex sin data-ptype/sideranking (el fallback de
  // yandi está bien tal cual para este tema).
  protected override parseCards(html: string): SourceCard[] {
    const results: SourceCard[] = [];
    const seen = new Set<string>();
    const push = (
      type: "series" | "movie",
      slug: string,
      rawPoster: string,
      rawName: string
    ) => {
      if (!slug || seen.has(`${type}:${slug}`)) return;
      seen.add(`${type}:${slug}`);
      const poster = rawPoster.startsWith("http")
        ? rawPoster
        : rawPoster
        ? `${KPLAY_BASE}${rawPoster}`
        : "";
      results.push({
        slug,
        type,
        name: cleanTitle(rawName) || slug,
        poster,
      });
    };

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
}

export const kplaySource = new KplaySource();
