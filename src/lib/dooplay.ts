// Helpers comunes a los sitios DooPlay (kdramasplay, doramas/doramaslat/
// doramedplay, …). Antes: resolveKplayEmbed (kdramasplay.ts) y resolveDoramaEmbed
// (doramas.ts) eran copias literales de la misma llamada admin-ajax.php.
import { CHROME_UA, cleanTitle, decodeEntities, netFetch } from "./utils";
import { genreLabelForMeta } from "../genres";

/** URL real desde los atributos de un tag <img> de las grillas DooPlay:
 * en lazy-load la <img> trae src='data:image/svg…' señuelo con la URL real
 * en data-src — preferimos data-src y descartamos cualquier "data:"; el src
 * llano solo cuenta si es URL http real. Antes copiado ×3 (tudorama,
 * kdramasplay, doramas). */
export function imgFromTag(attrs: string): string {
  return (
    [
      attrs.match(/data-src=["']([^"']+)["']/i)?.[1] || "",
      attrs.match(/(?:^|\s)src=["']([^"']+)["']/i)?.[1] || "",
    ].find((u) => u && !u.startsWith("data:")) || ""
  );
}

/** Texto plano desde HTML crudo: fuera tags, espacios colapsados y entidades
 * decodificadas. Antes inline ×6 en los metas de las fuentes (comentario
 * `og:description` + tags de descripción). */
export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

/** name/poster/description del OpenGraph de una ficha DooPlay, con los
 * fallbacks que todas las fuentes usan: `<title>` → slug para el nombre,
 * `div.poster img` para el poster y `itemprop="description"` para la
 * sinopsis. Antes duplicado literal en kplay/yandi (y con variantes en
 * doramas/tudorama/doramasyt, que pueden pasar regexes propias). */
export function ogMetaFromHtml(
  html: string,
  slug: string,
  opts?: {
    titleFallbackRe?: RegExp;
    posterFallbackRe?: RegExp;
    descFallbackRe?: RegExp;
  }
): { name: string; poster: string; description: string } {
  const name =
    cleanTitle(
      html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] ||
        (opts?.titleFallbackRe &&
          html.match(opts.titleFallbackRe)?.[1].replace(/<[^>]*>/g, "")) ||
        html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ||
        slug
    ) || slug;
  const poster =
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1] ||
    (opts?.posterFallbackRe && html.match(opts.posterFallbackRe)?.[1]) ||
    html.match(/<div class="poster">\s*<img[^>]+(?:data-src|src)="([^"]+)"/i)?.[1] ||
    "";
  const description = stripTags(
    html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1] ||
      (opts?.descFallbackRe && html.match(opts.descFallbackRe)?.[1]) ||
      html.match(/<div[^>]+itemprop="description"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
      ""
  );
  return { name, poster, description };
}

/** Lista de episodios `(slug, s, e)` de una grilla DooPlay (slugs de la
 * forma `/{epPath}/{slug}-{S}x{E}/`) con dedup + sort temporada/episodio.
 * Antes duplicado ×2 en cada fuente (meta + fetchEpisodes del adapter).
 * epPath: "episodes" (dlat/dplay) o "episodios" (kplay, yandi). */
export function dooplayEpisodeList(
  html: string,
  epPath = "episodios"
): { slug: string; s: number; e: number }[] {
  const episodes: { slug: string; s: number; e: number }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    new RegExp(`\\/${epPath}\\/([a-z0-9-]+-(\\d+)x(\\d+))\\/?`, "gi")
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
  return episodes;
}

/** Miniaturas por episodio de la grilla DooPlay (<div class='imagen'><img …>
 * … <a href=".../{epPath}/{epSlug}-SxE/">): la <img> del propio <li> precede
 * al href. Absolutiza la URL (http | // | /). Descarta el señuelo
 * dooplay/assets/img/no/dt_. Antes duplicado kplay/doramas (window 220).
 * Devuelve Map epSlug → thumb absoluto. */
export function dooplayEpThumbs(
  html: string,
  base: string,
  epPath = "episodios",
  window = 220
): Map<string, string> {
  const thumbs = new Map<string, string>();
  const pushThumb = (epSlug: string, raw: string) => {
    if (thumbs.has(epSlug)) return;
    if (/dooplay\/assets\/img\/no\/dt_/.test(raw)) return;
    const thumb = raw.startsWith("http")
      ? raw
      : raw.startsWith("//")
      ? `https:${raw}`
      : raw.startsWith("/")
      ? `${base}${raw}`
      : "";
    if (thumb) thumbs.set(epSlug, thumb);
  };
  for (const m of html.matchAll(
    new RegExp(
      `<img\\b([^>]*)>[\\s\\S]{0,${window}}?\\/${epPath}\\/([a-z0-9-]+-(\\d+)x(\\d+))\\/["']`,
      "gi"
    )
  )) {
    const raw = imgFromTag(m[1]);
    if (raw) pushThumb(m[2], raw);
  }
  return thumbs;
}

/** Ensamblado final del meta movie DooPlay con override TMDB (poster /
 * background / description / releaseInfo; el placeholder de video apunta a
 * `{prefix}:movie:{slug}`, igual para todas las fuentes con rama movie
 * — kplay, yandi, pandrama). Antes duplicado kplay/yandi. */
export function buildMovieMeta(p: {
  id: string;
  slug: string;
  name: string;
  poster: string;
  description: string;
  genres: string[];
  tmdb: { poster?: string; background?: string; description?: string; year?: string } | null;
}) {
  return {
    meta: {
      id: p.id,
      type: "movie",
      name: p.name,
      poster: p.tmdb?.poster || p.poster,
      background: p.tmdb?.background || p.poster,
      description: p.tmdb?.description || p.description,
      posterShape: "poster",
      releaseInfo: p.tmdb?.year || "",
      genres: p.genres,
      videos: [
        {
          id: p.id, // == `kplay:movie:…` / `yandi:movie:…`
          title: p.name,
          season: 1,
          episode: 1,
        },
      ],
    },
  };
}

/** Ensamblado final del meta series DooPlay con override TMDB, a partir de la
 * lista de episodios de dooplayEpisodeList. Antes duplicado kplay/yandi (y
 * casi idéntico en dlat/dplay). */
export function buildSeriesMeta(p: {
  id: string;
  name: string;
  poster: string;
  description: string;
  genres: string[];
  tmdb: { poster?: string; background?: string; description?: string; year?: string } | null;
  /** `{prefix}:{slug}` de cada episodio con season/episode y thumbnail. */
  videos: {
    id: string;
    season: number;
    episode: number;
    thumbnail?: string;
  }[];
}) {
  return {
    meta: {
      id: p.id,
      type: "series",
      name: p.name,
      poster: p.tmdb?.poster || p.poster,
      background: p.tmdb?.background || p.poster,
      description: p.tmdb?.description || p.description,
      posterShape: "poster",
      releaseInfo: p.tmdb?.year || "",
      genres: p.genres,
      videos: p.videos.map((v) => ({
        id: v.id,
        title: `T${v.season} · Episodio ${v.episode}`,
        season: v.season,
        episode: v.episode,
        thumbnail: v.thumbnail,
      })),
    },
  };
}

/** Texto interno de un <a>: fuera tags internos, entidades decodificadas y
 * espacios colapsados. */
function anchorText(raw: string): string {
  return decodeEntities(
    raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")
  ).trim();
}

/** Anclas de género (pares slug+texto) de un fragmento de HTML. `genreBase`
 * es la base de la taxonomía de género del sitio: "genero" (DooPlay hispano,
 * kdramasplay, doramasyt), "genre" (doramedplay) o "genres" (tudorama).
 * Variaciones de los sitios que matchea: slash final opcional (DooPlay y
 * tudorama lo traen, doramasyt NO — /genero/drama sin /) y query de
 * paginación (?p=N en dyt). */
function genreAnchorPairs(
  html: string,
  genreBase: string
): { slug: string; text: string }[] {
  const out: { slug: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    new RegExp(
      `href=["'][^"']*?/${genreBase}/([a-z0-9-]+)/?(?:\\?[^"']*)?["'][^>]*>([\\s\\S]{0,120}?)</a>`,
      "gi"
    )
  )) {
    const slug = m[1].toLowerCase();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, text: m[2] });
  }
  return out;
}

function pairLabels(
  pairs: { slug: string; text: string }[],
  source: string
): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const { slug, text } of pairs) {
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const label = genreLabelForMeta(source, slug, anchorText(text));
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** Géneros de una ficha DooPlay (kdramasplay, doramaslat, doramedplay): el
 * tema pinta server-side los géneros PROPIOS de la serie en el bloque
 * `<div class="sgeneros">` (verificado in-vivo: comedia+drama+sci-fi-fantasy
 * en doramaslat; comedy+drama en kplay). Se acota a ese bloque porque el
 * MENÚ de algunos sitios también linkea a archivos de género (doramaslat:
 * descargar-peliculas, series-anime…) y contaminaría la lista. Si la ficha
 * no trae el bloque, fallback a las anclas `rel="tag"` de la página (marca
 * la taxonomía de género de WP; el menú no la usa — 0 hits in-vivo). */
export function genresFromDooPlay(
  html: string,
  genreBase: string,
  source: string
): string[] {
  const block = html.match(
    /<div[^>]*class=["'][^"']*sgeneros[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
  )?.[1];
  if (block) return pairLabels(genreAnchorPairs(block, genreBase), source);
  // Fallback: el href puede ir antes o después de rel, por eso se captura el
  // tag <a> completo y se validan ambos atributos en sus atributos
  const pairs: { slug: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]{0,120}?)<\/a>/gi)) {
    if (!/rel=["']tag["']/i.test(m[1])) continue;
    const slug = m[1]
      .match(new RegExp(`/${genreBase}/([a-z0-9-]+)/`, "i"))?.[1]
      ?.toLowerCase();
    if (slug) pairs.push({ slug, text: m[2] });
  }
  return pairLabels(pairs, source);
}

/** Géneros de una ficha TuDorama (tema propio, NO DooPlay — vive aquí porque
 * ya comparte este módulo con imgFromTag): la ficha pinta sus géneros como
 * `<li><a href="…/genres/{slug}/">`. Las tarjetas "similares" de la MISMA
 * página traen los géneros de OTRAS series como anclas sueltas (sin <li>) —
 * se exigen <li> para no mezclar catálogos (verificado in-vivo: 3 en-li vs
 * 20 sueltas en una ficha). */
export function genresFromListItems(
  html: string,
  genreBase: string,
  source: string
): string[] {
  const pairs: { slug: string; text: string }[] = [];
  for (const m of html.matchAll(
    new RegExp(
      `<li[^>]*>\\s*<a[^>]+href=["'][^"']*?/${genreBase}/([a-z0-9-]+)/["'][^>]*>([\\s\\S]{0,120}?)</a>`,
      "gi"
    )
  )) {
    pairs.push({ slug: m[1], text: m[2] });
  }
  return pairLabels(pairs, source);
}

/** Géneros de una ficha DoramasYT (tema WStream/Bootstrap, NO DooPlay — vive
 * aquí porque ya comparte este módulo con los demás extractores): la ficha
 * pinta sus géneros como badges en `<div class="lh-lg"><small…>Géneros</small>
 * <a href="…/genero/{slug}"><span class="badge">Label</span></a>…`. Se acota a
 * ese bloque porque el FOOTER de la misma página linkea 12-13 archivos de
 * género ("Por Tipo", "Géneros Populares") y contaminaría (verificado
 * in-vivo: 3-4 en bloque vs 12-13 sueltos). Anclas sin slash final — las
 * tolera genreAnchorPairs. */
export function genresFromBadgeBlock(
  html: string,
  genreBase: string,
  source: string
): string[] {
  const block = html.match(
    /<div[^>]*class=["'][^"']*lh-lg[^"']*["'][^>]*>\s*<small[^>]*>G[eé]neros<\/small>([\s\S]*?)<\/div>/i
  )?.[1];
  if (!block) return [];
  return pairLabels(genreAnchorPairs(block, genreBase), source);
}

/** Resuelve el iframe/embed del player DooPlay vía su `wp-admin/admin-ajax.php`
 * (`action=doo_player_ajax&post=&nume=&type=`). Devuelve la URL del embed o
 * null si falla / no hay embed_url útil. `errTag`: prefijo opcional para
 * loggear el error (algún sitio lo hacía, otros descartaban en silencio). */
export async function dooPlayerAjaxEmbed(
  base: string,
  post: string,
  nume: string,
  type: string,
  errTag?: string
): Promise<string | null> {
  try {
    const r = await netFetch("direct", `${base}/wp-admin/admin-ajax.php`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${base}/`,
        "User-Agent": CHROME_UA,
      },
      body: `action=doo_player_ajax&post=${encodeURIComponent(
        post
      )}&nume=${encodeURIComponent(nume)}&type=${encodeURIComponent(type)}`,
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return null;
    const data: any = await r.json();
    const embed = typeof data?.embed_url === "string" ? data.embed_url : "";
    if (!embed) return null;
    let embedSrc =
      embed.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1] || embed.trim();
    embedSrc = embedSrc.replace(/\\\//g, "/");
    if (embedSrc.startsWith("//")) embedSrc = `https:${embedSrc}`;
    return /^https?:\/\//i.test(embedSrc) ? embedSrc : null;
  } catch (ex) {
    if (errTag) console.error(`[${errTag}] doo_player_ajax: ${ex}`);
    return null;
  }
}
