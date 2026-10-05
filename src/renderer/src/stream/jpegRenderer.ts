/** 브라우저 전역에 닿는 부분. 테스트는 가짜를 넘긴다. */
export interface JpegRendererDeps {
  /** JPEG 한 장을 디코드한다. 기본은 `createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }))`. */
  decode(jpeg: Uint8Array): Promise<ImageBitmap>
  /** 캔버스에 그리고 bitmap.close()를 부른다. */
  draw(bitmap: ImageBitmap): void
}

export interface JpegRenderer {
  push(jpeg: Uint8Array): void
  close(): void
}

/** Blob에는 view를 그대로 넘긴다 — `.buffer`를 쓰면 byteOffset이 무시된다. */
export function decodeJpeg(jpeg: Uint8Array): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }))
}

/**
 * JPEG 프레임을 한 장씩 디코드해 그린다. 디코드 중에 온 프레임은 최신 한 장만 남기고 앞의 것은
 * 버린다 — 에이전트를 지켜보는 용도라 밀린 프레임을 다 그리는 것보다 최신 화면이 낫고, 큐가
 * 자라지 않아야 한다. 디코드가 끝나면 남은 한 장을 이어서 디코드한다.
 */
export function createJpegRenderer(deps: JpegRendererDeps): JpegRenderer {
  let closed = false
  let busy = false
  let latest: Uint8Array | null = null

  async function run(first: Uint8Array): Promise<void> {
    busy = true
    let next: Uint8Array | null = first
    while (next && !closed) {
      latest = null
      try {
        const bitmap = await deps.decode(next)
        if (closed) bitmap.close()
        else deps.draw(bitmap)
      } catch {
        // 깨진 JPEG 한 장은 건너뛴다. 다음 프레임이 곧 온다.
      }
      next = latest
    }
    busy = false
  }

  return {
    push(jpeg) {
      if (closed) return
      if (busy) latest = jpeg
      else void run(jpeg)
    },
    close() {
      closed = true
      latest = null
    }
  }
}
