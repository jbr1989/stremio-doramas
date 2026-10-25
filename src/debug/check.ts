import { Env } from "../lib/types";
import { json } from "../lib/utils";
import { SOURCES, sourceByPrefix } from "../registry";
import {
  DebugCheck,
  DebugDeps,
  DEBUG_CONCURRENCY,
  debugMapLimit,
  debugRunOne,
} from "./helpers";

// ---------------------------------------------------------------------------
// /debug-all — chequeo de salud de las 7 fuentes en una sola llamada.
// A diferencia de /debug-extract (getStreams = fan-out mezclado), aquí se
// llama directo al getter de CADA fuente. Por defecto el chequeo es dinámico:
// se toman las series recientes de cada catálogo propio, se expanden a
// episodios vía getMeta y se prueban esos IDs reales (los DBG_IDS fijos se
// pudrían cuando un título cae del site). ?ids=id1,id2 hace override manual;
// ?n= cambia N (default 10, máx 25). Salida plana, una fila por episodio con
// sample = servidor/tipo/name/url de cada stream encontrado.
// ---------------------------------------------------------------------------

/** Cada fuente con el catalogId que la resuelve en getCatalog(). */
const DEBUG_SOURCES: { source: string; catalogId: string }[] = SOURCES.map(
  (s) => ({ source: s.prefix, catalogId: s.catalogId })
);

/** ¿Es este un id válido de EPISODIO de esta fuente? Los catálogos pueden
 *  traer metas de serie/lista; el getter de streams solo acepta episodios,
 *  así que filtramos por el formato del id de cada fuente. */
function debugIsEpisodeId(source: string, id: string): boolean {
  const def = sourceByPrefix(source);
  return def ? def.isEpisodeId(id) : false;
}

/** Dado un stream id con prefijo `fuente:`, construye la llamada al getter de esa fuente. */
function debugCheckFor(prefix: string, id: string, env: Env): DebugCheck | null {
  const def = sourceByPrefix(prefix);
  return def ? { source: prefix, id, run: () => def.getStreams(id, env) } : null;
}

/** /debug-extract — fan-out completo de getStreams() para un id concreto,
 *  con los streams en crudo (sin caché KV ni filtro isDecoyUrl). */
export async function debugExtract(
  url: URL,
  env: Env,
  deps: DebugDeps
): Promise<Response> {
  const id = url.searchParams.get("id") || "";
  if (!id)
    return json({
      error:
        "Missing ?id= (e.g. dflix:slug-1x1 or dlat:slug-1x1 or kplay:ep:slug)",
    });
  const t0 = Date.now();
  try {
    const result = await deps.getStreams(id, env);
    return json({
      id,
      totalMs: Date.now() - t0,
      streamsCount: result.streams.length,
      streams: result.streams,
    });
  } catch (e) {
    return json({
      id,
      totalMs: Date.now() - t0,
      error: String(e).slice(0, 300),
    });
  }
}

export async function debugAll(
  url: URL,
  env: Env,
  tmdbKey: string,
  deps: DebugDeps
): Promise<Response> {
  const { getCatalog, getMeta } = deps;
  const n = Math.max(
    1,
    Math.min(parseInt(url.searchParams.get("n") || "10", 10) || 10, 25)
  );
  const t01 = Date.now();

  // Override manual: solo los IDs pedidos, sin ir al catálogo.
  const idsParam = url.searchParams.get("ids");
  if (idsParam) {
    const wanted = idsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const checks: DebugCheck[] = [];
    const unknown: string[] = [];
    for (const id of wanted) {
      const prefix = id.split(":")[0];
      const check = debugCheckFor(prefix, id, env);
      if (check) checks.push(check);
      else unknown.push(id);
    }
    const rows = await debugMapLimit(checks, DEBUG_CONCURRENCY, (c) =>
      debugRunOne(c)
    );
    return json({
      modo: "manual",
      ids: checks.map((c) => c.id),
      unknown,
      results: rows,
      hint: "streams crudos: sin caché KV ni filtro isDecoyUrl. Los externalUrl (🌐) no reproducen — solo HLS y MP4 cuentan como reproducibles.",
    });
  }

  // Estándar: catálogo propio de cada fuente → series recientes →
  // expansión a episodios vía getMeta (los catálogos traen ids de SERIE;
  // el getter de streams solo acepta episodios) → su getter con
  // concurrencia limitada. Las 7 fuentes van en paralelo entre sí;
  // la salida es plana: una fila por episodio, como en el formato antiguo.
  const perSource = await Promise.all(
    DEBUG_SOURCES.map(
      async (s): Promise<Record<string, any>[]> => {
        let metas: any[] = [];
        let catalogOk = true;
        let catalogError: string | undefined;
        try {
          const cat: any = await getCatalog(s.catalogId, {}, env);
          metas = Array.isArray(cat?.metas) ? cat.metas : [];
        } catch (e) {
          catalogOk = false;
          catalogError = String(e).slice(0, 200);
        }

        // Series recientes (suficientes para llegar a n episodios, ~2/serie)
        const seriesIds = metas
          .map((m: any) => m?.id)
          .filter(
            (id: any) =>
              typeof id === "string" && !debugIsEpisodeId(s.source, id)
          )
          .slice(0, Math.max(2, Math.ceil(n / 2)));

        // Expansión serie → episodios (getMeta trae meta.videos[]), 3 en paralelo
        const epIds: string[] = [];
        await debugMapLimit(
          seriesIds,
          DEBUG_CONCURRENCY,
          async (seriesId: string): Promise<boolean> => {
            try {
              const m: any = await getMeta(seriesId, tmdbKey, env);
              const vids: any[] = Array.isArray(m?.meta?.videos)
                ? m.meta.videos
                : [];
              const valid = vids
                .map((v: any) => v?.id)
                .filter(
                  (id: any) =>
                    typeof id === "string" &&
                    debugIsEpisodeId(s.source, id)
                )
                .slice(0, Math.max(1, Math.ceil(n / 4)));
              const room = n - epIds.length;
              if (room <= 0) return true; // corta el resto de workers
              epIds.push(...valid.slice(0, room));
              return epIds.length >= n;
            } catch {
              return false; // serie sin meta utilizable: se salta
            }
          }
        );

        const checks = epIds
          .map((id) => debugCheckFor(s.source, id, env))
          .filter((c): c is DebugCheck => c !== null);
        const rows = await debugMapLimit(checks, DEBUG_CONCURRENCY, (c) =>
          debugRunOne(c)
        );
        // Sin episodios (catálogo roto o filtró todo): fila de contexto para que la fuente no desaparezca.
        if (!rows.length)
          return [
            {
              source: s.source,
              catalogOk,
              seriesProbadas: seriesIds.length,
              episodiosEncontrados: 0,
              ...(catalogError ? { catalogError } : {}),
            },
          ];
        return rows;
      }
    )
  );
  const results = perSource.flat();
  return json({
    modo: "latest",
    n,
    totalMs: Date.now() - t01,
    results,
    hint: "streams crudos: sin caché KV ni filtro isDecoyUrl. Los externalUrl (🌐) no reproducen — solo HLS y MP4 cuentan como reproducibles. Cada fila trae sample con servidor/tipo/name/url por stream.",
  });
}
