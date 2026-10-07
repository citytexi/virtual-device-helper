/** 브라우저 전역에 닿는 부분. 테스트는 가짜를 넘긴다. */
export interface JpegRendererDeps {
  /** JPEG 한 장을 디코드한다. 기본은 `createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }))`. */
  decode(jpeg: Uint8Array): Promise<ImageBitmap>
  /** 캔버스에 그리고 bitmap.close()를 부른다. */
  draw(bitmap: ImageBitmap): void
  /** 연속 실패가 한도에 닿아 포기할 때 한 번 불린다. 이후 renderer는 아무것도 그리지 않는다. */
  onError(error: Error): void
  /** 프레임 한 장의 처리가 끝났다(그렸거나, 실패했거나, 최신 장에 밀려 버려졌다). 닫힌 뒤에는 불리지 않는다. */
  ack(): void
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

  /** ack가 던져도 흐름을 깨지 않는다 — 프레임 실패로 세지도, 루프를 멈추지도 않는다. */
  function ack(): void {
    try {
      deps.ack()
    } catch {
      // 확인은 최선 노력이다. main은 재동기 타이머로 되살아난다.
    }
  }

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
      // 닫힌 뒤(바깥 close, 연속 실패로 포기)에는 확인하지 않는다. try 밖이라 ack 실패가 프레임 실패로 세지 않는다.
      if (!closed) ack()
      next = latest
    }
    busy = false
  }

  return {
    push(jpeg) {
      if (closed) return
      if (busy) {
        // 덮이는 장은 더 처리되지 않는다 — 그 장의 확인은 지금 낸다.
        if (latest) ack()
        latest = jpeg
      } else void run(jpeg)
    },
    close() {
      closed = true
      latest = null
    }
  }
}
