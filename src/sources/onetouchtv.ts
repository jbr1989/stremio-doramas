import { Env } from "../lib/types";
import { cleanTitle, denoBaseFromEnv, makeStreamDeduper } from "../lib/utils";
import { SourceBase, SourceCard, SourceEpisode } from "../lib/sourceBase";
import { genreLabelForMeta } from "../genres";
import { resolveEpisodeSlug as slugResolve, searchVariants } from "../lib/slugmap";

const BASE_API = "https://api3.devcorp.me";
const AES_KEY_STRING = "im72charPasswordofdInitVectorStm";
const AES_IV_STRING = "im72charPassword";

let cachedKey: CryptoKey | null = null;
const ivBytes = new TextEncoder().encode(AES_IV_STRING);

async function getCryptoKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const rawKey = new TextEncoder().encode(AES_KEY_STRING);
  cachedKey = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-CBC" },
    false,
    ["decrypt"]
  );
  return cachedKey;
}

/** Temporada de una ficha de OneTouch: el site parte cada temporada en una
 *  ficha propia ("...-season-2-2026") y la API NO trae campo season — el
 *  identificador (slug) o el título lo delatan. Default 1. */
function seasonFromSlug(slugOrTitle: string): number {
  const m =
    slugOrTitle.match(/season[-\s]?(\d+)/i) ||
    slugOrTitle.match(/temporada[-\s]?(\d+)/i);
  return m ? parseInt(m[1], 10) : 1;
}

/** Identificadores de OneTouch, dos formas observadas en la API (oct. 2026):
 *    "556560-our-sticky-love-2026"  → id de BD (5-6 dígitos) + slug
 *    "100-days-my-prince"           → slug puro, SIN id
 *  El id numérico solo lo necesita la API de OneTouch; al resto de fuentes
 *  les llega dentro del epSlug canónico y se convierte en un token de la
 *  query de búsqueda que arruina el match ("556560 our sticky love 2026" →
 *  0 candidatos). Se quita SOLO el prefijo de 5+ dígitos: NO usar ^\d+-,
 *  porque hay slugs puros que empiezan por número y son fichas válidas
 *  ("100-days-my-prince" → 16 eps, "49-days-with-a-merman").
 *  Se conserva el año final: el scorer de slugmap es contención
 *  bidireccional (tolera tokens extra) y desambigua entre la ficha con id
 *  y la ficha pura de la misma serie. */
const ONETOUCH_ID_PREFIX = /^\d{5,}-/;

/** La API mete el año de estreno al final del título ("Our Sticky Love
 *  (2026)") y ADEMÁS lo manda en un campo `year` aparte (30/30 del popular).
 *  El año pertenece a releaseInfo de la ficha, no al nombre de la tarjeta:
 *  se quita de los strings preparados para mostrar/buscar, nunca de los
 *  datos crudos que lo alimentan. Opt-in en esta fuente: en las DooPlay el
 *  año puede ser parte del título real ("Reply 1988"), por lo que
 *  cleanTitle compartido NO lo toca. */
const TRAILING_YEAR = /\s*\((?:19|20)\d{2}\)\s*$/;

/** El año de estreno también viaja en el identificador de la ficha
 *  ("556560-our-sticky-love-2026"), donde estorba al fan-out: es un token
 *  más en la query de búsqueda de las otras fuentes y en el intento de URL
 *  directo (kplay solo acertó our-sticky-love-1x3 tras un rescate desde
 *  our-sticky-love-2026-1x3). Guard: solo se quita si quedan ≥2 palabras,
 *  para no destrozar títulos cuyo año forma parte del nombre ("reply-1988"
 *  → "reply" colisionaría con las tres entregas; "overdo-2026" se queda). */
function stripSlugYear(slug: string): string {
  const out = slug.replace(/-(?:19|20)\d{2}$/, "");
  return out.split("-").filter(Boolean).length >= 2 ? out : slug;
}

// El API devuelve slugs de género en inglés (vocabulario mydramalist). Se
// traduce a ES los unívocos; el resto pasa por genreLabelForMeta (humanizado),
// igual que el criterio de src/genres.ts para géneros no registrados.
const GENRE_ES: Record<string, string> = {
  comedy: "Comedia",
  romance: "Romance",
  drama: "Drama",
  crime: "Crimen",
  action: "Acción",
  "martial-arts": "Artes marciales",
  wuxia: "Wuxia",
  adventure: "Aventura",
  mystery: "Misterio",
  thriller: "Thriller",
  suspense: "Suspense",
  horror: "Horror",
  terror: "Terror",
  fantasy: "Fantasía",
  "sci-fi": "Ciencia ficción",
  history: "Histórico",
  historical: "Histórico",
  military: "Militar",
  political: "Política",
  psychological: "Psicológico",
  melodrama: "Melodrama",
  school: "Escolar",
  family: "Familia",
  music: "Música",
  food: "Gastronomía",
  youth: "Juvenil",
  sports: "Deportes",
  documentary: "Documental",
  reality: "Reality",
};

// Códigos HTTP de la API: llegó respuesta pero no es 2xx (p. ej. 404 =
// serie/episodio inexistente). NO es un problema de egress del Worker, así
// que el fallback por proxy Deno NO debe dispararse por ellos.
class ApiStatusError extends Error {
  status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} from ${url}`);
    this.status = status;
  }
}

/**
 * Petición HTTP a la API de OneTouch TV + desencriptado AES-256-CBC.
 */
async function requestDecrypted(url: string, via: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "*/*",
      Origin: "https://onetouchtv.xyz",
      Referer: "https://onetouchtv.xyz/",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new ApiStatusError(res.status, `${url}${via}`);
  }

  const raw = await res.text();
  if (!raw) return null;

  // Formato sustituido de Base64 de OneTouch TV:
  // '@' -> '+' y '-_.' -> '/'
  let b64 = raw.replace(/@/g, "+").replace(/-_\./g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);

  // Decodificar Base64 a binario
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }

  const key = await getCryptoKey();
  const decryptedBuf = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: ivBytes },
    key,
    bytes
  );

  const decryptedText = new TextDecoder().decode(decryptedBuf);
  return JSON.parse(decryptedText);
}

/**
 * Realiza un fetch a la API de OneTouch TV y desencripta la respuesta en AES-256-CBC.
 * Intento directo desde el Worker; si falla (p. ej. egress de Cloudflare
 * bloqueado por la API), reintenta por el proxy Deno (/fetch — su allowlist
 * ya incluye devcorp.me y el cuerpo cifrado llega intacto en texto plano).
 */
async function fetchDecrypted(path: string, env?: Env): Promise<any> {
  const url = `${BASE_API}${path.startsWith("/") ? "" : "/"}${path}`;
  try {
    return await requestDecrypted(url, "");
  } catch (e) {
    const denoBase = denoBaseFromEnv(env);
    // 404/4xx del upstream = "no existe" (normal en los rescates de slug):
    // reintentar por proxy solo tiene sentido si el fallo es de TRANSPORTE
    // (egress bloqueado, timeout, conexión).
    if (!denoBase || e instanceof ApiStatusError) throw e;
    console.log(`[onetouch] directo falló (${e}); reintento por proxy Deno`);
    return requestDecrypted(
      `${denoBase}/fetch?url=${encodeURIComponent(url)}`,
      " (proxy)"
    );
  }
}

export class OneTouchSource extends SourceBase {
  readonly prefix = "onetouch";
  readonly label = "OneTouch TV";
  readonly catalogId = "onetouch";

  // Identificador de episodio: "onetouch:ep:{identifier}:{playId}" o slug tradicional
  protected override readonly epIdPattern = "(?:ep:[^:]+:[^:]+|.+-\\d+x\\d+)";

  protected override get pageSize(): number {
    return 30;
  }

  override isEpisodeId(rawId: string): boolean {
    return (
      rawId.startsWith("onetouch:ep:") ||
      new RegExp(`^${this.prefix}:(?:${this.epIdPattern})$`).test(rawId)
    );
  }

  override async toEpSlug(rawId: string, env?: Env): Promise<string> {
    if (rawId.startsWith("onetouch:ep:")) {
      const parts = rawId.slice("onetouch:ep:".length).split(":");
      const identifier = stripSlugYear(parts[0].replace(ONETOUCH_ID_PREFIX, ""));
      const playId = parts[1];
      const sxeMatch = playId.match(/^(\d+)$/);
      const epNum = sxeMatch ? sxeMatch[1] : "1";
      // La temporada viene delatada por el identificador (el site parte cada
      // temporada en una ficha propia) y por defecto es 1. Se deduce del
      // identificador ORIGINAL (parts[0]): la limpieza del id prefijo no lo
      // afecta, pero así la regla no depende de la forma final.
      return `${identifier}-${seasonFromSlug(parts[0])}x${epNum}`;
    }
    return rawId.slice(this.prefix.length + 1);
  }

  override buildId(epSlug: string): string {
    const sxeMatch = epSlug.match(/^(.+)-(\d+)x(\d+)$/);
    if (sxeMatch) {
      const baseSlug = sxeMatch[1];
      const epNum = sxeMatch[3];
      return `onetouch:ep:${baseSlug}:${epNum}`;
    }
    return `onetouch:${epSlug}`;
  }

  // ─── Catálogo ────────────────────────────────────────────────────────────

  protected override buildSearchUrl(q: string): string {
    return `/vod/search?page=1&keyword=${encodeURIComponent(q)}`;
  }

  protected override buildListUrl(page: number): string {
    return `/vod/popular?page=${page}`;
  }

  protected override async fetchBody(pathOrUrl: string, env: Env): Promise<string> {
    try {
      const path = pathOrUrl.startsWith("http")
        ? new URL(pathOrUrl).pathname + new URL(pathOrUrl).search
        : pathOrUrl;
      const json = await fetchDecrypted(path, env);
      return JSON.stringify(json);
    } catch (e) {
      console.error(`[onetouch] fetchBody failed for ${pathOrUrl}: ${e}`);
      return "";
    }
  }

  protected override parseCards(resText: string): SourceCard[] {
    try {
      const data = JSON.parse(resText || "{}");
      const list = Array.isArray(data.result) ? data.result : [];
      const cards: SourceCard[] = [];
      for (const item of list) {
        // La API expone películas (type "movie") cuyo detalle trae
        // episodes: [] y cuyo /episode/N responde 404 — el manifest solo
        // declara catálogos "series" y no hay endpoint conocido para su
        // playback: filtrarlas para no mostrar entradas muertas en búsqueda.
        if (String(item.type).toLowerCase() === "movie") continue;
        const slug = String(item.id || item._id || "");
        const title = item.title || "";
        if (!slug || !title) continue;
        cards.push({
          slug,
          type: item.type === "movie" ? "movie" : "series",
          name: (cleanTitle(title) || title).replace(TRAILING_YEAR, "").trim(),
          poster: item.image || item.poster || "",
        });
      }
      return cards;
    } catch {
      return [];
    }
  }

  // ─── Meta ────────────────────────────────────────────────────────────────

  protected override async fetchMetaPage(
    slug: string,
    env?: Env
  ): Promise<unknown> {
    try {
      const res = await fetchDecrypted(`/web/vod/${slug}/detail`, env);
      return res?.result || null;
    } catch (e) {
      console.error(`[onetouch] meta failed for ${slug}: ${e}`);
      return null;
    }
  }

  protected override parseMetaBasics(data: unknown, slug: string) {
    const d = (data || {}) as any;
    const rawTitle = d.title || "";
    // El site mete el año en el título ("Our Sticky Love (2026)") y
    // fetchTmdb busca el nombre tal cual → sin match si va con año. Los
    // sacamos del name y lo devolvemos como year (fallback de releaseInfo).
    const year =
      String(d.year || "") ||
      (rawTitle.match(/\((\d{4})\)\s*$/)?.[1] ?? "") ||
      (String(d.id || slug).match(/\b(19|20)\d{2}$/)?.[0] ?? "");
    return {
      name:
        (cleanTitle(rawTitle) || `Drama ${slug}`)
          .replace(TRAILING_YEAR, "")
          .trim() || `Drama ${slug}`,
      poster: d.image || d.poster || "",
      description: d.description || "",
      year,
    };
  }

  protected override parseGenres(data: unknown): string[] {
    const d = (data || {}) as any;
    return (Array.isArray(d.genres) ? d.genres : []).map((g: unknown) =>
      typeof g === "string" && GENRE_ES[g]
        ? GENRE_ES[g]
        : genreLabelForMeta("onetouch", String(g))
    );
  }

  protected override listEpisodes(
    data: unknown,
    slug: string,
    _tmdb: any,
    _env?: Env
  ): SourceEpisode[] {
    const d = (data || {}) as any;
    const episodes: any[] = Array.isArray(d.episodes) ? d.episodes : [];
    const sitePoster = d.image || d.poster || "";

    // El site parte cada temporada en una ficha propia y la API no trae
    // campo season: se deduce del identificador/título (ver seasonFromSlug).
    const season =
      seasonFromSlug(String(d.id || "")) ||
      seasonFromSlug(String(d.title || "")) ||
      1;

    const list: SourceEpisode[] = [];

    for (const ep of episodes) {
      // Si el episodio está bloqueado para la app, no emitirlo
      if (ep.lockContentDetails?.lockContent) continue;

      const identifier = ep.identifier || d.id || slug;
      const playId = ep.playId || ep.episode || "1";
      const epNum = parseFloat(ep.episode || "1");
      const s = season;
      const e = Math.floor(epNum);

      list.push({
        id: `onetouch:ep:${identifier}:${playId}`,
        slug: `${identifier}-${s}x${e}`,
        s,
        e,
        thumb: ep.thumbnail || sitePoster,
      });
    }

    return list;
  }

  // ─── Streams ─────────────────────────────────────────────────────────────

  protected override buildPageUrl(slug: string): string {
    return slug;
  }

  protected override extractEmbeds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // ─── Rescate de slug (fan-out cruzado / IMDb) ────────────────────────────
  // El fan-out de streams reutiliza el epSlug canónico de la fuente ORIGEN,
  // cuya nomenclatura no es la de onetouch (y además onetouch numera sus
  // fichas: "556560-titulo-2026"). El engine de slugmap.ts busca la serie
  // por título y devuelve el epSlug propio ("{identifier}-{s}x{e}") para el
  // SxE pedido; el mapa completo queda cacheado (epmap:v1:onetouch:*, 24 h).

  protected override async resolveEpisodeSlug(
    epSlug: string,
    env: Env
  ): Promise<string | null> {
    return slugResolve(
      {
        site: this.prefix,
        searchSeries: async (title) => {
          const out: string[] = [];
          for (const variant of searchVariants(title)) {
            try {
              const json = await fetchDecrypted(
                `/vod/search?page=1&keyword=${encodeURIComponent(variant)}`,
                env
              );
              for (const item of json?.result || []) {
                // Las movies no tienen playback: no son candidatos válidos.
                if (String(item.type).toLowerCase() === "movie") continue;
                const id = String(item.id || "");
                if (id && !out.includes(id)) out.push(id);
              }
            } catch (e) {
              console.log(`[onetouch] search "${variant}" falló: ${e}`);
            }
            // La frase completa con hits basta; las variantes cortas son
            // para el caso 0-hits.
            if (out.length) break;
          }
          return out;
        },
        fetchEpisodes: async (seriesId) => {
          const detail = await fetchDecrypted(`/web/vod/${seriesId}/detail`, env);
          const d = (detail?.result || {}) as any;
          const season =
            seasonFromSlug(String(d.id || seriesId)) ||
            seasonFromSlug(String(d.title || "")) ||
            1;
          return (Array.isArray(d.episodes) ? d.episodes : []).map((ep: any) => {
            const e = Math.floor(parseFloat(ep.episode || "1"));
            return {
              s: season,
              e,
              epSlug: `${ep.identifier || d.id || seriesId}-${season}x${e}`,
            };
          });
        },
      },
      epSlug,
      env
    );
  }

  override async getStreams(
    rawId: string,
    env: Env
  ): Promise<{ streams: any[] }> {
    let identifier = "";
    let playId = "";

    if (rawId.startsWith("onetouch:ep:")) {
      const parts = rawId.slice("onetouch:ep:".length).split(":");
      identifier = parts[0];
      playId = parts[1];
    } else {
      // Formato "onetouch:slug-1x1" o "onetouch:slug"
      const clean = rawId.replace(/^onetouch:/, "");
      const m = clean.match(/^(.+)-(\d+)x(\d+)$/);
      if (m) {
        identifier = m[1];
        playId = m[3];
      } else {
        identifier = clean;
        playId = "1";
      }
    }

    if (!identifier || !playId) return { streams: [] };

    // Intentar obtener el detalle del episodio
    let epData: any = null;
    try {
      epData = await fetchDecrypted(`/web/vod/${identifier}/episode/${playId}`, env);
    } catch {
      // Fallback a buscar por título / slugmap si fuera necesario
    }

    if (!epData?.success || !epData?.result) {
      // Intento alternativo con detalle de la serie si identifier era un slug general
      try {
        const detail = await fetchDecrypted(`/web/vod/${identifier}/detail`, env);
        if (detail?.result?.episodes) {
          const matchEp = detail.result.episodes.find(
            (e: any) =>
              String(e.episode) === String(playId) ||
              String(e.playId) === String(playId)
          );
          if (matchEp && (matchEp.identifier !== identifier || matchEp.playId !== playId)) {
            epData = await fetchDecrypted(
              `/web/vod/${matchEp.identifier || identifier}/episode/${matchEp.playId || matchEp.episode}`,
              env
            );
          }
        }
      } catch {}
    }

    if (!epData?.success || !epData?.result) {
      // Rescate: el id puede venir del fan-out de OTRA fuente (su slug, no
      // el de onetouch). El engine de slugmap.ts busca la serie por título
      // (caché epmap 24 h) y devuelve el epSlug propio correcto para el
      // SxE pedido; se reintenta con el identificador/número resuelto.
      const epSlug = await this.toEpSlug(rawId, env);
      const rescued = await this.resolveEpisodeSlug(epSlug, env);
      if (rescued && rescued !== epSlug) {
        const m = rescued.match(/^(.+)-(\d+)x(\d+)$/);
        if (m) {
          try {
            epData = await fetchDecrypted(
              `/web/vod/${m[1]}/episode/${m[3]}`,
              env
            );
          } catch {}
        }
      }
    }

    if (!epData?.success || !epData?.result) {
      return { streams: [] };
    }

    const res = epData.result;
    const sources: any[] = Array.isArray(res.sources) ? res.sources : [];
    const tracks: any[] = Array.isArray(res.track) ? res.track : [];

    const { add, streams } = makeStreamDeduper();

    // Formatear subtítulos
    const langPriority: Record<string, number> = {
      es: 0,
      en: 1,
      pt: 2,
    };
    // Una pista por idioma (el site puede repetir código); el resto de la
    // prioridad las ordena después.
    const seenLang = new Set<string>();
    const subtitles = tracks
      .filter((t) => t.file && /^https?:\/\//i.test(t.file))
      .filter((t) => {
        const key = String(t.code || t.name);
        if (seenLang.has(key)) return false;
        seenLang.add(key);
        return true;
      })
      .sort((a, b) => {
        const pa = langPriority[a.code] ?? 10;
        const pb = langPriority[b.code] ?? 10;
        return pa - pb;
      })
      .slice(0, 5)
      .map((t) => ({
        id: `onetouch-${t.code || t.name}`,
        url: t.file,
        ext: "vtt" as const,
        lang: t.code || "und",
        label: t.name || t.code || "Sub",
      }));

    for (const src of sources) {
      const url = src.url;
      if (!url || !/^https?:\/\//i.test(url)) continue;

      const serverName = src.name || "OneTouch";
      const quality = src.quality ? ` [${src.quality}]` : "";
      const isHls = src.type === "hls" || /\.m3u8/i.test(url);
      const isDash = src.type === "dash" || /\.mpd/i.test(url);

      if (isHls) {
        add({
          url,
          name: `OneTouch (${serverName})`,
          title: `▶ OneTouch — ${serverName}${quality}`,
          behaviorHints: {
            notWebReady: false,
            filename: `${identifier}-${playId}.m3u8`,
            bingeGroup: `onetouch-${serverName}`,
          },
          ...(subtitles.length ? { subtitles } : {}),
        });
      } else if (isDash) {
        // Formato DASH (.mpd): soporte irregular en clientes Stremio (sobre
        // todo web) — se marca notWebReady para que el cliente decida
        // (external/abrir fuera) en vez de intentar reproducir y fallar.
        add({
          url,
          name: `OneTouch DASH (${serverName})`,
          title: `▶ OneTouch (DASH) — ${serverName}${quality}`,
          behaviorHints: {
            notWebReady: true,
            filename: `${identifier}-${playId}.mpd`,
            bingeGroup: `onetouch-${serverName}`,
          },
          ...(subtitles.length ? { subtitles } : {}),
        });
      } else {
        // MP4 directo u otro formato
        add({
          url,
          name: `OneTouch (${serverName})`,
          title: `▶ OneTouch — ${serverName}${quality}`,
          behaviorHints: {
            notWebReady: false,
            filename: `${identifier}-${playId}.mp4`,
            bingeGroup: `onetouch-${serverName}`,
          },
          ...(subtitles.length ? { subtitles } : {}),
        });
      }
    }

    return { streams };
  }
}

export const oneTouchSource = new OneTouchSource();
