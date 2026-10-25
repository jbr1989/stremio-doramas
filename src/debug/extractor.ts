import { Env } from "../lib/types";
import {
  browserRenderingReady,
  denoBaseFromEnv,
  DOOD_HOSTS_RE,
  json,
  STREAMWISH_HOSTS_RE,
} from "../lib/utils";
import {
  extractSavefiles,
  extractMixdrop,
  extractStreamwish,
} from "../lib/extractors";

// ---------------------------------------------------------------------------
// /debug-extractor — prueba un extractor individual autodetectado por la
// URL del embed. Sustituye a las antiguas /debug-savefiles, /debug-streamwish,
// /debug-mixdrop y /debug-dood: una sola ruta cuya tabla de familias se puede
// extender añadiendo entradas (match + run), no rutas nuevas. Cada extractor
// devuelve el JSON común (extractor/testUrl/streamUrl/ms) más sus extras
// (proxyUrl, ipBound, etc.).
// ---------------------------------------------------------------------------

type DebugExtractor = {
  name: string;
  /** ¿Corresponde este embed a esta familia? */
  match: (embedUrl: string) => boolean;
  /** Ejecuta el extractor; extras específicos se devuelven aquí y se
   *  integran en la respuesta. streamUrl es el campo canónico. */
  run: (
    embedUrl: string,
    request: Request,
    env: Env
  ) => Promise<{ streamUrl?: string | null; [extra: string]: any }>;
};

const DEBUG_EXTRACTORS: DebugExtractor[] = [
  {
    name: "savefiles",
    // savefiles.com y su espejo streamhls.to: HLS firmado por POST a /dl.
    match: (u) => /savefiles\.com|streamhls\.to/i.test(u),
    run: async (testUrl, request) => {
      const streamUrl = await extractSavefiles(testUrl);
      const workerBase = new URL(request.url).origin;
      return {
        streamUrl,
        proxyUrl: streamUrl
          ? `${workerBase}/proxy/m3u8?url=${encodeURIComponent(
              streamUrl
            )}&ref=${encodeURIComponent("https://streamhls.to/")}`
          : null,
      };
    },
  },
  {
    name: "streamwish",
    // Mirrors de StreamWish (ver STREAMWISH_HOSTS_RE): HLS por el relay Deno.
    match: (u) => STREAMWISH_HOSTS_RE.test(u),
    run: async (testUrl, _request, env) => {
      const streamUrl = await extractStreamwish(testUrl);
      const denoBase = denoBaseFromEnv(env);
      return {
        streamUrl,
        denoUrl: denoBase
          ? `${denoBase}/streamwish?url=${encodeURIComponent(testUrl)}`
          : null,
        ipBound: true,
      };
    },
  },
  {
    name: "mixdrop",
    match: (u) => /mixdrop/i.test(u),
    run: async (testUrl) => ({ streamUrl: await extractMixdrop(testUrl) }),
  },
  {
    name: "dood",
    // Familia Dood (do7go/playmogo/dood.*): MP4 progresivo vía pass_md5.
    match: (u) => DOOD_HOSTS_RE.test(u),
    run: async (testUrl, _request, env) => {
      const { extractDood } = await import("../lib/extractors");
      const mp4 = await extractDood(testUrl, env);
      const denoBase = denoBaseFromEnv(env);
      const origin = (() => {
        try {
          return new URL(testUrl).origin;
        } catch {
          return "https://playmogo.com/";
        }
      })();
      return {
        streamUrl: mp4,
        proxyUrl: mp4 && denoBase
          ? `${denoBase}/mp4?url=${encodeURIComponent(mp4)}&r=${encodeURIComponent(origin)}`
          : null,
        browserRendering: browserRenderingReady(env) ? "enabled" : "disabled",
      };
    },
  },
];

/** Elige el extractor para un embed por familia de hostname. */
function debugExtractorFor(testUrl: string): DebugExtractor | null {
  let host: string;
  try {
    host = new URL(testUrl).hostname;
  } catch {
    return null; // URL inválida: ni intentamos dispatch
  }
  return DEBUG_EXTRACTORS.find((e) => e.match(host)) || null;
}

export async function debugExtractor(
  request: Request,
  url: URL,
  env: Env
): Promise<Response> {
  const testUrl = url.searchParams.get("url");
  if (!testUrl) return json({ error: "Missing ?url=" });

  const ext = debugExtractorFor(testUrl);
  if (!ext) {
    let host = "?";
    try {
      host = new URL(testUrl).hostname;
    } catch {}
    return json({
      error:
        `No extractor matches hostname "${host}" ` +
        "(supported families: savefiles, streamwish, mixdrop, dood)",
      testUrl,
      host,
    });
  }
  const t0 = Date.now();
  try {
    const res = await ext.run(testUrl, request, env);
    return json({
      extractor: ext.name,
      testUrl,
      streamUrl: res.streamUrl ?? null,
      ms: Date.now() - t0,
      ...res,
    });
  } catch (e) {
    return json({
      extractor: ext.name,
      testUrl,
      error: String(e).slice(0, 300),
      ms: Date.now() - t0,
    });
  }
}
