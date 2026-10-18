import { Env } from "../types";
import { CHROME_UA, decodeEntities, fetchHtml, fetchTmdb, netFetch, toMetaPreview } from "../utils";
import { extractHexload, extractMp4upload } from "../extractors";

export const KPLAY_BASE = "https://kdramasplay.com";

export function cleanKplayTitle(s: string): string {
  let t = decodeEntities(s).replace(/^\s*Ver\s+/i, "");
  t = t.split(/\s+[–—|]\s+/)[0];
  t = t.split(
    /\s+(?:subtitulad[oa]|doblad[oa]|online|en\s+hd|sub\s+(?:esp|sp)\w*|castellano|latino)\b/i
  )[0];
  return t
    .replace(/\s*\((?:en\s+emisi[oó]n|finalizado)\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseKplayCards(html: string) {
  const results: { id: string; name: string; poster: string }[] = [];
  const seen = new Set<string>();
  const push = (type: "series" | "movie", slug: string, rawPoster: string, rawName: string) => {
    if (!slug || seen.has(`${type}:${slug}`)) return;
    seen.add(`${type}:${slug}`);
    const poster = rawPoster.startsWith("http")
      ? rawPoster
      : rawPoster
      ? `${KPLAY_BASE}${rawPoster}`
      : "";
    results.push({
      id: `kplay:${type}:${slug}`,
      name: cleanKplayTitle(rawName) || slug,
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

export async function getKplayCatalog(
  extra: Record<string, string>,
  env?: Env
) {
  const q = (extra.search || "").trim();
  if (q) {
    return {
      metas: parseKplayCards(
        await fetchHtml(
          `${KPLAY_BASE}/?s=${encodeURIComponent(q)}`,
          env
        )
      ).map(toMetaPreview),
    };
  }
  const page = Math.floor(parseInt(extra.skip || "0", 10) / 24) + 1;
  const path = page > 1 ? `${KPLAY_BASE}/series/page/${page}/` : `${KPLAY_BASE}/series/`;
  return {
    metas: parseKplayCards(await fetchHtml(path, env)).map(toMetaPreview),
  };
}

export async function getKplayMeta(
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
      ? `${KPLAY_BASE}/peliculas/${slug}/`
      : `${KPLAY_BASE}/series/${slug}/`;

  let html = "";
  try {
    html = await fetchHtml(pageUrl, env);
  } catch {
    return { meta: null };
  }

  const name =
    cleanKplayTitle(
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
        videos: [
          {
            id: `kplay:movie:${slug}`,
            title: name,
            season: 1,
            episode: 1,
          },
        ],
      },
    };
  }

  // Series episodes
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
      videos: episodes.map((ep) => ({
        id: `kplay:ep:${ep.slug}`,
        title: `T${ep.s} · Episodio ${ep.e}`,
        season: ep.s,
        episode: ep.e,
      })),
    },
  };
}

export async function resolveKplayEmbed(
  post: string,
  nume: string,
  type: string,
  env?: Env
): Promise<string | null> {
  try {
    const r = await netFetch("direct", `${KPLAY_BASE}/wp-admin/admin-ajax.php`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${KPLAY_BASE}/`,
        "User-Agent": CHROME_UA,
      },
      body: `action=doo_player_ajax&post=${encodeURIComponent(
        post
      )}&nume=${encodeURIComponent(nume)}&type=${encodeURIComponent(type)}`,
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return null;
    const data: any = await r.json();
    const embed = typeof data?.embed_url === "string" ? data.embed_url : "";
    if (!embed) return null;
    let embedSrc =
      embed.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1] || embed.trim();
    embedSrc = embedSrc.replace(/\\\//g, "/");
    if (embedSrc.startsWith("//")) embedSrc = `https:${embedSrc}`;
    return /^https?:\/\//i.test(embedSrc) ? embedSrc : null;
  } catch (ex) {
    console.error(`Error resolving Kplay embed: ${ex}`);
    return null;
  }
}

export async function getKplayStreams(
  rawId: string,
  env: Env,
  request: Request
) {
  const parts = rawId.split(":");
  if (parts.length < 3) return { streams: [] };
  const subType = parts[1]; // "ep" or "movie"
  const slug = parts[2];

  const targetUrl =
    subType === "movie"
      ? `${KPLAY_BASE}/peliculas/${slug}/`
      : `${KPLAY_BASE}/episodios/${slug}/`;

  let html = "";
  try {
    html = await fetchHtml(targetUrl, env);
  } catch {
    return { streams: [] };
  }

  const options: { post: string; nume: string; type: string }[] = [];
  for (const li of html.matchAll(/<li[^>]*dooplay_player_option[^>]*>/gi)) {
    const tag = li[0];
    const post = tag.match(/data-post=["']([^"']+)["']/i)?.[1];
    const nume = tag.match(/data-nume=["']([^"']+)["']/i)?.[1];
    const type = tag.match(/data-type=["']([^"']+)["']/i)?.[1] || (subType === "movie" ? "movie" : "tv");
    if (post && nume) options.push({ post, nume, type });
  }
  if (options.length === 0) return { streams: [] };

  const denoBase = (env.FETCH_PROXY_URL || "")
    .trim()
    .replace(/\/fetch\/?$/, "")
    .replace(/\/$/, "");
  const streams: any[] = [];
  const seenUrl = new Set<string>();
  const add = (s: any) => {
    const k = s.url || s.externalUrl;
    if (k && !seenUrl.has(k)) {
      seenUrl.add(k);
      streams.push(s);
    }
  };

  const embeds = await Promise.all(
    options.map((o) =>
      resolveKplayEmbed(o.post, o.nume, o.type, env)
    )
  );

  for (const embed of embeds) {
    if (!embed) continue;
    const host =
      embed.match(/https?:\/\/(?:www\.)?([a-z0-9-]+)\./i)?.[1] || "host";
    const ext = () =>
      add({
        externalUrl: embed,
        name: "KDramas Play 🌐",
        title: `🌐 ${host} — KDramas Play`,
      });

    if (
      // Espejos de StreamWish admitidos — mantén sincronizado con deno/fetch.ts
      // (allowlist de /streamwish) y con las otras fuentes. Incluye do7go/playmogo
      // (espejo actual de kdramasplay).
      /streamwish|embedwish|wishfast|sfastwish|swishsrv|streamaly|streamis|flaswish|do7go|playmogo/i.test(
        embed
      )
    ) {
      if (denoBase)
        add({
          url: `${denoBase}/streamwish?url=${encodeURIComponent(embed)}`,
          name: "KDramas Play HLS",
          title: `▶ streamwish — KDramas Play`,
          behaviorHints: {
            notWebReady: false,
            filename: `${slug}.m3u8`,
            bingeGroup: "kplay-streamwish",
          },
        });
      else ext();
      continue;
    }
    if (/savefiles\.com|streamhls\.to/i.test(embed)) {
      const code = embed
        .split(/savefiles\.com\/|streamhls\.to\//)
        .pop()
        ?.replace(/^e\//, "")
        .split(/[/?]/)[0]
        ?.trim();
      if (denoBase && code && code.length > 3)
        add({
          url: `${denoBase}/savefiles?code=${encodeURIComponent(code)}`,
          name: "KDramas Play HLS",
          title: "▶ savefiles — KDramas Play",
          behaviorHints: {
            notWebReady: false,
            filename: `${slug}.m3u8`,
            bingeGroup: "kplay-savefiles",
          },
        });
      else ext();
      continue;
    }
    if (embed.includes("mp4upload.com")) {
      const u = await extractMp4upload(embed);
      if (u) {
        add({
          url: u,
          name: "KDramas Play MP4",
          title: "▶ mp4upload — KDramas Play",
          behaviorHints: {
            notWebReady: false,
            filename: `${slug}.mp4`,
            bingeGroup: "kplay-mp4upload",
          },
        });
        continue;
      }
    }
    if (embed.includes("hexload.com")) {
      const u = await extractHexload(embed);
      if (u) {
        add({
          url: u,
          name: "KDramas Play MP4",
          title: "▶ hexload — KDramas Play",
          behaviorHints: {
            notWebReady: false,
            filename: `${slug}.mp4`,
            bingeGroup: "kplay-hexload",
          },
        });
        continue;
      }
    }
    if (embed.includes("pixeldrain.com")) {
      const idM = embed.match(/pixeldrain\.com\/(?:u|l)\/([a-zA-Z0-9]+)/);
      if (idM) {
        add({
          url: `https://pixeldrain.com/api/file/${idM[1]}`,
          name: "KDramas Play MP4",
          title: "▶ pixeldrain — KDramas Play",
          behaviorHints: { notWebReady: false, filename: `${slug}.mp4` },
        });
        continue;
      }
    }
    ext();
  }
  return { streams };
}
