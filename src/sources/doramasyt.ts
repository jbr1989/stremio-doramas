import { Env } from "../types";
import { genreSlug } from "../genres";
import { CHROME_UA, cleanTitle, decodeEntities, denoBaseFromEnv, fetchHtml, fetchTmdb, makeStreamDeduper, netFetch, toMetaPreview } from "../utils";
import { addEmbedStreams } from "../extractors";
import { genresFromBadgeBlock } from "./dooplay";
import { resolveEpisodeSlug, searchVariants } from "./slugmap";

export const DORAMASYT_BASE = "https://www.doramasyt.com";

export function parseDoramaYtCards(html: string) {
  const results: { id: string; name: string; poster: string }[] = [];
  const seen = new Set<string>();

  const push = (slug: string, rawPoster: string, rawName: string) => {
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    const poster = rawPoster.startsWith("http")
      ? rawPoster
      : rawPoster
      ? `${DORAMASYT_BASE}${rawPoster}`
      : "";
    results.push({
      id: `dyt:${slug}`,
      name: cleanTitle(rawName) || slug,
      poster,
    });
  };

  for (const m of html.matchAll(
    /\/dorama\/([a-z0-9-]+)"[\s\S]*?data-src="([^"]+)"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi
  )) {
    push(m[1], m[2], m[3].trim());
  }

  for (const m of html.matchAll(
    /\/dorama\/([a-z0-9-]+)"[\s\S]*?alt="Ver\s+([^"]+?)\s+online[\s\S]*?data-src="([^"]+)"/gi
  )) {
    push(m[1], m[3], m[2].trim());
  }

  return results.slice(0, 100);
}

export async function getDoramaYtCatalog(
  extra: Record<string, string>,
  env?: Env
) {
  const q = (extra.search || "").trim();
  if (q) {
    let html = "";
    try {
      html = await fetchHtml(`${DORAMASYT_BASE}/buscar?q=${encodeURIComponent(q)}`, env);
    } catch {
      html = "";
    }
    if (!html || !html.includes("/dorama/")) {
      try {
        html = await fetchHtml(`${DORAMASYT_BASE}/doramas`, env);
      } catch {
        html = "";
      }
    }
    const cards = parseDoramaYtCards(html);
    const filtered = q
      ? cards.filter(
          (c) =>
            c.name.toLowerCase().includes(q.toLowerCase()) ||
            c.id.toLowerCase().includes(q.toLowerCase())
        )
      : cards;
    return { metas: (filtered.length > 0 ? filtered : cards).map(toMetaPreview) };
  }

  // Género (label ES → slug vía la lista maestra canónica, src/genres.ts).
  // doramasyt pagina sus archivos de género con ?p=N (el /page/N/ da 404 y
  // ?page= redirige a ?p=): usamos ?p= directo.
  const g = (extra.genre || "").trim();
  if (g) {
    const slug = genreSlug("dyt", g);
    if (!slug) return { metas: [] };
    const gpage = Math.floor(parseInt(extra.skip || "0", 10) / 24) + 1;
    const gpath =
      gpage > 1
        ? `${DORAMASYT_BASE}/genero/${slug}?p=${gpage}`
        : `${DORAMASYT_BASE}/genero/${slug}`;
    let ghtml = "";
    try {
      ghtml = await fetchHtml(gpath, env);
    } catch {
      ghtml = "";
    }
    return { metas: parseDoramaYtCards(ghtml).map(toMetaPreview) };
  }

  const page = Math.floor(parseInt(extra.skip || "0", 10) / 24) + 1;
  const path = page > 1 ? `${DORAMASYT_BASE}/doramas?p=${page}` : `${DORAMASYT_BASE}/doramas`;
  let html = "";
  try {
    html = await fetchHtml(path, env);
  } catch {
    html = "";
  }
  return {
    metas: parseDoramaYtCards(html).map(toMetaPreview),
  };
}

export async function getDoramaYtMeta(
  id: string,
  tmdbKey: string,
  env?: Env
) {
  const slug = id.replace("dyt:", "");
  let html = "";
  try {
    html = await fetchHtml(`${DORAMASYT_BASE}/dorama/${slug}`, env);
  } catch {
    return { meta: null };
  }

  const name =
    cleanTitle(
      html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
        html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] ||
        html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ||
        slug
    ) || slug;

  const poster =
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1] ||
    html.match(/data-src=["'](https?:\/\/[^"'\s]+\/thumbs\/imagen\/[^"'\s]+)["']/i)?.[1] ||
    "";

  const description = decodeEntities(
    html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1] ||
      html.match(/<p>([\s\S]*?)<\/p>/i)?.[1] ||
      ""
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const ep1Match = html.match(/\/ver\/([a-z0-9-]+-episodio-)1["'\s>]/i);
  const baseEpSlug = ep1Match ? ep1Match[1] : `${slug.replace(/-sub-espanol$/, "")}-episodio-`;

  // Géneros de la ficha: badges del bloque lh-lg (server-rendered, base
  // /genero/ sin slash final). Label canónico (src/genres.ts) o texto del
  // sitio tal cual (dooplay.ts).
  const genres = genresFromBadgeBlock(html, "genero", "dyt");

  const tmdb = await fetchTmdb(name, tmdbKey);
  const epCount = tmdb?.year ? 24 : 32;

  const videos = [];
  for (let i = 1; i <= epCount; i++) {
    videos.push({
      id: `dyt:${baseEpSlug}${i}`,
      title: `T1 · Episodio ${i}`,
      season: 1,
      episode: i,
      // doramasyt no expone stills por episodio (su listado real llega por
      // AJAX con sesión) — caemos al póster de la serie.
      thumbnail: tmdb?.poster || poster,
    });
  }

  return {
    meta: {
      id,
      type: "series",
      name,
      poster: tmdb?.poster || poster,
      background: tmdb?.background || poster,
      description: tmdb?.description || description,
      posterShape: "poster",
      releaseInfo: tmdb?.year || "",
      genres,
      videos,
    },
  };
}

// DoramasYT emite slugs "titulo(-latino)?-episodio-N"; las demás fuentes exigen
// "titulo-NxM" (guard de doramas.ts y parseSxE de slugmap.ts). Convierte el slug
// propio a la forma canónica para que getStreams pueda hacer el fan-out.
export function canonicalDytSlug(slug: string): string {
  if (/-\d+x\d+$/.test(slug)) return slug;
  const m = slug.match(/^(.*?)-episodio-(\d+)$/i);
  if (!m) return slug;
  return `${m[1]}-1x${parseInt(m[2], 10)}`;
}

export async function resolveDytEpisodeSlug(
  epSlug: string,
  env: Env
): Promise<string | null> {
  return resolveEpisodeSlug(
    {
      site: "dyt",
      searchSeries: (title) =>
        (async () => {
          const slugs = new Set<string>();
          for (const v of searchVariants(title)) {
            let html = "";
            try {
              html = await fetchHtml(`${DORAMASYT_BASE}/buscar?q=${encodeURIComponent(v)}`, env);
            } catch {
              html = "";
            }
            for (const m of html.matchAll(/\/dorama\/([a-z0-9-]+)/gi))
              slugs.add(m[1]);
          }
          return [...slugs];
        })(),
      fetchEpisodes: (seriesSlug) =>
        (async () => {
          let html = "";
          try {
            html = await fetchHtml(`${DORAMASYT_BASE}/dorama/${seriesSlug}`, env);
          } catch {
            html = "";
          }
          const ep1Match = html.match(/\/ver\/([a-z0-9-]+-episodio-)1["'\s>]/i);
          const base = ep1Match ? ep1Match[1] : `${seriesSlug.replace(/-sub-espanol$/, "")}-episodio-`;
          const episodes: { s: number; e: number; epSlug: string }[] = [];
          for (let i = 1; i <= 32; i++) {
            episodes.push({ s: 1, e: i, epSlug: `${base}${i}` });
          }
          return episodes;
        })(),
    },
    epSlug,
    env
  );
}

export async function getDoramaYtStreams(
  rawId: string,
  env: Env,
  request: Request
) {
  const epSlug = rawId.replace("dyt:", "");
  let html = "";
  try {
    html = await fetchHtml(`${DORAMASYT_BASE}/ver/${epSlug}`, env);
  } catch {
    html = "";
  }
  if (!html) {
    const resolved = await resolveDytEpisodeSlug(epSlug, env);
    if (resolved && resolved !== epSlug) {
      console.log(`[dyt] slug resuelto: ${epSlug} → ${resolved}`);
      try {
        html = await fetchHtml(`${DORAMASYT_BASE}/ver/${resolved}`, env);
      } catch {
        html = "";
      }
    }
  }
  if (!html) return { streams: [] };

  const playerTokens: { token: string; server: string }[] = [];
  for (const m of html.matchAll(/<button[^>]*data-player="([^"]+)"[^>]*>(.*?)<\/button>/gi)) {
    playerTokens.push({ token: m[1], server: m[2].trim() });
  }

  if (playerTokens.length === 0) return { streams: [] };

  const denoBase = denoBaseFromEnv(env);

  const embeds = await Promise.all(
    playerTokens.map(async (p) => {
      try {
        const r = await netFetch("direct", `${DORAMASYT_BASE}/reproductor?video=${encodeURIComponent(p.token)}`, {
          headers: {
            "User-Agent": CHROME_UA,
            Referer: `${DORAMASYT_BASE}/ver/${epSlug}`,
          },
          signal: AbortSignal.timeout(9000),
        });
        if (!r.ok) return null;
        const pageHtml = await r.text();
        const iframeSrc = pageHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1];
        if (!iframeSrc) return null;
        let url = iframeSrc.trim();
        if (url.startsWith("//")) url = `https:${url}`;
        return /^https?:\/\//i.test(url) ? url : null;
      } catch {
        return null;
      }
    })
  );

  const { add, streams } = makeStreamDeduper();

  for (const embed of embeds) {
    if (!embed) continue;
    await addEmbedStreams({
      embed,
      epSlug,
      label: "DoramasYT",
      prefix: "dyt",
      denoBase,
      add,
    });
  }

  return { streams };
}
