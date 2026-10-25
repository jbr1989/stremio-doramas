import { Env } from "./lib/types";
import { CORS, json, safeDecode } from "./lib/utils";
import { MANIFEST } from "./manifest";
import { LOGO_PNG_BASE64 } from "./logo";
import { handleDebug, isDebugPath } from "./debug";
import { catalogRoute, metaRoute, streamRoute } from "./routes/stremio";
import { proxyM3u8, proxySeg } from "./routes/proxy";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Red de seguridad: cualquier throw que escape de las rutas (un id con
    // % malformado ya no puede —los decodes pasan por safeDecode— pero un
    // JSON.parse inesperado u otro fix futuro sí) responde 500 JSON con
    // CORS en vez de error 1101 de Cloudflare.
    return handleRequest(request, env).catch((e) => {
      console.error(`[fatal] request ${request.url} → ${String(e)}`);
      return json({ error: "internal", detail: String(e) }, 500);
    });
  },
};

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const tmdbKey = (env.TMDB_KEY || "").trim();

  if (request.method === "OPTIONS")
    return new Response(null, { headers: CORS });

  if (path === "/logo.png") {
    const bytes = Uint8Array.from(atob(LOGO_PNG_BASE64), (c) =>
      c.charCodeAt(0)
    );
    return new Response(bytes, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
        "Content-Length": String(bytes.length),
      },
    });
  }

  // El logo se sirve desde el propio addon: en local apunta al origin del
  // request y en producción al workers.dev, sin depender de sitios externos.
  if (path === "/" || path === "/manifest.json")
    return json({ ...MANIFEST, logo: `${url.origin}/logo.png` });

  if (isDebugPath(path)) {
    const resp = await handleDebug(request, url, path, env);
    if (resp) return resp;
  }

  if (path === "/cache-clear") {
    const key = url.searchParams.get("key");
    if (key && env.STREAM_CACHE) {
      await env.STREAM_CACHE.delete(key);
      return json({ cleared: key });
    }
    return json({
      error:
        "Missing ?key= (full KV key, e.g. stream:v4:dflix:slug-1x1, meta:{id} or epmap:v1:kplay:{titleKey}) or no KV binding",
    });
  }

  if (path === "/_health") {
    return json({
      status: "alive",
      version: MANIFEST.version,
      kv: env.STREAM_CACHE ? "bound" : "missing",
    });
  }

  const catM = path.match(
    /^\/catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/
  );
  if (catM) {
    const [, , catalogId, extraStr] = catM;
    const extra: Record<string, string> = {};
    if (extraStr)
      extraStr.split("&").forEach((p) => {
        const [k, v] = p.split("=");
        if (k && v) extra[k] = safeDecode(v);
      });
    if (url.searchParams.get("search"))
      extra.search = url.searchParams.get("search")!;
    if (url.searchParams.get("genre"))
      extra.genre = url.searchParams.get("genre")!;
    return catalogRoute(catalogId, extra, env);
  }

  const metaM = path.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
  if (metaM)
    return metaRoute(safeDecode(metaM[2]), tmdbKey, env);

  const streamM = path.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
  if (streamM) return streamRoute(safeDecode(streamM[2]), env);

  if (path === "/proxy/m3u8") return proxyM3u8(request, url);
  if (path === "/proxy/seg") return proxySeg(url);

  return new Response("Not found", { status: 404, headers: CORS });
}
