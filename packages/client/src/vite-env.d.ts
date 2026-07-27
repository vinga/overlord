/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" / "true" re-enables the per-room session name prefix. Off by default. */
  readonly VITE_OVERLORD_ROOM_PREFIX?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}
