// Registro único de fuentes: la tabla apunta a los singletons de cada clase
// (SourceBase) y a cómo traducir su id de stream al slug canónico compartido
// (fan-out). getCatalog, getMeta, getStreams y el chequeo /debug-all de
// index.ts recorren esta tabla, así que añadir una fuente es crear la clase,
// instanciar el singleton en su archivo y añadir una entrada aquí.
import { Env } from "./lib/types";
import { dlatSource, dplaySource } from "./sources/doramas";
import { kplaySource } from "./sources/kdramasplay";
import { yandiSource } from "./sources/yandispoiler";
import { doramasflixSource } from "./sources/doramasflix";
import { tudoramaSource } from "./sources/tudorama";
import { pandramaSource, pandramaEpCanonicalSlug } from "./sources/pandrama";
import { canonicalDytSlug, doramaYtSource } from "./sources/doramasyt";
import { canonicalDoramaSubSlug, doramaSubSource } from "./sources/doramasub";
import { kisskhSource } from "./sources/kisskh";

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
  /** ¿Es id de EPISODIO (aceptable por getStreams)? Delegado del método
   *  isEpisodeId() de la clase fuente: los catálogos traen ids de
   *  serie/lista y el getter de streams solo acepta episodios, así que
   *  /debug-all separa por formato (ver sourceBase.ts). */
  isEpisodeId: (rawId: string) => boolean;
};

/** kplay/yandi comparten formato de id: `x:ep:slug`, `x:movie:slug` o suelto;
 *  los ids de película se representan como episodio 1x1. Ver
 *  YandiSource.toEpSlug (kplay lo hereda). */

export const SOURCES: SourceDef[] = [
  {
    prefix: "dlat",
    catalogId: "doramaslat",
    getCatalog: (extra, env) => dlatSource.getCatalog(extra, env),
    getMeta: (id, tmdbKey, env) => dlatSource.getMeta(id, tmdbKey, env),
    getStreams: (id, env) => dlatSource.getStreams(id, env),
    isEpisodeId: (id) => dlatSource.isEpisodeId(id),
  },
  {
    prefix: "dplay",
    catalogId: "doramedplay",
    getCatalog: (extra, env) => dplaySource.getCatalog(extra, env),
    getMeta: (id, tmdbKey, env) => dplaySource.getMeta(id, tmdbKey, env),
    getStreams: (id, env) => dplaySource.getStreams(id, env),
    isEpisodeId: (id) => dplaySource.isEpisodeId(id),
  },
  {
    prefix: "kplay",
    catalogId: "kplay",
    getCatalog: (extra, env) => kplaySource.getCatalog(extra, env),
    getMeta: (id, tmdbKey, env) => kplaySource.getMeta(id, tmdbKey, env),
    getStreams: (id, env) => kplaySource.getStreams(id, env),
    toEpSlug: (id) => kplaySource.toEpSlug(id),
    buildId: (epSlug) => kplaySource.buildId(epSlug),
    isEpisodeId: (id) => kplaySource.isEpisodeId(id),
  },
  {
    prefix: "yandi",
    catalogId: "yandispoiler",
    getCatalog: (extra, env) => yandiSource.getCatalog(extra, env),
    getMeta: (id, tmdbKey, env) => yandiSource.getMeta(id, tmdbKey, env),
    getStreams: (id, env) => yandiSource.getStreams(id, env),
    toEpSlug: (id) => yandiSource.toEpSlug(id),
    buildId: (epSlug) => yandiSource.buildId(epSlug),
    isEpisodeId: (id) => yandiSource.isEpisodeId(id),
  },
  {
    prefix: "dflix",
    catalogId: "doramasflix",
    getCatalog: (extra) => doramasflixSource.getCatalog(extra),
    getMeta: (id, tmdbKey) => doramasflixSource.getMeta(id, tmdbKey),
    getStreams: (id, env) => doramasflixSource.getStreams(id, env),
    isEpisodeId: (id) => doramasflixSource.isEpisodeId(id),
  },
  {
    prefix: "tudorama",
    catalogId: "tudorama",
    getCatalog: (extra, env) => tudoramaSource.getCatalog(extra, env),
    getMeta: (id, tmdbKey, env) => tudoramaSource.getMeta(id, tmdbKey, env),
    getStreams: (id, env) => tudoramaSource.getStreams(id, env),
    isEpisodeId: (id) => tudoramaSource.isEpisodeId(id),
  },
  {
    prefix: "pandrama",
    catalogId: "pandrama",
    getCatalog: (extra, env) => pandramaSource.getCatalog(extra, env),
    getMeta: (id, tmdbKey, env) => pandramaSource.getMeta(id, tmdbKey, env),
    getStreams: (id, env) => pandramaSource.getStreams(id, env),
    isEpisodeId: (id) => pandramaSource.isEpisodeId(id),
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
    getCatalog: (extra, env) => doramaYtSource.getCatalog(extra, env),
    getMeta: (id, tmdbKey, env) => doramaYtSource.getMeta(id, tmdbKey, env),
    getStreams: (id, env) => doramaYtSource.getStreams(id, env),
    // DYT usa "titulo-episodio-N": a la forma canónica "titulo-1xN" para que
    // las demás fuentes (que guardan sobre -\d+x\d+$) acepten el slug.
    toEpSlug: (rawId) => canonicalDytSlug(rawId.slice("dyt:".length)),
    isEpisodeId: (id) => doramaYtSource.isEpisodeId(id),
  },
  {
    prefix: "dsub",
    catalogId: "doramasub",
    getCatalog: (extra, env) => doramaSubSource.getCatalog(extra, env),
    getMeta: (id, tmdbKey, env) => doramaSubSource.getMeta(id, tmdbKey, env),
    getStreams: (id, env) => doramaSubSource.getStreams(id, env),
    toEpSlug: (rawId) => canonicalDoramaSubSlug(rawId.slice("dsub:".length)),
    isEpisodeId: (id) => doramaSubSource.isEpisodeId(id),
  },
  {
    prefix: "kisskh",
    catalogId: "kisskh",
    getCatalog: (extra, env) => kisskhSource.getCatalog(extra, env),
    getMeta: (id, tmdbKey, env) => kisskhSource.getMeta(id, tmdbKey, env),
    getStreams: (id, env) => kisskhSource.getStreams(id, env),
    isEpisodeId: (id) => kisskhSource.isEpisodeId(id),
  },
];

export function sourceByPrefix(prefix: string): SourceDef | undefined {
  return SOURCES.find((s) => s.prefix === prefix);
}
