export interface Env {
  STREAM_CACHE: KVNamespace;
  TMDB_KEY: string;
  // Non-Cloudflare HTML fetch proxy (deno/fetch.ts on Deno Deploy).
  // Relays dorama site HTML from Deno's edge when needed.
  FETCH_PROXY_URL: string;
  // Optional Cloudflare Browser Rendering (REST API).
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
}

export interface MetaPreview {
  id: string;
  type: string;
  name: string;
  poster: string;
  posterShape: string;
}
