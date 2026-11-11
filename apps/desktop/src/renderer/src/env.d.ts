import type { NsaBridge } from '@nsa/core';

declare global {
  interface Window {
    nsa: NsaBridge;
  }
}
