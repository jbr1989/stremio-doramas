// Registro único de fuentes: cada fuente declara aquí sus getters y cómo
// traducir su id de stream al slug canónico compartido (fan-out). getCatalog,
// getMeta, getStreams y el chequeo /debug-all de index.ts recorren esta tabla,
// así que añadir una fuente es añadir una entrada aquí y nada más.
import { Env } from "../types";
import {
  DORAMA_SOURCES,
  getDoramaCatalog,
  getDoramaMeta,
  getDoramaStreams,
} from "./doramas";
import { getKplayCatalog, getKplayMeta, getKplayStreams } from "./kdramasplay";
import { getYandiCatalog, getYandiMeta, getYandiStreams } from "./yandispoiler";
import {
  getDoramasflixCatalog,
  getDoramasflixMeta,
  getDoramasflixStreams,
} from "./doramasflix";
import { getTudoramaCatalog, getTudoramaMeta, getTudoramaStreams } from "./tudorama";
import {
  getPandramaCatalog,
  getPandramaMeta,
  getPandramaStreams,
  pandramaEpCanonicalSlug,
} from "./pandrama";
import {
  canonicalDytSlug,
  getDoramaYtCatalog,
  getDoramaYtMeta,
  getDoramaYtStreams,
} from "./doramasyt";
import {
  canonicalDoramaSubSlug,
  getDoramaSubCatalog,
  getDoramaSubMeta,
  getDoramaSubStreams,
} from "./doramasub";
import { getKisskhCatalog, getKisskhMeta, getKisskhStreams } from "./kisskh";

export type SourceDef = {
  /** Prefijo de id de stream/meta, p.ej. "kplay" → "kplay:ep:slug-1x2". */
  prefix: string;
  /** catalogId que resuelve esta fuente en /catalog (match por startsWith,
   *  respetando el orden de la tabla). */
  catalogId: string;
  getCatalog: (extra: Record<string, string>, env?: Env) => Promise<any>;
  getMeta: (id: string, tmdbKey: string, env?: Env) => Promise<any>;
  getStreams: (id: string, env: Env) => Promise<{ streams: any[] }>;
  /** id propio → epSlug canónico compartido entre fuentes (fan-out de
   *  streams). Ausente = `rawId.slice(prefix.length + 1)`. Puede ser async
   *  (pandrama resuelve su video a "titulo-NxM" vía KV). */
  toEpSlug?: (rawId: string, env: Env) => string | Promise<string>;
  /** epSlug → id propio para el fan-out (default `${prefix}:${epSlug}`). */
  buildId?: (epSlug: string) => string;
  /** Formato de id de EPISODIO de esta fuente (para /debug-all):
   *  los catálogos traen ids de serie/lista y el getter de streams solo
   *  acepta episodios. Default `^prefix:…-\d+x\d+$`. */
  episodeIdRe?: RegExp;
};

/** kplay/yandi comparten formato de id: `x:ep:slug`, `x:movie:slug` o suelto;
 *  los ids de película se representan como episodio 1x1. */
function kplayYandiEpSlug(rawId: string): string {
  const parts = rawId.split(":");
  if (parts[1] === "ep") return parts.slice(2).join(":");
  if (parts[1] === "movie") return `${parts.slice(2).join(":")}-1x1`;
  return parts.slice(1).join(":");
}

export const SOURCES: SourceDef[] = [
  {
    prefix: "dlat",
    catalogId: "doramaslat",
    getCatalog: (extra, env) => getDoramaCatalog(DORAMA_SOURCES.dlat, extra, env),
    getMeta: (id, tmdbKey, env) => getDoramaMeta(DORAMA_SOURCES.dlat, id, tmdbKey, env),
    getStreams: (id, env) => getDoramaStreams(DORAMA_SOURCES.dlat, id, env),
  },
  {
    prefix: "dplay",
    catalogId: "doramedplay",
    getCatalog: (extra, env) => getDoramaCatalog(DORAMA_SOURCES.dplay, extra, env),
    getMeta: (id, tmdbKey, env) => getDoramaMeta(DORAMA_SOURCES.dplay, id, tmdbKey, env),
    getStreams: (id, env) => getDoramaStreams(DORAMA_SOURCES.dplay, id, env),
  },
  {
    prefix: "kplay",
    catalogId: "kplay",
    getCatalog: (extra, env) => getKplayCatalog(extra, env),
    getMeta: (id, tmdbKey, env) => getKplayMeta(id, tmdbKey, env),
    getStreams: (id, env) => getKplayStreams(id, env),
    toEpSlug: kplayYandiEpSlug,
    buildId: (epSlug) => `kplay:ep:${epSlug}`,
    episodeIdRe: /^kplay:(?:ep:.+-\d+x\d+|movie:.+)$/,
  },
  {
    prefix: "yandi",
    catalogId: "yandispoiler",
    getCatalog: (extra, env) => getYandiCatalog(extra, env),
    getMeta: (id, tmdbKey, env) => getYandiMeta(id, tmdbKey, env),
    getStreams: (id, env) => getYandiStreams(id, env),
    toEpSlug: kplayYandiEpSlug,
    buildId: (epSlug) => `yandi:ep:${epSlug}`,
    episodeIdRe: /^yandi:(?:ep:.+-\d+x\d+|movie:.+)$/,
  },
  {
    prefix: "dflix",
    catalogId: "doramasflix",
    getCatalog: (extra) => getDoramasflixCatalog(extra),
    getMeta: (id, tmdbKey) => getDoramasflixMeta(id, tmdbKey),
    getStreams: (id, env) => getDoramasflixStreams(id, env),
  },
  {
    prefix: "tudorama",
    catalogId: "tudorama",
    getCatalog: (extra, env) => getTudoramaCatalog(extra, env),
    getMeta: (id, tmdbKey, env) => getTudoramaMeta(id, tmdbKey, env),
    getStreams: (id, env) => getTudoramaStreams(id, env),
  },
  {
    prefix: "pandrama",
    catalogId: "pandrama",
    getCatalog: (extra, env) => getPandramaCatalog(extra, env),
    getMeta: (id, tmdbKey, env) => getPandramaMeta(id, tmdbKey, env),
    getStreams: (id, env) => getPandramaStreams(id, env),
    toEpSlug: async (rawId, env) => {
      const content = rawId.slice("pandrama:".length);
      if (!content.includes(":ep:")) return content;
      // pandrama:{titleId}:ep:{videoId} — el video no da slug comparable: se
      // resuelve (async, cacheada en KV) a "titulo-NxM" para el fan-out.
      return (await pandramaEpCanonicalSlug(content.split(":ep:")[1] || "", env)) || "";
    },
  },
  {
    prefix: "dyt",
    catalogId: "doramasyt",
    getCatalog: (extra, env) => getDoramaYtCatalog(extra, env),
    getMeta: (id, tmdbKey, env) => getDoramaYtMeta(id, tmdbKey, env),
    getStreams: (id, env) => getDoramaYtStreams(id, env),
    // DYT usa "titulo-episodio-N": a la forma canónica "titulo-1xN" para que
    // las demás fuentes (que guardan sobre -\d+x\d+$) acepten el slug.
    toEpSlug: (rawId) => canonicalDytSlug(rawId.slice("dyt:".length)),
  },
  {
    prefix: "dsub",
    catalogId: "doramasub",
    getCatalog: (extra, env) => getDoramaSubCatalog(extra, env),
    getMeta: (id, tmdbKey, env) => getDoramaSubMeta(id, tmdbKey, env),
    getStreams: (id, env) => getDoramaSubStreams(id, env),
    toEpSlug: (rawId) => canonicalDoramaSubSlug(rawId.slice("dsub:".length)),
  },
  {
    prefix: "kisskh",
    catalogId: "kisskh",
    getCatalog: (extra, env) => getKisskhCatalog(extra, env),
    getMeta: (id, tmdbKey, env) => getKisskhMeta(id, tmdbKey, env),
    getStreams: (id, env) => getKisskhStreams(id, env),
  },
];

export function sourceByPrefix(prefix: string): SourceDef | undefined {
  return SOURCES.find((s) => s.prefix === prefix);
}

/** Regex de id de episodio de una fuente (con default genérico). */
export function episodeIdReFor(source: string): RegExp | null {
  const def = sourceByPrefix(source);
  return def ? def.episodeIdRe ?? new RegExp(`^${def.prefix}:.+-\\d+x\\d+$`) : null;
}
