import { Env } from "../lib/types";
import { TTL, cacheGet, cacheSet, json } from "../lib/utils";
import { ResolveDeps } from "../resolve";

// ---------------------------------------------------------------------------
// Endpoints de Stremio: catálogo, meta y streams. Comparten el patrón
// check-the-cache-before-doing-the-work y fail-soft (respuesta parcial de
// error en vez de HTTP 5xx, para que un fallo aislado no degrade el addon).
// Las funciones centrales getCatalog/getMeta/getStreams llegan inyectadas
// (mismo objeto de deps que usa el router de debug) para evitar la
// dependencia circular index.ts ⇄ routes/.
// ---------------------------------------------------------------------------

/** /catalog/{type}/{catalogId}/{extra}.json — listado de series.
 *  Caché: alldoramas cuesta ~7 requests/página → 1h; el resto → TTL.catalog. */
export async function catalogRoute(
  catalogId: string,
  extra: Record<string, string>,
  env: Env,
  deps: ResolveDeps
): Promise<Response> {
  const cacheKey = `catalog:${catalogId}:${extra.search || ""}:${
    extra.genre || ""
  }:${extra.skip || ""}`;
  const cached = await cacheGet(cacheKey, env.STREAM_CACHE);
  if (cached) return json(cached);
  try {
    const result = await deps.getCatalog(catalogId, extra, env);
    await cacheSet(
      cacheKey,
      result,
      // El consolidado cuesta ~7 requests por página: se cachea 1h en
      // vez de los 10 min estándar.
      catalogId.startsWith("alldoramas") ? 60 * 60 : TTL.catalog,
      env.STREAM_CACHE
    );
    return json(result);
  } catch (e) {
    return json({ metas: [], error: String(e) });
  }
}

/** /meta/{type}/{id}.json — ficha de la serie con su lista de episodios.
 *  Clave v2: los metas exponen `genres` (scrape de la ficha) — bump de
 *  clave para no servir metas cacheados sin géneros hasta su TTL. */
export async function metaRoute(
  id: string,
  tmdbKey: string,
  env: Env,
  deps: ResolveDeps
): Promise<Response> {
  const cached = await cacheGet(`meta:v2:${id}`, env.STREAM_CACHE);
  if (cached) return json(cached);
  try {
    const result = await deps.getMeta(id, tmdbKey, env);
    await cacheSet(`meta:v2:${id}`, result, TTL.meta, env.STREAM_CACHE);
    return json(result);
  } catch (e) {
    return json({ meta: null, error: String(e) });
  }
}

/** /stream/{type}/{id}.json — fan-out de streams de las fuentes.
 *  Solo cachea si encontró ≥1 stream (un resultado vacío se re-prueba la
 *  próxima vez en vez de quedar castigado hasta el TTL). */
export async function streamRoute(
  id: string,
  env: Env,
  deps: ResolveDeps
): Promise<Response> {
  const cached = await cacheGet(`stream:v4:${id}`, env.STREAM_CACHE);
  if (cached) return json(cached);
  try {
    const { isDecoyUrl } = await import("../lib/extractors");
    const result = await deps.getStreams(id, env);
    result.streams = result.streams.filter(
      (st: { url?: string; externalUrl?: string }) =>
        !isDecoyUrl(st.url || st.externalUrl || "")
    );
    if (result.streams.length > 0)
      await cacheSet(`stream:v4:${id}`, result, TTL.stream, env.STREAM_CACHE);
    return json(result);
  } catch (e) {
    return json({ streams: [], error: String(e) });
  }
}
