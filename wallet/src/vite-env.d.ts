/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ARCHIVE_URL?: string;
  readonly VITE_SOMBRA_CLIENT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
