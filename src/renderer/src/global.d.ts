import type { RendererApi } from '../../shared/types/ipc'

declare global {
  interface Window {
    api: RendererApi
  }
}

export {}
