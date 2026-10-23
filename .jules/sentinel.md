## 2025-05-18 - SSRF Prevention in HLS Proxy Handlers
**Vulnerability:** `/proxy/m3u8` and `/proxy/seg` accepted unvalidated `url` and `ref` query parameters and fetched them directly, exposing an unauthenticated open proxy / SSRF vector to local/private network addresses or cloud metadata services.
**Learning:** Proxy endpoints relaying streaming content must strictly validate target URLs rather than assuming requests only come from internal HLS rewriters.
**Prevention:** Use `safeProxyUrl` in `src/utils.ts` to validate all proxy/relay input URLs, enforcing `http:`/`https:` protocols and blocking private, loopback, or metadata hostnames.
