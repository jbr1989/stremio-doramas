import { Env } from "../types";
import { genreSlug } from "../genres";
import { cleanTitle, denoBaseFromEnv, fetchHtml, fetchTmdb, makeStreamDeduper, toMetaPreview } from "../utils";
import { addEmbedStreams } from "../extractors";
import { buildMovieMeta, buildSeriesMeta, dooplayEpisodeList, genresFromDooPlay, ogMetaFromHtml } from "./dooplay";
import { resolveEpisodeSlug, searchVariants } from "./slugmap";

const YANDI_BASE = "https://yandispoiler.net";

export function parseYandiCards(html: string) {
  const results: { id: string; name: string; poster: string }[] = [];
  const seen = new Map<string, { id: string; name: string; poster: string }>();
  const push = (type: "series" | "movie", slug: string, rawPoster: string, rawName: string) => {
    if (!slug) return;
    const key = `${type}:${slug}`;
    const poster = rawPoster.startsWith("http")
      ? rawPoster
      : rawPoster
      ? `${YANDI_BASE}${rawPoster}`
      : "";
    const name = cleanTitle(rawName) || slug;
    const existing = seen.get(key);
    // Fusiona duplicados: la primera aparición gana, pero se completa
    // name/poster si faltan (p. ej. anchor vacío seguido de su <img>).
    if (existing) {
      if (!existing.poster && poster) existing.poster = poster;
      if (existing.name === slug && name !== slug) existing.name = name;
      return;
    }
    const entry = { id: `yandi:${type}:${slug}`, name, poster };
    seen.set(key, entry);
    results.push(entry);
  };

  // Cards del tema Dooplay. Dos variantes:
  //  a) <a href=".../series/<slug>/" data-ptype="tvshows" title="TITULO">
  //       <img class="thumb" alt="TITULO" src="poster.jpg">   <- img dentro del anchor
  //     </a>
  //  b) <a href=".../series/<slug>/" data-ptype="tvshows" title="TITULO"></a>
  //     ... <img data-original="poster.jpg" alt="TITULO" src="poster.jpg">  <- img fuera
  // En ambas el <img> usa "alt" ANTES de "src" y lazyload por "data-src"/"data-original".
  const anchorRe = /<a\s[^>]*href="[^"]*\/(series|peliculas)\/([a-z0-9-]+)\/"[^>]*>/gi;
  for (const m of html.matchAll(anchorRe)) {
    const openTag = m[0];
    const idx = m.index ?? 0;
    // Ventana hasta el proximo anchor o item del tema (evita colarse el poster
    // de la card siguiente); el <img> queda incluido dentro de la ventana.
    const nextA = html.indexOf("<a ", idx + openTag.length);
    const nextItem = html.indexOf('<div id="item-', idx + openTag.length);
    const end = Math.min(
      nextA === -1 ? html.length : nextA,
      nextItem === -1 ? html.length : nextItem,
      idx + 1500
    );
    const block = html.slice(idx, end);
    const ptype = (openTag.match(/data-ptype="([^"]*)"/i)?.[1] || "").toLowerCase();
    const type: "series" | "movie" = ptype.startsWith("tv")
      ? "series"
      : ptype === "movie"
      ? "movie"
      : m[1].toLowerCase() === "peliculas"
      ? "movie"
      : "series";
    const poster = (
      block.slice(openTag.length).match(/(?:data-src|data-original|src)="([^"]+)"/i)?.[1] || ""
    ).trim();
    // Variante "sideranking" (trending lateral): el anchor no trae <img> y el
    // poster vive en el <li> contenedor, ANTES del anchor (data-bg-url).
    const back = html.slice(Math.max(0, idx - 600), idx);
    const bgPoster = back.match(/data-bg-url="([^"]+)"/i)?.[1] || "";
    const name = (
      openTag.match(/title="([^"]*)"/i)?.[1] ||
      block.match(/alt="([^"]*)"/i)?.[1] ||
      ""
    ).trim();
    push(type, m[2], poster || bgPoster, name);
  }

  // Fallback: markup sin data-ptype (img con src antes de alt y link después)
  for (const m of html.matchAll(
    /<img[^>]+(?:data-src|src)="([^"]+)"[^>]*alt="([^"]*)"[\s\S]{0,250}?\/(series|peliculas)\/([a-z0-9-]+)\//gi
  )) {
    const type = m[3].toLowerCase() === "peliculas" ? "movie" : "series";
    push(type, m[4], m[1], m[2]);
  }
  for (const m of html.matchAll(
    /\/(series|peliculas)\/([a-z0-9-]+)\/"[^>]*>[\s\S]{0,100}?<img[^>]+(?:data-src|src)="([^"]+)"[^>]*alt="([^"]*)"/gi
  )) {
    const type = m[1].toLowerCase() === "peliculas" ? "movie" : "series";
    push(type, m[2], m[3], m[4]);
  }
  return results.slice(0, 100);
}

export async function getYandiCatalog(
  extra: Record<string, string>,
  env?: Env
) {
  const q = (extra.search || "").trim();
  if (q) {
    return {
      metas: parseYandiCards(
        await fetchHtml(
          `${YANDI_BASE}/?s=${encodeURIComponent(q)}`,
          env
        )
      ).map(toMetaPreview),
    };
  }

  const g = (extra.genre || "").trim();
  if (g) {
    const gslug = genreSlug("yandi", g);
    if (!gslug) return { metas: [] };
    return {
      metas: parseYandiCards(
        await fetchHtml(`${YANDI_BASE}/generos/${gslug}/`, env)
      )
        .filter((r) => r.id.startsWith("yandi:series:"))
        .map(toMetaPreview),
    };
  }

  const page = Math.floor(parseInt(extra.skip || "0", 10) / 24) + 1;
  const path = page > 1 ? `${YANDI_BASE}/series/page/${page}/` : `${YANDI_BASE}/series/`;
  return {
    metas: parseYandiCards(await fetchHtml(path, env)).map(toMetaPreview),
  };
}

export async function getYandiMeta(
  id: string,
  tmdbKey: string,
  env?: Env
) {
  const parts = id.split(":");
  if (parts.length < 3) return { meta: null };
  const type = parts[1]; // "series" or "movie"
  const slug = parts[2];
  const pageUrl =
    type === "movie"
      ? `${YANDI_BASE}/peliculas/${slug}/`
      : `${YANDI_BASE}/series/${slug}/`;

  let html = "";
  try {
    html = await fetchHtml(pageUrl, env);
  } catch {
    return { meta: null };
  }

  const og = ogMetaFromHtml(html, slug);

  const genres = genresFromDooPlay(html, "genero", "yandi");
  const tmdb = await fetchTmdb(og.name, tmdbKey);

  if (type === "movie") {
    return buildMovieMeta({
      id,
      slug,
      name: og.name,
      poster: og.poster,
      description: og.description,
      genres,
      tmdb,
    });
  }

  // Episodes extraction:
  // <a ... data-ep-num="4" ... onclick="window.location.href='https://yandispoiler.net/episodios/doctor-x-mafia-in-white-1x4/'">
  // or href="/episodios/doctor-x-mafia-in-white-1x4/"
  const episodes = dooplayEpisodeList(html, "episodios");

  return buildSeriesMeta({
    id,
    name: og.name,
    poster: og.poster,
    description: og.description,
    genres,
    tmdb,
    // yandi no tiene grilla de miniaturas por episodio → poster siempre.
    videos: episodes.map((ep) => ({
      id: `yandi:ep:${ep.slug}`,
      season: ep.s,
      episode: ep.e,
      thumbnail: og.poster,
    })),
  });
}

async function resolveYandiEpisodeSlug(
  epSlug: string,
  env: Env
): Promise<string | null> {
  return resolveEpisodeSlug(
    {
      site: "yandi",
      searchSeries: async (title) => {
        const variants = searchVariants(title);
        const html = await fetchHtml(
          `${YANDI_BASE}/?s=${encodeURIComponent(variants[0])}`,
          env
        );
        const slugs = [
          ...new Set(
            [...html.matchAll(/\/series\/([a-z0-9-]+)\//gi)].map((m) => m[1])
          ),
        ];
        return slugs;
      },
      fetchEpisodes: async (seriesSlug) => {
        const html = await fetchHtml(
          `${YANDI_BASE}/series/${seriesSlug}/`,
          env
        );
        return dooplayEpisodeList(html, "episodios").map((ep) => ({
          epSlug: ep.slug,
          s: ep.s,
          e: ep.e,
        }));
      },
    },
    epSlug,
    env
  );
}

export async function getYandiStreams(
  rawId: string,
  env: Env
) {
  const parts = rawId.split(":");
  if (parts.length < 3) return { streams: [] };
  const subType = parts[1]; // "ep" or "movie"
  const slug = parts.slice(2).join(":");

  const targetUrl =
    subType === "movie"
      ? `${YANDI_BASE}/peliculas/${slug}/`
      : `${YANDI_BASE}/episodios/${slug}/`;

  let html = "";
  try {
    html = await fetchHtml(targetUrl, env);
  } catch {
    html = "";
  }

  if (!html && subType === "ep") {
    const resolved = await resolveYandiEpisodeSlug(slug, env);
    if (resolved && resolved !== slug) {
      console.log(`[yandi] slug resuelto: ${slug} → ${resolved}`);
      try {
        html = await fetchHtml(`${YANDI_BASE}/episodios/${resolved}/`, env);
      } catch {
        html = "";
      }
    }
  }
  if (!html) return { streams: [] };

  // Embed extraction:
  // Elements with data-url="https://..."
  const embeds: string[] = [];
  for (const m of html.matchAll(/data-url=["'](https?:\/\/[^"']+)["']/gi)) {
    const u = m[1].trim();
    if (u && !embeds.includes(u)) embeds.push(u);
  }

  const denoBase = denoBaseFromEnv(env);
  const { add, streams } = makeStreamDeduper();

  for (const embed of embeds) {
    await addEmbedStreams({
      embed,
      epSlug: slug,
      label: "Yandispoiler",
      prefix: "yandi",
      denoBase,
      add,
      env,
    });
  }

  return { streams };
}
