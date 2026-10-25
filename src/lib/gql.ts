// Transporte GraphQL genérico, en dos piezas:
//   gqlOnce — UNA petición GraphQL contra UN origen (POST, headers con los
//             datos del origin, check HTTP + errors[] del backend, data out).
//   gqlFetch — la política de failover: corre gqlOnce contra cada origen en
//             orden hasta que uno responde; si todos fallan, throw con el
//             detalle por origen.
// Endpoint y lista de espejos los define el llamador (es conocimiento del
// sitio). Único cliente hoy: doramasflix (user-api.seriesapi.co).
import { CHROME_UA, netFetch } from "./utils";

/** Una petición GraphQL contra UN origen. Falla (throw) si el origen no
 *  responde, responde HTTP != 2xx, o el backend devuelve errors[]. */
async function gqlOnce(
  endpoint: string,
  origin: string,
  query: string,
  variables: Record<string, any>,
  timeoutMs: number
): Promise<any> {
  const res = await netFetch("direct", endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Referer: `${origin}/`,
      "User-Agent": CHROME_UA,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const json: any = await res.json();
  if (json.errors && json.errors.length > 0) {
    throw new Error(`GraphQL: ${json.errors[0].message}`);
  }

  return json.data;
}

/** gqlOnce + failover de orígenes: reintenta con el siguiente origen si el
 *  actual falla (red/timeout/HTTP/error de backend), secuencialmente, y
 *  termina con un error que acumula la causa de cada origen. */
export async function gqlFetch(
  endpoint: string,
  query: string,
  variables: Record<string, any> = {},
  origins: string[],
  timeoutMs = 12000
): Promise<any> {
  const errors: string[] = [];
  for (const base of origins) {
    try {
      return await gqlOnce(endpoint, base, query, variables, timeoutMs);
    } catch (e) {
      errors.push(`${base}: ${e instanceof Error ? e.message : String(e)}`);
      // Red fallida con este origen -> probar el siguiente (failover secuencial).
    }
  }
  throw new Error(
    `GraphQL fallo en todos los orígenes — ${errors.join(" | ")}`
  );
}
