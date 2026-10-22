import { Env } from "../types";
import { genreSlug } from "../genres";
import { CHROME_UA, cleanTitle, decodeEntities, denoBaseFromEnv, fetchHtml, fetchTmdb, makeStreamDeduper, netFetch, toMetaPreview } from "../utils";
import { addEmbedStreams } from "../extractors";
import { dooPlayerAjaxEmbed, genresFromDooPlay, imgFromTag } from "./dooplay";
import { resolveEpisodeSlug, searchVariants } from "./slugmap";

const KPLAY_BASE = "https://kdramasplay.com";

function parseKplayCards(html: string) {
  const results: { id: string; name: string; poster: string }[] = [];
  const seen = new Set<string>();
  const push = (type: "series" | "movie", slug: string, rawPoster: string, rawName: string) => {
    if (!slug || seen.has(`${type}:${slug}`)) return;
    seen.add(`${type}:${slug}`);
    const poster = rawPoster.startsWith("http")
      ? rawPoster
      : rawPoster
      ? `${KPLAY_BASE}${rawPoster}`
      : "";
    results.push({
      id: `kplay:${type}:${slug}`,
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

export async function getKplayCatalog(
  extra: Record<string, string>,
  env?: Env
) {
  const q = (extra.search || "").trim();
  if (q) {
    return {
      metas: parseKplayCards(
        await fetchHtml(
          `${KPLAY_BASE}/?s=${encodeURIComponent(q)}`,
          env
        )
      ).map(toMetaPreview),
    };
  }

  // Género: archivo /genero/{slug}/ del propio sitio (términos del registry
  // WP REST /wp-json/wp/v2/genres — ver src/genres.ts). Sin paginación real:
  // ?page=2 repite página 1 exactamente (verificado romance y comedia) → se
  // ignora skip y se sirve siempre página 1; el dedup del consolidado absorbe
  // las repeticiones. Opción B: géneros con 0 series hoy devuelven vacío.
  const g = (extra.genre || "").trim();
  if (g) {
    const gslug = genreSlug("kplay", g);
    if (!gslug) return { metas: [] };
    return {
      metas: parseKplayCards(
        await fetchHtml(`${KPLAY_BASE}/genero/${gslug}/`, env)
      )
        // El archivo de género mezcla /series/ y /peliculas/: filter a series
        // — es un catálogo de type "series" y parseKplayCards etiqueta type.
        .filter((r) => r.id.startsWith("kplay:series:"))
        .map(toMetaPreview),
    };
  }

  const page = Math.floor(parseInt(extra.skip || "0", 10) / 24) + 1;
  const path = page > 1 ? `${KPLAY_BASE}/series/page/${page}/` : `${KPLAY_BASE}/series/`;
  return {
    metas: parseKplayCards(await fetchHtml(path, env)).map(toMetaPreview),
  };
}

export async function getKplayMeta(
  id: string,
  tmdbKey: string,
  env?: Env
) {
  const parts = id.split(":");
  if (parts.length < 3) return { meta: null };
  const type = parts[1]; // "series" or "movie"
  const slug = parts[2];
  const pageUrl =
    type === "movie"
      ? `${KPLAY_BASE}/peliculas/${slug}/`
      : `${KPLAY_BASE}/series/${slug}/`;

  let html = "";
  try {
    html = await fetchHtml(pageUrl, env);
  } catch {
    return { meta: null };
  }

  const name =
    cleanTitle(
      html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] ||
        html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ||
        slug
    ) || slug;
  const poster =
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1] ||
    html.match(/<div class="poster">\s*<img[^>]+(?:data-src|src)="([^"]+)"/i)?.[1] ||
    "";
  const description = decodeEntities(
    html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1] ||
      html.match(/<div[^>]+itemprop="description"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
      ""
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Géneros de la ficha: bloque sgeneros del tema (server-rendered, base
  // /genero/). Label canónico (src/genres.ts) o texto del sitio tal cual —
  // kplay etiqueta en EN p.ej. "Comedy" (verificado in-vivo). Válida para
  // movies y series: el bloque existe en ambas páginas DooPlay.
  const genres = genresFromDooPlay(html, "genero", "kplay");

  const tmdb = await fetchTmdb(name, tmdbKey);

  if (type === "movie") {
    return {
      meta: {
        id,
        type: "movie",
        name,
        poster: tmdb?.poster || poster,
        background: tmdb?.background || poster,
        description: tmdb?.description || description,
        posterShape: "poster",
        releaseInfo: tmdb?.year || "",
        genres,
        videos: [
          {
            id: `kplay:movie:${slug}`,
            title: name,
            season: 1,
            episode: 1,
          },
        ],
      },
    };
  }

  // Series episodes
  const episodes: { slug: string; s: number; e: number }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /\/episodios\/([a-z0-9-]+-(\d+)x(\d+))\/?/gi
  )) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    episodes.push({
      slug: m[1],
      s: parseInt(m[2], 10),
      e: parseInt(m[3], 10),
    });
  }
  episodes.sort((a, b) => a.s - b.s || a.e - b.e);

  // Miniaturas de episodio:  misma grilla DooPlay que doramas.ts
  // (<div class='imagen'><img src="thumb"></div> ... <a href=".../episodios/epSlug-SxE/">),
  // la <img> del propio <li> precede al href.
  const thumbs = new Map<string, string>();
  const pushThumb = (epSlug: string, raw: string) => {
    if (thumbs.has(epSlug)) return;
    if (/dooplay\/assets\/img\/no\/dt_/.test(raw)) return;
    const thumb = raw.startsWith("http")
      ? raw
      : raw.startsWith("//")
      ? `https:${raw}`
      : raw.startsWith("/")
      ? `${KPLAY_BASE}${raw}`
      : "";
    if (thumb) thumbs.set(epSlug, thumb);
  };
  // preferencia data-src + nunca "data:" → imgFromTag (dooplay.ts)
  for (const m of html.matchAll(
    /<img\b([^>]*)>[\s\S]{0,220}?\/episodios\/([a-z0-9-]+-(\d+)x(\d+))\/["']/gi
  )) {
    const raw = imgFromTag(m[1]);
    if (raw) pushThumb(m[2], raw);
  }

  return {
    meta: {
      id,
      type: "series",
      name,
      poster: tmdb?.poster || poster,
      background: tmdb?.background || poster,
      description: tmdb?.description || description,
      posterShape: "poster",
      releaseInfo: tmdb?.year || "",
      genres,
      videos: episodes.map((ep) => ({
        id: `kplay:ep:${ep.slug}`,
        title: `T${ep.s} · Episodio ${ep.e}`,
        season: ep.s,
        episode: ep.e,
        thumbnail: thumbs.get(ep.slug) || poster,
      })),
    },
  };
}

/** Resuelve el epSlug propio de kdramasplay para un epSlug venido de otro
 * sitio (mapping por título, see slugmap.ts). Devuelve null si no hay match.
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
          const episodes: { s: number; e: number; epSlug: string }[] = [];
          const seen = new Set<string>();
          for (const m of html.matchAll(
            /\/episodios\/([a-z0-9-]+-(\d+)x(\d+))\/?/gi
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

export async function getKplayStreams(
  rawId: string,
  env: Env
) {
  const parts = rawId.split(":");
  if (parts.length < 3) return { streams: [] };
  const subType = parts[1]; // "ep" or "movie"
  const slug = parts.slice(2).join(":"); // consistente con getStreams (index.ts)

  const targetUrl =
    subType === "movie"
      ? `${KPLAY_BASE}/peliculas/${slug}/`
      : `${KPLAY_BASE}/episodios/${slug}/`;

  let html = "";
  try {
    html = await fetchHtml(targetUrl, env);
  } catch {
    html = "";
  }
  if (!html && subType === "ep") {
    // 404/slug inexistente: kdramasplay nombra sus episodios con su propio
    // slug — resuélvelo vía título de la serie (slugmap) y reintenta.
    const resolved = await resolveKplayEpisodeSlug(slug, env);
    if (resolved && resolved !== slug) {
      console.log(`[kplay] slug resuelto: ${slug} → ${resolved}`);
      try {
        html = await fetchHtml(`${KPLAY_BASE}/episodios/${resolved}/`, env);
      } catch {
        html = "";
      }
    }
  }
  if (!html) return { streams: [] };

  const options: { post: string; nume: string; type: string }[] = [];
  for (const li of html.matchAll(/<li[^>]*dooplay_player_option[^>]*>/gi)) {
    const tag = li[0];
    const post = tag.match(/data-post=["']([^"']+)["']/i)?.[1];
    const nume = tag.match(/data-nume=["']([^"']+)["']/i)?.[1];
    const type = tag.match(/data-type=["']([^"']+)["']/i)?.[1] || (subType === "movie" ? "movie" : "tv");
    if (post && nume) options.push({ post, nume, type });
  }
  if (options.length === 0) return { streams: [] };

  const denoBase = denoBaseFromEnv(env);
  const { add, streams } = makeStreamDeduper();

  const embeds = await Promise.all(
    options.map((o) =>
      dooPlayerAjaxEmbed(KPLAY_BASE, o.post, o.nume, o.type, "kplay")
    )
  );

  for (const embed of embeds) {
    if (!embed) continue;
    await addEmbedStreams({
      embed,
      epSlug: slug,
      label: "KDramas Play",
      prefix: "kplay",
      denoBase,
      add,
      env,
    });
  }
  return { streams };
}
