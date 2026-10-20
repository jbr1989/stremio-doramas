import { Env } from "../types";
import { CHROME_UA, decodeEntities, fetchHtml, fetchTmdb, netFetch, toMetaPreview } from "../utils";
import { extractHexload, extractMp4upload } from "../extractors";
import { resolveEpisodeSlug, searchVariants, type SiteAdapter } from "./slugmap";

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

  // Miniaturas de episodio:  misma grilla DooPlay que doramas.ts
  // (<div class='imagen'><img src="thumb"></div> ... <a href=".../episodios/epSlug-SxE/">),
  // la <img> del propio <li> precede al href.
  const thumbs = new Map<string, string>();
  const pushThumb = (epSlug: string, raw: string) => {
    if (thumbs.has(epSlug)) return;
    if (/dooplay\/assets\/img\/no\/dt_/.test(raw)) return;
    const thumb = raw.startsWith("http")
      ? raw
      : raw.startsWith("//")
      ? `https:${raw}`
      : raw.startsWith("/")
      ? `${KPLAY_BASE}${raw}`
      : "";
    if (thumb) thumbs.set(epSlug, thumb);
  };
  // preferencia data-src + nunca "data:" (igual que doramas.ts)
  const imgFromTag = (attrs: string): string =>
    [attrs.match(/data-src=["']([^"']+)["']/i)?.[1] || "",
     attrs.match(/(?:^|\s)src=["']([^"']+)["']/i)?.[1] || ""]
      .find((u) => u && !u.startsWith("data:")) || "";
  for (const m of html.matchAll(
    /<img\b([^>]*)>[\s\S]{0,220}?\/episodios\/([a-z0-9-]+-(\d+)x(\d+))\/["']/gi
  )) {
    const raw = imgFromTag(m[1]);
    if (raw) pushThumb(m[2], raw);
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
      videos: episodes.map((ep) => ({
        id: `kplay:ep:${ep.slug}`,
        title: `T${ep.s} · Episodio ${ep.e}`,
        season: ep.s,
        episode: ep.e,
        thumbnail: thumbs.get(ep.slug) || poster,
      })),
    },
  };
}

/** Resuelve el epSlug propio de kdramasplay para un epSlug venido de otro
 * sitio (mapping por título, see slugmap.ts). Devuelve null si no hay match.
 *
 * Búsqueda: el `?s=` de kdramasplay NO emite resultados server-side (grid lo
 * llena el livesearch) — el buscador real es la REST de DooPlay
 * `/wp-json/dooplay/search/?keyword=&nonce=`, que devuelve HTTP 200 con JSON
 * `{id: {title, url, img}}` (o `{error:"no_posts"|"no_verify_nonce"}`). El
 * nonce (`"nonce":"…"` en el config `dtGonza`) sale de la misma página `?s=`
 * que ya descargamos, así que cada resolución hace 1 fetch de página + 1-2
 * REST. El REST matchea por frase: si la frase completa no da nada se prueba
 * con la palabra más larga del título. */
export async function resolveKplayEpisodeSlug(
  epSlug: string,
  env: Env
): Promise<string | null> {
  const restSearch = async (
    kw: string,
    nonce: string
  ): Promise<string[]> => {
    if (!kw.trim() || !nonce) return [];
    try {
      const r = await netFetch(
        "kplaysearch",
        `${KPLAY_BASE}/wp-json/dooplay/search/?keyword=${encodeURIComponent(
          kw
        )}&nonce=${encodeURIComponent(nonce)}`,
        {
          headers: {
            "User-Agent": CHROME_UA,
            "X-Requested-With": "XMLHttpRequest",
            Referer: `${KPLAY_BASE}/`,
          },
          signal: AbortSignal.timeout(8000),
        }
      );
      if (!r.ok) return [];
      const data: unknown = await r.json().catch(() => null);
      if (!data || typeof data !== "object" || "error" in (data as object))
        return [];
      const slugs: string[] = [];
      for (const v of Object.values(data as Record<string, { url?: string }>)) {
        const m = (v?.url || "").match(/\/series\/([a-z0-9-]+)\//i);
        if (m) slugs.push(m[1]);
      }
      return [...new Set(slugs)];
    } catch {
      return [];
    }
  };

  return resolveEpisodeSlug(
    {
      site: "kplay",
      searchSeries: (title) =>
        (async () => {
          const variants = searchVariants(title);
          const html = await fetchHtml(
            `${KPLAY_BASE}/?s=${encodeURIComponent(variants[0])}`,
            env
          );
          // Server-side del grid (suele venir vacío) + nonce fresco del tema.
          const slugs = [
            ...new Set(
              [...html.matchAll(/\/series\/([a-z0-9-]+)\//gi)].map((m) => m[1])
            ),
          ];
          const nonce =
            html.match(/"nonce":"([a-f0-9]{10})"/)?.[1] || "";
          for (const v of variants) {
            slugs.push(...(await restSearch(v, nonce)));
          }
          return [...new Set(slugs)];
        })(),
      fetchEpisodes: (seriesSlug) =>
        (async () => {
          const html = await fetchHtml(
            `${KPLAY_BASE}/series/${seriesSlug}/`,
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
        })(),
    },
    epSlug,
    env
  );
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
  const slug = parts.slice(2).join(":"); // consistente con getStreams (index.ts)

  const targetUrl =
    subType === "movie"
      ? `${KPLAY_BASE}/peliculas/${slug}/`
      : `${KPLAY_BASE}/episodios/${slug}/`;

  let html = "";
  try {
    html = await fetchHtml(targetUrl, env);
  } catch {
    html = "";
  }
  if (!html && subType === "ep") {
    // 404/slug inexistente: kdramasplay nombra sus episodios con su propio
    // slug — resuélvelo vía título de la serie (slugmap) y reintenta.
    const resolved = await resolveKplayEpisodeSlug(slug, env);
    if (resolved && resolved !== slug) {
      console.log(`[kplay] slug resuelto: ${slug} → ${resolved}`);
      try {
        html = await fetchHtml(`${KPLAY_BASE}/episodios/${resolved}/`, env);
      } catch {
        html = "";
      }
    }
  }
  if (!html) return { streams: [] };

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
