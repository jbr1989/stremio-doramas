// Transporte GraphQL genérico, en dos piezas:
//   gqlOnce — UNA petición GraphQL contra UN origen (POST, headers con los
//             datos del origin, check HTTP + errors[] del backend, data out).
//   gqlFetch — la política de failover: corre gqlOnce contra cada origen en
//             orden hasta que uno responde; si todos fallan, throw con el
//             detalle por origen. TODO el failover corre bajo un presupuesto
//             global (budgetMs, default 20s): los orígenes sin presupuesto
//             restante se saltan sin gastar subrequest y se documentan en el
//             error final, así el worst case es budgetMs y no N × timeoutMs.
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
 *  termina con un error que acumula la causa de cada origen.
 *
 *  Presupuesto global (budgetMs): el failover entero corre bajo un deadline
 *  compartido — cada intento recibe min(timeoutMs, remaining) y los orígenes
 *  sin presupuesto restante se registran como "sin presupuesto" sin tirar
 *  subrequests inútiles. Antes, 4 espejos × 12s podían encadenar ~48s
 *  secuencial y matar el request por wall-clock del Worker (~30s); el worst
 *  case ahora queda en budgetMs garantizado. */
const MIN_ATTEMPT_MS = 1000;

export async function gqlFetch(
  endpoint: string,
  query: string,
  variables: Record<string, any> = {},
  origins: string[],
  timeoutMs = 12000,
  /** Techo total del failover completo. Default: max(timeoutMs, 20s) — 20s
   *  cabe una ventana completa + cola con presupuesto, y queda bajo el muro
   *  del Worker y el techo global de fetchHtml (25s). */
  budgetMs = Math.max(timeoutMs, 20000)
): Promise<any> {
  const deadline = Date.now() + budgetMs;
  const errors: string[] = [];
  for (const base of origins) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) {
      // Ya no cabe ni una ventana mínima: no gastar subrequest en un intento
      // que moriría solo; se documenta para el error final.
      errors.push(`${base}: sin presupuesto (${Math.max(remaining, 0)}ms de ${budgetMs}ms)`);
      continue;
    }
    try {
      return await gqlOnce(
        endpoint,
        base,
        query,
        variables,
        Math.min(timeoutMs, remaining)
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${base}: ${msg}`);
      // Log visible por origen fallido: sin esto, un espejo caído o un
      // GraphQL errors[] solo afloran al agotarse todos.
      console.log(`[gql] failover ${base} falló: ${msg}`);
      // Red fallida con este origen -> probar el siguiente (failover secuencial).
    }
  }
  throw new Error(
    `GraphQL fallo en todos los orígenes — ${errors.join(" | ")}`
  );
}
