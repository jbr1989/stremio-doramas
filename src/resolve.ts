import { Env } from "./lib/types";
import { makeStreamDeduper } from "./lib/utils";
import { SOURCES, sourceByPrefix } from "./registry";
import { doramasflixSource } from "./sources/doramasflix";
import { getAllAlldoramasCatalog } from "./alldoramas";

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
  return def ? def.getCatalog(extra, env) : doramasflixSource.getCatalog(extra);
}

export async function getMeta(id: string, tmdbKey: string, env?: Env) {
  const def = sourceByPrefix(id.split(":")[0]);
  return def ? def.getMeta(id, tmdbKey, env) : { meta: null };
}

export async function getStreams(rawId: string, env: Env) {
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
