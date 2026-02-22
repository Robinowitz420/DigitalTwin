import type { DigitalTwinApi } from '../main/preload'

declare global {
  interface Window {
    digitalTwin: DigitalTwinApi
  }
}

export {}
