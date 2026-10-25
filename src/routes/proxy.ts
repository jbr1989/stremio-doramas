import { MOBILE_UA, netFetch } from "../lib/utils";

// ---------------------------------------------------------------------------
// Proxies HLS/segmentos: Stremio no puede reproducir m3u8 con CORS/Referer
// restrictivos, así que el addon reescribe las playlists para que cada
// recurso vuelva a pasar por el worker. Ambos comparten el patrón de headers
// (UA móvil + Referer del site) que muchos hosts exigen para servir el video.
// ---------------------------------------------------------------------------

/** Headers que usan los 2 proxies: Referer configurable vía ?ref= (default
 *  doramasflix.in) porque los hosts de streams pueden rechazar sin él. */
function proxyHeaders(referer: string) {
  return {
    Referer: referer,
    Origin: new URL(referer).origin,
    "User-Agent": MOBILE_UA,
  };
}

/** /proxy/m3u8 — descarga la playlist, reescribe sus URLs (relativas→absoluto
 *  y todo apuntando de vuelta al worker) y la devuelve reescrita. */
export async function proxyM3u8(request: Request, url: URL): Promise<Response> {
  const m3u8Url = url.searchParams.get("url");
  const referer = url.searchParams.get("ref") || "https://doramasflix.in/";
  if (!m3u8Url) return new Response("Missing url", { status: 400 });
  try {
    const base = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);
    const workerBase = new URL(request.url).origin;
    const proxied = (absUrl: string, forceM3u8 = false) => {
      const route = forceM3u8 || absUrl.includes(".m3u8") ? "m3u8" : "seg";
      return `${workerBase}/proxy/${route}?url=${encodeURIComponent(
        absUrl
      )}&ref=${encodeURIComponent(referer)}`;
    };
    const r = await netFetch("direct", m3u8Url, {
      headers: proxyHeaders(referer),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return new Response(`Upstream ${r.status}`, { status: r.status });
    const m3u8Text = await r.text();
    const isMaster = m3u8Text.includes("#EXT-X-STREAM-INF");
    const rewritten = m3u8Text
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed === "") return line;
        if (trimmed.startsWith("#")) {
          // URI="..." dentro de #EXT-X-KEY / #EXT-X-MEDIA / #EXT-X-MAP etc.
          const uriM = line.match(/URI="([^"]+)"/);
          if (!uriM) return line;
          const absUri = uriM[1].startsWith("http")
            ? uriM[1]
            : base + uriM[1];
          return line.replace(uriM[1], proxied(absUri));
        }
        // Línea normal: playlist o segmento (relativa al m3u8 que la traía)
        const absUrl = trimmed.startsWith("http")
          ? trimmed
          : base + trimmed;
        return proxied(absUrl, isMaster);
      })
      .join("\n");
    return new Response(rewritten, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      },
    });
  } catch (e) {
    return new Response(String(e), { status: 500 });
  }
}

/** /proxy/seg — passthrough del segmento binario tal cual (streaming, sin
 *  buffer completo). Los segmentos no cambian: cacheables 1h. */
export async function proxySeg(url: URL): Promise<Response> {
  const segUrl = url.searchParams.get("url");
  const referer = url.searchParams.get("ref") || "https://doramasflix.in/";
  if (!segUrl) return new Response("Missing url", { status: 400 });
  try {
    const r = await netFetch("direct", segUrl, {
      headers: proxyHeaders(referer),
    });
    if (!r.ok) return new Response(`Upstream ${r.status}`, { status: r.status });
    return new Response(r.body, {
      headers: {
        "Content-Type": r.headers.get("Content-Type") || "video/MP2T",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (e) {
    return new Response(String(e), { status: 500 });
  }
}
