/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ARCHIVE_URL?: string;
  /** "mock" (default) or "live". `VITE_SOMBRA_CLIENT` is the older spelling. */
  readonly VITE_CLIENT_MODE?: string;
  readonly VITE_SOMBRA_CLIENT?: string;
  /** The confidential token the live client reads and recovers against. */
  readonly VITE_CT_CONTRACT_ID?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_HORIZON_URL?: string;
  /**
   * Pins the archive/RPC seam. Compresses the demo timescale, so anything
   * rendering what the Archive served must say so (see `Seam.compressed`).
   */
  readonly VITE_DEMO_SEAM_LEDGER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
