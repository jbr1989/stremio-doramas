import { Env } from "../lib/types";
import {
  isCfChallenge,
  json,
  MOBILE_UA,
  netFetch,
  renderPage,
} from "../lib/utils";
import { findMediaUrl } from "../lib/extractors";

// ---------------------------------------------------------------------------
// Capas de red que usan los extractores: aquí se prueban ambos caminos de
// captura de HTML con el mismo ?url= para comparar sin tocar el extractor.
// ---------------------------------------------------------------------------

/** /debug-render — prueba el browser rendering (challenges de Cloudflare). */
export async function debugRender(
  url: URL,
  env: Env
): Promise<Response> {
  const testUrl = url.searchParams.get("url");
  if (!testUrl) return json({ error: "Missing ?url=" });
  const t0 = Date.now();
  const wait =
    (url.searchParams.get("wait") as
      | "load"
      | "domcontentloaded"
      | "networkidle0"
      | "networkidle2"
      | null) || undefined;
  const selector = url.searchParams.get("selector") || undefined;
  const html = await renderPage(testUrl, env, {
    referer: url.searchParams.get("ref") || "https://doramasflix.in/",
    wait,
    waitForSelector: selector,
    timeoutMs: selector ? 28000 : undefined,
  });
  if (html == null)
    return json({
      error:
        "render returned null — CF_ACCOUNT_ID/CF_API_TOKEN unset or render failed",
      ms: Date.now() - t0,
    });
  return json({
    testUrl,
    wait: wait || "networkidle0",
    htmlLen: html.length,
    isChallenge: isCfChallenge(html),
    media: findMediaUrl(html),
    snippet: html.slice(0, 600),
    ms: Date.now() - t0,
  });
}

/** /debug-host — prueba el fetch directo con netFetch (headers móviles). */
export async function debugHost(url: URL): Promise<Response> {
  const embedUrl = url.searchParams.get("url");
  if (!embedUrl) return new Response("Missing url", { status: 400 });
  const hdrs = {
    "User-Agent": MOBILE_UA,
    Referer: "https://doramasflix.in/",
    Origin: "https://doramasflix.in",
    Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9",
  };
  try {
    const r = await netFetch("direct", embedUrl, {
      headers: hdrs,
      signal: AbortSignal.timeout(10000),
    });
    const html = await r.text();
    const urls = [
      ...html.matchAll(
        /["'`](https?:\/\/[^"'`\s]{15,}\.(?:mp4|mkv|m3u8|ts)[^"'`\s]*)/gi
      ),
    ].map((m) => m[1]);
    return json({
      status: r.status,
      contentType: r.headers.get("content-type"),
      htmlLen: html.length,
      foundUrls: urls,
      htmlSnippet: html.slice(0, 5000),
    });
  } catch (e) {
    return json({ error: String(e) });
  }
}
