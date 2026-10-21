// Helpers comunes a los sitios DooPlay (kdramasplay, doramas/doramaslat/
// doramedplay, …). Antes: resolveKplayEmbed (kdramasplay.ts) y resolveDoramaEmbed
// (doramas.ts) eran copias literales de la misma llamada admin-ajax.php.
import { CHROME_UA, decodeEntities, netFetch } from "../utils";
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

/** Texto interno de un <a>: fuera tags internos, entidades decodificadas y
 * espacios colapsados. */
function anchorText(raw: string): string {
  return decodeEntities(
    raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")
  ).trim();
}

/** Anclas de género (pares slug+texto) de un fragmento de HTML. `genreBase`
 * es la base de la taxonomía de género del sitio: "genero" (DooPlay hispano,
 * kdramasplay), "genre" (doramedplay) o "genres" (tudorama). Href relativos
 * y absolutos matchean igual (`[^"']*?` vacío o la base del sitio). */
function genreAnchorPairs(
  html: string,
  genreBase: string
): { slug: string; text: string }[] {
  const out: { slug: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    new RegExp(
      `href=["'][^"']*?/${genreBase}/([a-z0-9-]+)/["'][^>]*>([\\s\\S]{0,120}?)</a>`,
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
