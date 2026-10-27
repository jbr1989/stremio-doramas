import { Env } from "./lib/types";
import { makeStreamDeduper } from "./lib/utils";
import { SOURCES, sourceByPrefix } from "./registry";
import { getAllAlldoramasCatalog } from "./alldoramas";
import {
  getMetaFromImdb,
  imdbToEpisodeId,
  isImdbId,
  parseImdbId,
} from "./lib/imdb";

// ---------------------------------------------------------------------------
// Camada de dispatch entre el router HTTP y las fuentes: dado un catalogId o
// un id de stream (con prefijo p.ej. `dflix:`), determinar la(s) fuente(s)
// que corresponden y delegar en ellas. getCatalog/getMeta resuelven a UNA
// fuente; getStreams hace fan-out a TODAS las fuentes para reunir el máximo
// de opciones de cada episodio.
// ---------------------------------------------------------------------------

export async function getCatalog(
  catalogId: string,
  extra: Record<string, string>,
  env?: Env
) {
  if (catalogId.startsWith("alldoramas"))
    return getAllAlldoramasCatalog(extra, env);
  // El orden de SOURCES importa: los catalogId no se solapan, pero se
  // respeta el orden de registro igual que en la cadena original.
  const def = SOURCES.find((s) => catalogId.startsWith(s.catalogId));
  // Un catalogId desconocido responde vacío en vez de recaer en otra fuente:
  // el fallback anterior (dflix) devolvía catálogo para id cualquiera y
  // catalogRoute cacheaba cada clave nueva → escrituras KV ilimitadas.
  return def ? def.getCatalog(extra, env) : { metas: [] };
}

export async function getMeta(id: string, tmdbKey: string, env?: Env) {
  // Ids IMDb ("tt…" o "tt:s:e"): meta ligera desde TMDB con videos "tt:s:e",
  // para que Stremio pida stream por episodio con temporada y número.
  if (env && isImdbId(id)) {
    const ref = parseImdbId(id)!;
    return getMetaFromImdb(ref, tmdbKey, env);
  }
  const def = sourceByPrefix(id.split(":")[0]);
  return def ? def.getMeta(id, tmdbKey, env) : { meta: null };
}

export async function getStreams(rawId: string, env: Env) {
  // Fan-out de streams desde ids IMDb: resolver primero ("tt" → nombre →
  // id de episodio de una fuente) y reusar la misma cadena del fan-out.
  if (isImdbId(rawId)) {
    const ref = parseImdbId(rawId)!;
    const tmdbKey = (env.TMDB_KEY || "").trim();
    const epId = await imdbToEpisodeId(ref, tmdbKey, env);
    if (!epId) return { streams: [], error: "no imdb match" };
    rawId = epId;
  }
  // Slug canónico compartido: cada fuente traduce su id propio (la tabla
  // registry soporta toEpSlug async, p.ej. pandrama resuelve su video vía KV).
  const def = sourceByPrefix(rawId.split(":")[0]);
  let epSlug = "";
  if (def) {
    epSlug = (await def.toEpSlug(rawId, env)) || "";
  }

  const tasks: Promise<{ streams: any[] }>[] = [];

  for (const s of SOURCES) {
    if (rawId.startsWith(`${s.prefix}:`)) {
      tasks.push(s.getStreams(rawId, env));
    } else if (epSlug) {
      tasks.push(s.getStreams(s.buildId(epSlug), env));
    }
  }

  const results = await Promise.allSettled(tasks);
  const { add, streams } = makeStreamDeduper();

  for (const res of results) {
    if (res.status === "fulfilled" && Array.isArray(res.value?.streams)) {
      for (const st of res.value.streams) add(st);
    }
  }

  return { streams };
}
