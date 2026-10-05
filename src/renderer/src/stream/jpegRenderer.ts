/** 브라우저 전역에 닿는 부분. 테스트는 가짜를 넘긴다. */
export interface JpegRendererDeps {
  /** JPEG 한 장을 디코드한다. 기본은 `createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }))`. */
  decode(jpeg: Uint8Array): Promise<ImageBitmap>
  /** 캔버스에 그리고 bitmap.close()를 부른다. */
  draw(bitmap: ImageBitmap): void
  /** 연속 실패가 한도에 닿아 포기할 때 한 번 불린다. 이후 renderer는 아무것도 그리지 않는다. */
  onError(error: Error): void
}

/** 연속 decode/draw 실패 한도. 한 장 깨진 것은 건너뛰지만 계속 깨지면 사람이 알아야 한다. */
export const MAX_CONSECUTIVE_FAILURES = 10

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
  let failures = 0

  async function run(first: Uint8Array): Promise<void> {
    busy = true
    let next: Uint8Array | null = first
    while (next && !closed) {
      latest = null
      try {
        const bitmap = await deps.decode(next)
        if (closed) bitmap.close()
        else {
          try {
            deps.draw(bitmap)
          } catch (error) {
            // draw가 bitmap을 닫기 전에 던졌을 수 있다 — 두 번 닫아도 무해하다.
            bitmap.close()
            throw error
          }
        }
        failures = 0
      } catch (error) {
        // 깨진 한 장은 건너뛴다. 연속으로 한도만큼 깨지면 포기하고 알린다.
        failures += 1
        if (failures >= MAX_CONSECUTIVE_FAILURES && !closed) {
          closed = true
          latest = null
          deps.onError(error instanceof Error ? error : new Error(String(error)))
        }
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
