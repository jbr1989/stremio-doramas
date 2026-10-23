import { Env } from "../types";
import { genreSlug } from "../genres";
import { cleanTitle, decodeEntities, denoBaseFromEnv, fetchTmdb, makeStreamDeduper, racerFetch, toMetaPreview } from "../utils";
import { addEmbedStreams } from "../extractors";
import { dooPlayerAjaxEmbed, genresFromDooPlay, imgFromTag } from "./dooplay";
import { resolveEpisodeSlug, searchVariants } from "./slugmap";

interface DoramaSource {
  prefix: string;
  base: string;
  label: string;
  /** Base del archivo de género del sitio: "genero" (doramaslat) o "genre"
   * (doramedplay). Conslutas: {base}/{genreBase}/{slug}/page/N/. */
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

async function fetchDorama(
  url: string,
  env?: Env,
  timeoutMs = 12000
): Promise<string> {
  return racerFetch(url, env, { minLen: 400, proxyTimeoutMs: timeoutMs });
}

function parseDoramaCards(html: string, src: DoramaSource) {
  const results: { id: string; name: string; poster: string }[] = [];
  const seen = new Set<string>();
  const push = (slug: string, rawPoster: string, rawName: string) => {
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    const poster = rawPoster.startsWith("http")
      ? rawPoster
      : rawPoster
      ? `${src.base}${rawPoster}`
      : "";
    results.push({
      id: `${src.prefix}:${slug}`,
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

export async function getDoramaCatalog(
  src: DoramaSource,
  extra: Record<string, string>,
  env?: Env
) {
  const q = (extra.search || "").trim();
  if (q) {
    return {
      metas: parseDoramaCards(
        await fetchDorama(
          `${src.base}/?s=${encodeURIComponent(q)}`,
          env
        ),
        src
      ).map(toMetaPreview),
    };
  }
  // Género: archivo {genreBase}/{slug}/page/N/ del propio sitio (términos del
  // registry WP REST /wp-json/wp/v2/genres — ver src/genres.ts). El archivo
  // mezcla post types (60 posts/página: tvshows+peliculas, orden recientes):
  // parseDoramaCards ya filtra solo /tvshows/ → cada página devuelve el
  // subconjunto de series de ese género. Opción B: un género con 0 series
  // etiquetadas hoy devuelve vacío y se llena solo cuando upstream etiquete.
  const g = (extra.genre || "").trim();
  if (g) {
    const gslug = genreSlug(src.prefix, g);
    if (!gslug) return { metas: [] };
    // Página por skip: mismo divisor 45 que el catálogo /tvshows/ (all.ts
    // declara page:45). El archivo real pagina 60 posts/página mezclados, así
    // que la granularidad del skip es aproximada — aceptable: Stremio tolera
    // páginas de largo variable y parciales.
    const gpage = Math.floor(parseInt(extra.skip || "0", 10) / 45) + 1;
    const gpath =
      gpage > 1
        ? `${src.base}/${src.genreBase}/${gslug}/page/${gpage}/`
        : `${src.base}/${src.genreBase}/${gslug}/`;
    return {
      metas: parseDoramaCards(await fetchDorama(gpath, env), src).map(
        toMetaPreview
      ),
    };
  }

  const page = Math.floor(parseInt(extra.skip || "0", 10) / 45) + 1;
  const path =
    page > 1
      ? `${src.base}/tvshows/page/${page}/`
      : `${src.base}/tvshows/`;
  return {
    metas: parseDoramaCards(await fetchDorama(path, env), src).map(
      toMetaPreview
    ),
  };
}

export async function getDoramaMeta(
  src: DoramaSource,
  id: string,
  tmdbKey: string,
  env?: Env
) {
  const slug = id.slice(src.prefix.length + 1);
  const html = await fetchDorama(`${src.base}/tvshows/${slug}/`, env);
  const name =
    cleanTitle(
      html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] ||
        html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ||
        slug
    ) || slug;
  const poster =
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1] ||
    html.match(
      /<div class="poster">\s*<img[^>]+(?:data-src|src)="([^"]+)"/i
    )?.[1] ||
    "";
  const description = decodeEntities(
    html.match(
      /<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i
    )?.[1] ||
      html.match(
        /<div[^>]+itemprop="description"[^>]*>([\s\S]*?)<\/div>/i
      )?.[1] ||
      ""
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const episodes: { slug: string; s: number; e: number }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /\/episodes\/([a-z0-9-]+-(\d+)x(\d+))\/?/gi
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

  // Miniaturas de episodio. En la grilla DooPlay cada <li> va
  // <div class='imagen'><img src="thumb"></div><div class='numerando'>S - E</div>
  // <div class='episodiotitle'><a href=".../episodes/epSlug-SxE/"> — la <img> del
  // propio <li> precede al href (≤ ~150 chars, comillas dobles o simples), así
  // que emparejamos img → primer href tras ella. Cero requests extra.
  const thumbs = new Map<string, string>();
  const pushThumb = (epSlug: string, raw: string) => {
    if (thumbs.has(epSlug)) return;
    // dt_backdrop/dt_poster es la imagen "sin imagen" del tema DooPlay —
    // si la instalación no genera stills por episodio, repite ese placeholder.
    if (/dooplay\/assets\/img\/no\/dt_/.test(raw)) return;
    const thumb = raw.startsWith("http")
      ? raw
      : raw.startsWith("//")
      ? `https:${raw}`
      : raw.startsWith("/")
      ? `${src.base}${raw}`
      : "";
    if (thumb) thumbs.set(epSlug, thumb);
  };
  // En lazy-load la <img> trae src='data:image/svg…' señuelo y la URL real en
  // data-src — capturamos el tag completo y resolvemos con imgFromTag
  // (dooplay.ts): preferencia data-src, nunca "data:", src llano solo http.
  for (const m of html.matchAll(
    /<img\b([^>]*)>[\s\S]{0,220}?\/episodes\/([a-z0-9-]+-(\d+)x(\d+))\/["']/gi
  )) {
    const raw = imgFromTag(m[1]);
    if (raw) pushThumb(m[2], raw);
  }

  // Géneros de la ficha: bloque sgeneros del tema (server-rendered, cada
  // sitio linkea su propia base: "genero"/"genre" — ver DoramaSource).
  // Label canónico (src/genres.ts) o texto del sitio tal cual (dooplay.ts).
  const genres = genresFromDooPlay(html, src.genreBase, src.prefix);

  const tmdb = await fetchTmdb(name, tmdbKey);
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
        id: `${src.prefix}:${ep.slug}`,
        title: `T${ep.s} · Episodio ${ep.e}`,
        season: ep.s,
        episode: ep.e,
        thumbnail: thumbs.get(ep.slug) || poster,
      })),
    },
  };
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
            const html = await fetchDorama(
              `${src.base}/?s=${encodeURIComponent(v)}`,
              env
            );
            for (const m of html.matchAll(/\/tvshows\/([a-z0-9-]+)\//gi))
              slugs.add(m[1]);
          }
          return [...slugs];
        })(),
      fetchEpisodes: (seriesSlug) =>
        (async () => {
          const html = await fetchDorama(
            `${src.base}/tvshows/${seriesSlug}/`,
            env
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

export async function getDoramaStreams(
  src: DoramaSource,
  rawId: string,
  env: Env
) {
  const epSlug = rawId.slice(src.prefix.length + 1);
  if (!/-\d+x\d+$/.test(epSlug)) return { streams: [] };

  let html = "";
  try {
    html = await fetchDorama(`${src.base}/episodes/${epSlug}/`, env);
  } catch {
    html = "";
  }
  if (!html) {
    const resolved = await resolveDooPlayEpisodeSlug(src, epSlug, env);
    if (resolved && resolved !== epSlug) {
      console.log(`[${src.prefix}] slug resuelto: ${epSlug} → ${resolved}`);
      try {
        html = await fetchDorama(`${src.base}/episodes/${resolved}/`, env);
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
    const type = tag.match(/data-type=["']([^"']+)["']/i)?.[1] || "tv";
    if (post && nume) options.push({ post, nume, type });
  }
  if (options.length === 0) return { streams: [] };

  const denoBase = denoBaseFromEnv(env);
  const { add, streams } = makeStreamDeduper();

  const embeds = await Promise.all(
    options.map((o) => dooPlayerAjaxEmbed(src.base, o.post, o.nume, o.type))
  );
  for (const embed of embeds) {
    if (!embed) continue;
    await addEmbedStreams({
      embed,
      epSlug,
      label: src.label,
      prefix: src.prefix,
      denoBase,
      add,
      env,
    });
  }
  return { streams };
}
