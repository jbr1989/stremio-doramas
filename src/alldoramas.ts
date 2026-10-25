import { Env } from "./lib/types";
import { cleanTitle } from "./lib/utils";
import { genreSlug } from "./genres";
import { dlatSource, dplaySource } from "./sources/doramas";
import { kplaySource } from "./sources/kdramasplay";
import { yandiSource } from "./sources/yandispoiler";
import { doramasflixSource } from "./sources/doramasflix";
import { tudoramaSource } from "./sources/tudorama";
import { pandramaSource } from "./sources/pandrama";
import { doramaYtSource } from "./sources/doramasyt";
import { doramaSubSource } from "./sources/doramasub";
import { kisskhSource } from "./sources/kisskh";

// ─── Catálogo consolidado "Todos los Doramas" ───────────────────────────────
// Orquesta los catálogos ya existentes en paralelo, fusiona, y de-duplica por
// título normalizado. Es la "opción A" (página espejo): el skip del catálogo
// se traduce en página N de cada fuente. No hace scraping nuevo — solo
// orquesta las getXCatalog que ya aceptan {search}/{skip}.
//
// El id ganador de cada título determina desde qué sitio se saca la /meta
// (poster/descripción); los streams salen igual por el fan-out de getStreams
// (slugmap + epmap), que es independiente del id elegido.

// Stremio avanza skip de 100 en 100 al paginar un catálogo.
const PAGE_SIZE = 100;

type SourceSpec = {
  name: string;
  /** Tamaño de página upstream de la fuente (el que su getXCatalog usa
   * internamente para convertir skip → página). */
  page: number;
  fetch: (
    extra: Record<string, string>,
    env?: Env
  ) => Promise<{ metas?: any[] }>;
};

// Orden = prioridad de fusion: el primer hit de un título gana. dflix
// primero (GraphQL, estructura estable); pandrama al final (su orden
// "views_day" cambia a diario, aporta variedad al final de la lista).
const SOURCES: SourceSpec[] = [
  { name: "dflix", page: 20, fetch: (e) => doramasflixSource.getCatalog(e) },
  { name: "dlat", page: 45, fetch: (e, env) => dlatSource.getCatalog(e, env) },
  { name: "dplay", page: 45, fetch: (e, env) => dplaySource.getCatalog(e, env) },
  { name: "dyt", page: 24, fetch: (e, env) => doramaYtSource.getCatalog(e, env) },
  { name: "dsub", page: 24, fetch: (e, env) => doramaSubSource.getCatalog(e, env) },
  { name: "tudorama", page: 24, fetch: (e, env) => tudoramaSource.getCatalog(e, env) },
  { name: "kplay", page: 24, fetch: (e, env) => kplaySource.getCatalog(e, env) },
  { name: "yandi", page: 24, fetch: (e, env) => yandiSource.getCatalog(e, env) },
  { name: "kisskh", page: 24, fetch: (e, env) => kisskhSource.getCatalog(e, env) },
  { name: "pandrama", page: 48, fetch: (e, env) => pandramaSource.getCatalog(e, env) },
];

/** Clave de dedup: cleanTitle ya limpia "Ver", "subtitulado", colas del tema;
 * aquí se baja a minúsculas sin acentos ni puntuación. Los ids de dedup NO
 * se usan (cada fuente nombra con slugs propios — la inversión del slugmap). */
function normKey(name: string): string {
  return cleanTitle(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

export async function getAllAlldoramasCatalog(
  extra: Record<string, string>,
  env?: Env
) {
  const q = (extra.search || "").trim();
  const page = Math.floor(parseInt(extra.skip || "0", 10) / PAGE_SIZE) + 1;

  // 1) Despacho en paralelo. Búsqueda: {search} plano para todas. Directorio:
  //    a cada fuente el skip que produce SU página N. Fallo de una fuente
  //    ≠ catálogo muerto: se registra y sigue con el resto.
  const perSource = await Promise.all(
    SOURCES.map(async (src) => {
      // Género solo en fuentes que lo tienen en la lista maestra canónica
      // (src/genres.ts): skip de las demás — dlat/dplay/kplay ahora SÍ
      // integran género (Opción B: archivos de término upstream, aunque
      // algunos devuelvan vacío hoy).
      if (extra.genre && !genreSlug(src.name, extra.genre)) return [];
      const perExtra: Record<string, string> = q
        ? { search: q }
        : extra.genre
        ? { skip: String((page - 1) * src.page), genre: extra.genre }
        : { skip: String((page - 1) * src.page) };
      try {
        const res = await src.fetch(perExtra, env);
        return (res.metas || []).filter((m) => m?.id && m?.name);
      } catch (e) {
        console.log(`[alldoramas] fuente ${src.name} falló (página ${page}): ${e}`);
        return [];
      }
    })
  );

  // 2) Fusión intercalada (round-robin): en cada índice entra el item de cada
  //    fuente, primer hit gana. Segundo objetivo: heredar un poster de un
  //    duplicado cuando el ganador viene sin poster.
  const seen = new Map<string, { meta: any; posterFallback?: string }>();
  const maxLen = Math.max(...perSource.map((l) => l.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (const list of perSource) {
      const meta = list[i];
      if (!meta) continue;
      const key = normKey(meta.name);
      if (!key) continue;
      const hit = seen.get(key);
      if (!hit) {
        seen.set(key, { meta });
      } else if (!hit.meta.poster && meta.poster) {
        hit.posterFallback ??= meta.poster;
      }
    }
  }

  const metas = [...seen.values()].map(({ meta, posterFallback }) => ({
    ...meta,
    poster: meta.poster || posterFallback || "",
  }));

  return { metas };
}
