import {
  genreSourceOptions,
  masterGenreLabels,
} from "./genres";

export const ADDON_ID = "com.doramas.stremio";

// Extras estándar por catálogo + dropdown de género solo en las fuentes cuyo
// sitio expone archivos de género de SERIES reales y verificados (mapas y
// pruebas in-vivo en src/genres.ts). DoramasLat/DoramedPlay/KDramas Play
// quedan sin género: sus archivos de género listan solo películas.
type CatalogExtra = {
  name: string;
  isRequired: boolean;
  options?: string[];
  optionsLimit?: number;
};

// Extras estándar por catálogo: búsqueda y paginación. En el usuario final
// solo pasan lo que la fuente soporta; el dropdown de género se agrega con
// withGenre() únicamente donde el sitio lo soporta de verdad (mapas y pruebas
// in-vivo en src/genres.ts). DoramasLat/DoramedPlay/KDramas Play quedan sin
// género: sus archivos de género listan solo películas.
const SEARCH_SKIP: CatalogExtra[] = [
  { name: "search", isRequired: false },
  { name: "skip", isRequired: false },
];
const withGenre = (opts: string[]): CatalogExtra[] => [
  ...SEARCH_SKIP,
  { name: "genre", isRequired: false, options: opts, optionsLimit: 1 },
];

export const MANIFEST = {
  id: ADDON_ID,
  version: "1.2.0",
  name: "Doramas",
  description: "Fuentes de Doramas en español y subtituladas",
  logo: "https://doramasflix.in/favicon.ico",
  resources: ["catalog", "meta", "stream"],
  types: ["series", "movie"],
  catalogs: [
    {
      type: "series",
      id: "alldoramas-directory",
      name: "Todos los Doramas",
      extra: withGenre(masterGenreLabels()),
    },
    {
      type: "series",
      id: "doramaslat-directory",
      name: "Doramas Latino — Directorio",
      extra: SEARCH_SKIP,
    },
    {
      type: "series",
      id: "doramedplay-directory",
      name: "Doramas Sub — Directorio",
      extra: SEARCH_SKIP,
    },
    {
      type: "series",
      id: "kplay-directory",
      name: "KDramas Play — Directorio",
      extra: SEARCH_SKIP,
    },
    {
      type: "series",
      id: "doramasflix-directory",
      name: "Doramasflix — Directorio",
      extra: SEARCH_SKIP,
    },
    {
      type: "series",
      id: "tudorama-directory",
      name: "TuDorama — Directorio",
      extra: withGenre(genreSourceOptions("tudorama")),
    },
    {
      type: "series",
      id: "pandrama-directory",
      name: "Pandrama — Today Popular",
      extra: SEARCH_SKIP,
    },
    {
      type: "series",
      id: "doramasyt-directory",
      name: "DoramasYT — Directorio",
      extra: withGenre(genreSourceOptions("dyt")),
    },
  ],
  idPrefixes: ["dorama:", "dsub:", "kplay:", "dflix:", "tudorama:", "pandrama:", "dyt:"],
};
