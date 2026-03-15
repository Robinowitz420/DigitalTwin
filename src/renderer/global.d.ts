import type { DigitalTwinApi } from '../main/preload.js'

declare global {
  interface Window {
    digitalTwin: DigitalTwinApi
  }
}

export {}
