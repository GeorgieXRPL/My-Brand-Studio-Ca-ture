/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_HUB_URL?: string;
  readonly VITE_PRIVY_APP_ID?: string;
  readonly VITE_PRIVY_CLIENT_ID?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
