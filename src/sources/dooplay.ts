// Helpers comunes a los sitios DooPlay (kdramasplay, doramas/doramaslat/
// doramedplay, …). Antes: resolveKplayEmbed (kdramasplay.ts) y resolveDoramaEmbed
// (doramas.ts) eran copias literales de la misma llamada admin-ajax.php.
import { CHROME_UA, netFetch } from "../utils";

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
