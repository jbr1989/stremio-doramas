import { Env } from "../types";
import { cacheGet, cacheSet } from "../utils";

// ─── slug mapping entre sitios ──────────────────────────────────────────────
//
// El fan-out de getStreams (index.ts) reutiliza el epSlug del sitio origen en
// los demás sitios, pero cada DooPlay nombra sus episodios con su propio slug.
// Cuando a un sitio le da 404, este módulo resuelve el slug correcto:
//   buscar la serie por título en el sitio → raspar su lista de episodios →
//   devolver el epSlug del SxE pedido. Cachea el mapa completo de la serie en
//   KV (TTL 24h), así los episodios siguientes salen de 1 lectura de KV sin
//   fetches. Fallo definivo → cache negativa (1h); timeouts y errores de red
//   NO la escriben (página lenta ≠ serie inexistente).
//
// Es genérico e inyectado (SiteAdapter) para evitar imports circulares: los
// adapters viven en kdramasplay.ts (kplay) y doramas.ts (dplay).

interface SiteAdapter {
  /** id estable para las claves KV */
  site: string;
  /** buscar la serie por título; devuelve slugs de serie candidatos */
  searchSeries: (title: string) => Promise<string[]>;
  /** raspar la página de serie; devuelve su lista de episodios */
  fetchEpisodes: (
    seriesSlug: string
  ) => Promise<{ s: number; e: number; epSlug: string }[]>;
}

const EP_MAP_TTL = 24 * 3600; // 24 h
const RESOLVE_BUDGET_MS = 12000;
const SCORE_MIN = 0.5; // contención mínima tokens título ↔ slug de serie

const TIMEOUT_SENTINEL = Symbol("timeout"); // resolución no terminó a tiempo
const ERROR_SENTINEL = Symbol("error"); // resolución terminó con error de red

// Stopwords: palabras sin valor de matching (artículos/preposiciones) y la
// basura que los DooPlay meten en slugs/títulos ("subtitulado", "latino"…).
const STOPWORDS = new Set([
  "de", "la", "el", "los", "las", "del", "y", "o", "a", "en", "con", "por",
  "para", "un", "una", "al", "su", "the", "of", "and", "from",
  "sub", "subtitulado", "subtitulada", "latino", "castellano", "dobrado",
  "doblada", "online", "hd", "completo", "estreno", "temporada", "ver",
]);

function parseSxE(epSlug: string): { s: number; e: number } | null {
  const m = epSlug.match(/-(\d+)x(\d+)$/);
  return m ? { s: parseInt(m[1], 10), e: parseInt(m[2], 10) } : null;
}

function titleFromEpSlug(epSlug: string): string {
  return epSlug.replace(/-\d+x\d+$/, "").replace(/-/g, " ").trim();
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9áéíóúñü]+/)
    .filter(Boolean)
    .filter((w) => !STOPWORDS.has(w));
}

/** Contención bidireccional: max(hits/|T|, hits/|C|). Da 1.0 cuando el slug
 * del sitio es una versión corta del título ("light-shop-subtitulado" para
 * "light shop entre la vida y la muerte") o una versión larga ("goblin-el-…"
 * para "goblin"). Un título multi-palabra exige ≥2 tokens comunes: evita que
 * un candidato con UNA palabra compartida ("muerte", "amor") se cuele cuando
 * la búsqueda se relajó a frase corta. */
function scoreSeries(titleTokens: string[], seriesSlug: string): number {
  const cand = tokenize(seriesSlug);
  if (!titleTokens.length || !cand.length) return 0;
  const candSet = new Set(cand);
  let hits = 0;
  for (const t of titleTokens) if (candSet.has(t)) hits++;
  if (hits < Math.min(2, titleTokens.length)) return 0;
  return Math.max(hits / titleTokens.length, hits / cand.length);
}

/** Variantes de búsqueda para el REST/LIKE de DooPlay: frase completa +
 * primeras 2 palabras significativas. Las variantes cortas NO falsean el
 * matching porque scoreSeries exige ≥2 tokens comunes (título largo). */
export function searchVariants(title: string): string[] {
  const sig = title
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const out = [title.trim()];
  if (sig.length >= 2) out.push(`${sig[0]} ${sig[1]}`);
  const seen = new Set<string>();
  return out.filter((v) => {
    const k = v.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function resolveEpisodeSlug(
  adapter: SiteAdapter,
  epSlug: string,
  env: Env
): Promise<string | null> {
  const kv = env.STREAM_CACHE;
  const sxe = parseSxE(epSlug);
  if (!sxe) return null;
  const sxEKey = `${sxe.s}x${sxe.e}`;
  const title = titleFromEpSlug(epSlug);
  const mapKey = `epmap:v1:${adapter.site}:${title}`;
  const negKey = `epmap:v1nx:${adapter.site}:${title}`;

  if (kv) {
    const cached = (await cacheGet(mapKey, kv)) as
      | Record<string, string>
      | null;
    if (cached && cached[sxEKey]) return cached[sxEKey];
    const neg = (await cacheGet(negKey, kv)) as boolean | null;
    if (neg) return null;
  }

  const work = (async (): Promise<string | null | typeof ERROR_SENTINEL> => {
    const tokens = tokenize(title);
    const candidates = await adapter.searchSeries(title);
    let best: string | null = null;
    let bestScore = 0;
    for (const c of candidates) {
      const sc = scoreSeries(tokens, c);
      if (sc > bestScore) {
        bestScore = sc;
        best = c;
      }
    }
    if (!best || bestScore < SCORE_MIN) {
      // Resultado limpio ("no está en este sitio") → sí aplica neg cache.
      console.log(
        `[slugmap] ${adapter.site}: sin candidato para "${title}" (mejor=${bestScore.toFixed(2)})`
      );
      return null;
    }
    const episodes = await adapter.fetchEpisodes(best);
    const map: Record<string, string> = {};
    for (const ep of episodes) map[`${ep.s}x${ep.e}`] = ep.epSlug;
    if (!map[sxEKey]) {
      console.log(
        `[slugmap] ${adapter.site}: serie "${best}" sin episodio ${sxEKey} (${episodes.length} eps)`
      );
      return null;
    }
    if (Object.keys(map).length > 0)
      await cacheSet(mapKey, map, EP_MAP_TTL, kv);
    return map[sxEKey];
  })().catch((e) => {
    console.log(`[slugmap] ${adapter.site}: resolve falló — ${e}`);
    return ERROR_SENTINEL;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    work,
    new Promise<typeof TIMEOUT_SENTINEL>(
      (resolve) => (timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), RESOLVE_BUDGET_MS))
    ),
  ]);
  if (timer) clearTimeout(timer);

  if (typeof result === "string") return result;
  // Timeout o error de red: NO cachea negativo (podría ser transitorio).
  return null;
}
