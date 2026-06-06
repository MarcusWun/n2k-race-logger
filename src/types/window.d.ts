import type { N2KAPI } from '../../electron/preload';

declare global {
  interface Window {
    n2k: N2KAPI;
  }
}
