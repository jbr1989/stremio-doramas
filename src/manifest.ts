export const ADDON_ID = "com.doramas.stremio";

export const MANIFEST = {
  id: ADDON_ID,
  version: "1.0.0",
  name: "Doramas",
  description: "Fuentes de Doramas en español y subtituladas",
  logo: "https://doramasflix.in/favicon.ico",
  resources: ["catalog", "meta", "stream"],
  types: ["series", "movie"],
  catalogs: [
    { type: "series", id: "doramaslat-directory", name: "Doramas Latino — Directorio", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    { type: "series", id: "doramedplay-directory", name: "Doramas Sub — Directorio", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    { type: "series", id: "kplay-directory", name: "KDramas Play — Directorio", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    { type: "series", id: "doramasflix-directory", name: "Doramasflix — Directorio", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
  ],
  idPrefixes: ["dlat:", "dsub:", "kplay:", "dflix:"],
};
