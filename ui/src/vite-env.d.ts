// /// <reference types="vite/client" />

declare module '*.css';

declare module '*.svg' {
  import * as React from 'react';
  export const ReactComponent: React.FunctionComponent<React.SVGProps<SVGSVGElement> & { title?: string }>;
}

declare module '/scripts/api.js' {
  interface ComfyAPI {
    addEventListener(type: string, listener: (event: any) => void): void;
    removeEventListener(type: string, listener: (event: any) => void): void;
  }
  export const api: ComfyAPI;
}
