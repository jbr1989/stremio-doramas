import { Env } from "../lib/types";
import { browserRenderingReady, json } from "../lib/utils";
import { ResolveDeps } from "../resolve";
import { debugAll, debugExtract } from "./check";
import { debugExtractor } from "./extractor";
import { debugHost, debugRender } from "./network";

/** Paths de debug que resuelve handleDebug(). Cada tipo vive en su módulo:
 *  ./check (/debug-extract + /debug-all), ./extractor (/debug-extractor),
 *  ./network (/debug-render + /debug-host). */
const DEBUG_PATHS = new Set([
  "/debug",
  "/debug-extract",
  "/debug-all",
  "/debug-render",
  "/debug-host",
  "/debug-extractor",
]);

export function isDebugPath(path: string): boolean {
  return DEBUG_PATHS.has(path);
}

/** Router de todas las rutas de debug. Devuelve la Response de la ruta, o
 *  null si `path` no es una ruta de debug (el caller sigue con las demás). */
export async function handleDebug(
  request: Request,
  url: URL,
  path: string,
  env: Env,
  deps: ResolveDeps
): Promise<Response | null> {
  if (!isDebugPath(path)) return null;
  const tmdbKey = (env.TMDB_KEY || "").trim();

  if (path === "/debug") {
    // Estado de configuración: primeros valores a mirar cuando algo falla.
    return json({
      tmdbKey: tmdbKey ? "set" : "not set",
      kvBinding: env.STREAM_CACHE ? "set" : "not set",
      fetchProxy: (env.FETCH_PROXY_URL || "").trim() || "not set",
      browserRendering: browserRenderingReady(env)
        ? "enabled"
        : "disabled (manual only)",
    });
  }

  if (path === "/debug-extract") return debugExtract(url, env, deps);
  if (path === "/debug-all") return debugAll(url, env, tmdbKey, deps);
  if (path === "/debug-extractor") return debugExtractor(request, url, env);
  if (path === "/debug-render") return debugRender(url, env);
  if (path === "/debug-host") return debugHost(url);

  return null;
}
