import { Env } from "../types";
import { genreSlug } from "../genres";
import { CHROME_UA, cleanTitle, decodeEntities, denoBaseFromEnv, fetchHtml, fetchTmdb, makeStreamDeduper, netFetch, toMetaPreview } from "../utils";
import { addEmbedStreams } from "../extractors";
import { genresFromDooPlay } from "./dooplay";
import { resolveEpisodeSlug, searchVariants } from "./slugmap";

const YANDI_BASE = "https://yandispoiler.net";

export function parseYandiCards(html: string) {
  const results: { id: string; name: string; poster: string }[] = [];
  const seen = new Set<string>();
  const push = (type: "series" | "movie", slug: string, rawPoster: string, rawName: string) => {
    if (!slug || seen.has(`${type}:${slug}`)) return;
    seen.add(`${type}:${slug}`);
    const poster = rawPoster.startsWith("http")
      ? rawPoster
      : rawPoster
      ? `${YANDI_BASE}${rawPoster}`
      : "";
    results.push({
      id: `yandi:${type}:${slug}`,
      name: cleanTitle(rawName) || slug,
      poster,
    });
  };

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
        await fetchHtml(`${YANDI_BASE}/genero/${gslug}/`, env)
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

  const name =
    cleanTitle(
      html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] ||
        html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ||
        slug
    ) || slug;
  const poster =
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1] ||
    html.match(/<div class="poster">\s*<img[^>]+(?:data-src|src)="([^"]+)"/i)?.[1] ||
    "";
  const description = decodeEntities(
    html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1] ||
      html.match(/<div[^>]+itemprop="description"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
      ""
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const genres = genresFromDooPlay(html, "genero", "yandi");
  const tmdb = await fetchTmdb(name, tmdbKey);

  if (type === "movie") {
    return {
      meta: {
        id,
        type: "movie",
        name,
        poster: tmdb?.poster || poster,
        background: tmdb?.background || poster,
        description: tmdb?.description || description,
        posterShape: "poster",
        releaseInfo: tmdb?.year || "",
        genres,
        videos: [
          {
            id: `yandi:movie:${slug}`,
            title: name,
            season: 1,
            episode: 1,
          },
        ],
      },
    };
  }

  // Episodes extraction:
  // <a ... data-ep-num="4" ... onclick="window.location.href='https://yandispoiler.net/episodios/doctor-x-mafia-in-white-1x4/'">
  // or href="/episodios/doctor-x-mafia-in-white-1x4/"
  const episodes: { slug: string; s: number; e: number }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /\/episodios\/([a-z0-9-]+-(\d+)x(\d+))\/?/gi
  )) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    episodes.push({
      slug: m[1],
      s: parseInt(m[2], 10),
      e: parseInt(m[3], 10),
    });
  }
  episodes.sort((a, b) => a.s - b.s || a.e - b.e);

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
      videos: episodes.map((ep) => ({
        id: `yandi:ep:${ep.slug}`,
        title: `T${ep.s} · Episodio ${ep.e}`,
        season: ep.s,
        episode: ep.e,
        thumbnail: poster,
      })),
    },
  };
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
        const episodes: { s: number; e: number; epSlug: string }[] = [];
        const seen = new Set<string>();
        for (const m of html.matchAll(
          /\/episodios\/([a-z0-9-]+-(\d+)x(\d+))\/?/gi
        )) {
          if (seen.has(m[1])) continue;
          seen.add(m[1]);
          episodes.push({
            epSlug: m[1],
            s: parseInt(m[2], 10),
            e: parseInt(m[3], 10),
          });
        }
        return episodes;
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
