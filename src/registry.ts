// Registro único de fuentes: la tabla es la lista de los singletons de cada
// clase (SourceBase), que ya exponen la interfaz completa (prefix, catalogId,
// getCatalog/getMeta/getStreams + los hooks del fan-out toEpSlug/buildId e
// isEpisodeId). getCatalog, getMeta, getStreams y el chequeo /debug-all de
// index.ts recorren esta tabla, así que añadir una fuente es crear la clase,
// instanciar el singleton en su archivo y listar el objeto aquí (el orden
// importa: los catalogId se resuelven por startsWith en resolve.ts).
import { Env } from "./lib/types";
import { dlatSource, dplaySource } from "./sources/doramas";
import { kplaySource } from "./sources/kdramasplay";
import { yandiSource } from "./sources/yandispoiler";
import { doramasflixSource } from "./sources/doramasflix";
import { tudoramaSource } from "./sources/tudorama";
import { pandramaSource } from "./sources/pandrama";
import { doramaYtSource } from "./sources/doramasyt";
import { doramaSubSource } from "./sources/doramasub";
import { kisskhSource } from "./sources/kisskh";

/** Contrato que toda fuente singleton lista en SOURCES debe cumplir (los
 *  defaults de toEpSlug/buildId viven en SourceBase, así que son métodos
 *  concretos de cada instancia; las fuentes que se desvían del formato
 *  "prefijo:slug" los pisan en su clase). */
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
   *  streams; default SourceBase: quitar "{prefix}:"). Puede ser async
   *  (pandrama resuelve su video a "titulo-NxM" vía KV). */
  toEpSlug: (rawId: string, env?: Env) => string | Promise<string>;
  /** epSlug → id propio para el fan-out (default SourceBase:
   *  `${prefix}:${epSlug}`; yandi/kplay hacen `${prefix}:ep:${epSlug}`). */
  buildId: (epSlug: string) => string;
  /** ¿Es id de EPISODIO (aceptable por getStreams)? Los catálogos traen ids
   *  de serie/lista y el getter de streams solo acepta episodios, así que
   *  /debug-all separa por formato (ver sourceBase.ts). */
  isEpisodeId: (rawId: string) => boolean;
};

/** kplay/yandi comparten formato de id: `x:ep:slug`, `x:movie:slug` o suelto;
 *  los ids de película se representan como episodio 1x1. Ver
 *  YandiSource.toEpSlug (kplay lo hereda). */

export const SOURCES: SourceDef[] = [
  dlatSource,
  dplaySource,
  kplaySource,
  yandiSource,
  doramasflixSource,
  tudoramaSource,
  pandramaSource,
  doramaYtSource,
  doramaSubSource,
  kisskhSource,
];

export function sourceByPrefix(prefix: string): SourceDef | undefined {
  return SOURCES.find((s) => s.prefix === prefix);
}
