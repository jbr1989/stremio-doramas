import { Env, MetaPreview } from "../types";
import {
  cleanTitle,
  decodeEntities,
  fetchHtml,
  toMetaPreview,
} from "../utils";
import { genreSlug } from "../genres";
import { resolveEpisodeSlug, searchVariants } from "./slugmap";
import { SourceBase, SourceEpisode } from "./sourceBase";

const DORAMASUB_BASE = "https://www.doramasub.com";

export function canonicalDoramaSubSlug(slug: string): string {
  if (/-\d+x\d+$/.test(slug)) return slug;
  // e.g. 2026/10/el-escandalo-capitulo-08 -> el-escandalo-1x8
  const pathPart = slug.split("/").pop() || slug;
  const m = pathPart.match(/^(.*?)-capitulo-(\d+)$/i);
  if (!m) return slug;
  return `${m[1]}-1x${parseInt(m[2], 10)}`;
}

function parseFeedEntryCard(entry: any): { slug: string; name: string; poster: string } | null {
  const titleRaw = entry?.title?.$t || "";
  const links = entry?.link || [];
  const altLink =
    links.find((l: any) => l?.rel === "alternate")?.href || "";
  if (!altLink || !altLink.includes("doramasub.com")) return null;

  const categories: string[] = (entry?.category || []).map(
    (c: any) => c?.term || ""
  );
  if (
    categories.includes("capitulos") ||
    /cap[ií]tulo/i.test(titleRaw) ||
    /cap[ií]tulo/i.test(altLink)
  ) {
    return null;
  }

  const slug = altLink
    .replace(/^https?:\/\/(www\.)?doramasub\.com\//i, "")
    .replace(/\.html$/i, "");
  if (!slug) return null;

  let poster = entry?.media$thumbnail?.url || "";
  if (!poster || /nth\.png/i.test(poster)) {
    const content = entry?.content?.$t || "";
    const m = content.match(/src=["']([^"']+)["']/i);
    if (m) poster = m[1];
  }
  if (poster.startsWith("//")) poster = `https:${poster}`;

  const cleanName = cleanTitle(titleRaw.replace(/\s*\(\d{4}\).*$/, "")) || titleRaw;

  return { slug, name: cleanName, poster };
}

/** Blogger/Blogspot (feeds JSON): el catálogo va por feeds con start-index,
 * no scraping de grilla — getCatalog es override completo del template.
 * Streams y meta SÍ van por la base (parseMetaBasics + listEpisodes). */
class DoramaSubSource extends SourceBase {
  get prefix() {
    return "dsub";
  }
  get label() {
    return "DoramaSub";
  }

  // No aplica: la URL del capítulo se arma en fetchEpisodePage (depende de
  // si el slug trae la ruta completa de capítulo).
  protected buildPageUrl(_slug: string): string {
    return "";
  }

  // ── Catálogo (override: ramas search/genre/page sobre feeds Blogger) ──
  async getCatalog(
    extra: Record<string, string>,
    env?: Env
  ): Promise<{ metas: MetaPreview[] }> {
    const q = (extra.search || "").trim();
    const g = (extra.genre || "").trim();

    let feedUrl = "";
    if (q) {
      feedUrl = `${DORAMASUB_BASE}/feeds/posts/default?alt=json&q=${encodeURIComponent(
        q
      )}&max-results=50`;
    } else if (g) {
      // Género: categoría del feed. Fallback al término en crudo (dsub
      // acepta labels que registry no declaró — ver genreSlug).
      const gslug = genreSlug("dsub", g) || g.toLowerCase();
      const startIndex = (this.pageFromSkip(extra.skip) - 1) * 24 + 1;
      feedUrl = `${DORAMASUB_BASE}/feeds/posts/default/-/${encodeURIComponent(
        gslug
      )}?alt=json&start-index=${startIndex}&max-results=24`;
    } else {
      const startIndex = (this.pageFromSkip(extra.skip) - 1) * 24 + 1;
      feedUrl = `${DORAMASUB_BASE}/feeds/posts/default/-/series?alt=json&start-index=${startIndex}&max-results=24`;
    }

    let text = "";
    try {
      text = await fetchHtml(feedUrl, env);
    } catch {
      return { metas: [] };
    }
    if (!text) return { metas: [] };

    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      return { metas: [] };
    }

    const results: { slug: string; name: string; poster: string }[] = [];
    const seen = new Set<string>();
    for (const entry of data?.feed?.entry || []) {
      const card = parseFeedEntryCard(entry);
      if (card && !seen.has(card.slug)) {
        seen.add(card.slug);
        results.push(card);
      }
    }

    if (q && results.length === 0) {
      // Fallback si la búsqueda en Blogger feed requiere palabras exactas
      const altFeedUrl = `${DORAMASUB_BASE}/feeds/posts/default/-/series?alt=json&start-index=1&max-results=50`;
      try {
        const altJson = await fetchHtml(altFeedUrl, env);
        const altData = JSON.parse(altJson);
        for (const entry of altData?.feed?.entry || []) {
          const card = parseFeedEntryCard(entry);
          if (
            card &&
            !seen.has(card.slug) &&
            card.name.toLowerCase().includes(q.toLowerCase())
          ) {
            seen.add(card.slug);
            results.push(card);
          }
        }
      } catch {}
    }

    return {
      metas: results.map((c) =>
        toMetaPreview({ id: `dsub:${c.slug}`, name: c.name, poster: c.poster })
      ),
    };
  }

  // ── Meta ──
  // DoramaSub no es DooPlay: título OG/`<title>` con cola "(año)" apartada,
  // poster OG, sinopsis OG o primer <p>.
  protected override parseMetaBasics(html: string, slug: string) {
    const rawTitle =
      html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] ||
      html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ||
      slug;
    const name = cleanTitle(rawTitle.replace(/\s*\(\d{4}\).*$/, "")) || rawTitle;

    const poster =
      html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1] ||
      "";

    const description = decodeEntities(
      html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1] ||
        html.match(/<p>([\s\S]*?)<\/p>/i)?.[1] ||
        ""
    )
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return { name: (this.siteName = name), poster: (this.sitePoster = poster), description };
  }

  private sitePoster = "";
  private siteName = "";

  protected buildSeriesPageUrl(slug: string): string {
    return `${DORAMASUB_BASE}/${slug}.html`;
  }

  // Episodios vía Blogger Feed filtrando por nombre de la serie; fallback:
  // escanear hrefs de capitulo-*.html en la propia página de serie. Temporada
  // siempre 1.
  protected override async listEpisodes(
    html: string,
    _slug: string,
    tmdb: { poster?: string } | null,
    env?: Env
  ): Promise<SourceEpisode[]> {
    const epMap = new Map<number, { slug: string; thumb: string }>();

    try {
      const feedUrl = `${DORAMASUB_BASE}/feeds/posts/default?alt=json&q=${encodeURIComponent(
        this.siteName
      )}&max-results=150`;
      const feedRes = await fetchHtml(feedUrl, env!);
      const feedData = JSON.parse(feedRes);
      for (const entry of feedData?.feed?.entry || []) {
        const links = entry?.link || [];
        const altLink =
          links.find((l: any) => l?.rel === "alternate")?.href || "";
        if (!altLink || !altLink.includes("capitulo")) continue;

        const epSlug = altLink
          .replace(/^https?:\/\/(www\.)?doramasub\.com\//i, "")
          .replace(/\.html$/i, "");
        const epTitle = entry?.title?.$t || "";
        const epNumM =
          epTitle.match(/cap[ií]tulo\s*(\d+)/i) ||
          epSlug.match(/capitulo-(\d+)/i);
        if (!epNumM) continue;

        const epNum = parseInt(epNumM[1], 10);
        let thumb = entry?.media$thumbnail?.url || "";
        if (!thumb || /nth\.png/i.test(thumb)) {
          const content = entry?.content?.$t || "";
          const m = content.match(/src=["']([^"']+)["']/i);
          if (m) thumb = m[1];
        }
        if (thumb.startsWith("//")) thumb = `https:${thumb}`;

        if (!epMap.has(epNum)) {
          epMap.set(epNum, {
            slug: epSlug,
            thumb: thumb || this.sitePoster,
          });
        }
      }
    } catch {}

    // Fallback: escanear enlaces en el HTML de la página de serie
    for (const m of html.matchAll(
      /href=["'](https?:\/\/(?:www\.)?doramasub\.com\/([^"']*?capitulo[^"']*?)\.html)["']/gi
    )) {
      const epSlug = m[2];
      const epNumM = epSlug.match(/capitulo-(\d+)/i);
      if (epNumM) {
        const epNum = parseInt(epNumM[1], 10);
        if (!epMap.has(epNum)) {
          epMap.set(epNum, { slug: epSlug, thumb: this.sitePoster });
        }
      }
    }

    return [...epMap.keys()].sort((a, b) => a - b).map((epNum) => {
      const ep = epMap.get(epNum)!;
      return {
        id: ep.slug,
        slug: ep.slug,
        s: 1,
        e: epNum,
        thumb: ep.thumb || tmdb?.poster || this.sitePoster,
      };
    });
  }

  // ── Streams ──
  // La página solo existe si el slug trae su ruta completa de capítulo
  // ("2026/10/serie-capitulo-N"); solo entonces hay fetch. Rescate propio
  // (mutado porque el epSlug resuelto alimenta emitSlug abajo).
  private lastResolvedSlug = "";

  protected override async fetchEpisodePage(
    slug: string,
    env: Env
  ): Promise<string> {
    this.lastResolvedSlug = "";
    const pageUrl =
      slug.includes("/") && /capitulo/i.test(slug)
        ? `${DORAMASUB_BASE}/${slug}.html`
        : "";
    let html = pageUrl ? await this.fetchBody(pageUrl, env) : "";

    if (!html) {
      const resolved = await resolveDoramaSubEpisodeSlug(slug, env);
      if (resolved && resolved !== slug) {
        console.log(`[dsub] slug resuelto: ${slug} → ${resolved}`);
        this.lastResolvedSlug = resolved;
        html = await this.fetchBody(
          `${DORAMASUB_BASE}/${resolved}.html`,
          env
        );
      }
    }
    return html;
  }

  // filename de behaviorHints: sí el rescate mutó el slug, canonica el nuevo.
  protected override emitSlug(slug: string): string {
    return canonicalDoramaSubSlug(this.lastResolvedSlug || slug);
  }

  // Embeds: arrays JSON "_du*", "_duSub,", "_duDub = [...]" del script del
  // tema + iframes <iframe src> (excluye about:blank/facebook/google).
  protected async extractEmbeds(
    html: string,
    _slug: string,
    _env?: Env
  ): Promise<string[]> {
    const embedUrls = new Set<string>();
    for (const m of html.matchAll(/_du(?:Sub|Dub)?\s*=\s*(\[[^\]]+\])/g)) {
      try {
        const arr = JSON.parse(m[1]);
        if (Array.isArray(arr)) {
          for (const u of arr) {
            if (typeof u === "string" && /^https?:\/\//i.test(u)) {
              embedUrls.add(u.trim());
            }
          }
        }
      } catch {}
    }
    for (const m of html.matchAll(
      /<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/gi
    )) {
      if (!/about:blank|facebook|google/i.test(m[1])) {
        embedUrls.add(m[1].trim());
      }
    }
    return [...embedUrls];
  }
}

async function resolveDoramaSubEpisodeSlug(
  epSlug: string,
  env: Env
): Promise<string | null> {
  return resolveEpisodeSlug(
    {
      site: "dsub",
      searchSeries: (title) =>
        (async () => {
          const slugs = new Set<string>();
          for (const v of searchVariants(title)) {
            try {
              const feedUrl = `${DORAMASUB_BASE}/feeds/posts/default?alt=json&q=${encodeURIComponent(
                v
              )}&max-results=20`;
              const feedRes = await fetchHtml(feedUrl, env);
              const data = JSON.parse(feedRes);
              for (const entry of data?.feed?.entry || []) {
                const card = parseFeedEntryCard(entry);
                if (card) slugs.add(card.slug);
              }
            } catch {}
          }
          return [...slugs];
        })(),
      fetchEpisodes: (seriesSlug) =>
        (async () => {
          const metaRes = await doramaSubSource.getMeta(
            `dsub:${seriesSlug}`,
            "",
            env
          );
          const episodes: { s: number; e: number; epSlug: string }[] = [];
          const meta = metaRes?.meta as any;
          for (const v of meta?.videos || []) {
            episodes.push({
              s: v.season,
              e: v.episode,
              epSlug: v.id.replace(/^dsub:/, ""),
            });
          }
          return episodes;
        })(),
    },
    epSlug,
    env
  );
}

export const doramaSubSource = new DoramaSubSource();
