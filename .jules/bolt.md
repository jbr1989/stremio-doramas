# Bolt's Journal - Critical Learnings

## 2025-05-18 - Fast-path & Hoisted RegExp for String Operations
**Learning:** In Cloudflare Workers processing high volumes of catalog metadata and titles, `decodeEntities` and `cleanTitle` were previously executing multiple regex replacements and `.split()` calls on every string even when no entities or delimiters were present.
**Action:** Always check `!s.includes('&')` before entity decoding and test regex patterns before `.split()` to avoid array allocations on standard strings.
