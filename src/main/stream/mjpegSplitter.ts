/**
 * `axe stream-video --format mjpeg` stdout을 JPEG 한 장씩 자른다.
 *
 * 스트림은 `HTTP/1.1 200 OK` 응답 헤더(`multipart/x-mixed-replace; boundary=--mjpegstream`)로
 * 시작하고, 이어서 파트마다 `--mjpegstream`, `Content-Type`, `Content-Length` 헤더와 본문이 온다.
 * JPEG 본문 안에도 `FF D9`나 CRLF가 나올 수 있으므로 SOI/EOI를 스캔하지 않고
 * `Content-Length`로 자른다. 그다음 본문이 SOI(`FF D8`)로 시작해 EOI(`FF D9`)로 끝나는지 확인한다.
 * 깨진 파트(길이 없음·잘못된 길이·SOI/EOI 불일치·`maxFrameBytes` 초과)는 버리고
 * 다음 경계(`\r\n--`)에서 다시 맞춘다. axe 기본 인자가 내는 PNG 파트도 SOI 검사에서 버려진다.
 */

const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024
/** 헤더 블록이 이보다 길면 스트림이 어긋난 것으로 보고 다시 맞춘다. */
const MAX_HEADER_BYTES = 8 * 1024
const HEADER_END = Buffer.from('\r\n\r\n')
const BOUNDARY_MARK = Buffer.from('\r\n--')

export interface MjpegSplitter {
  push(chunk: Buffer): void
}

type State =
  | { kind: 'header' }
  | { kind: 'resync' }
  | { kind: 'body'; buf: Buffer; filled: number }
  | { kind: 'skip'; remaining: number }

export function createMjpegSplitter(
  onFrame: (jpeg: Uint8Array) => void,
  opts: { maxFrameBytes?: number } = {}
): MjpegSplitter {
  const maxFrameBytes = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
  let state: State = { kind: 'header' }
  // header·resync 상태에서만 쓰는 작은 누적 버퍼
  let head: Buffer = Buffer.alloc(0)

  function resync(): void {
    state = { kind: 'resync' }
  }

  function finishBody(body: Buffer): void {
    const ok =
      body.length >= 4 &&
      body[0] === 0xff &&
      body[1] === 0xd8 &&
      body[body.length - 2] === 0xff &&
      body[body.length - 1] === 0xd9
    // 길이가 맞았다면 바로 다음이 경계라 곧장 맞춰진다. 틀렸다면 경계까지 버린다.
    // onFrame이 던져도 같은 프레임을 다시 내지 않도록 상태를 먼저 옮긴다.
    resync()
    if (ok) onFrame(new Uint8Array(body.buffer, body.byteOffset, body.length))
  }

  /** 헤더 블록 하나를 해석한다. 다음 상태로 넘어간다. */
  function handleHeader(block: string): void {
    const lower = block.toLowerCase()
    const m = /(?:^|\r\n)content-length:\s*(\d+)\s*(?:\r\n|$)/.exec(lower)
    if (!m) {
      // 응답 헤더나 경계만 있는 블록은 건너뛰고, 파트 헤더인데 길이가 없으면 깨진 파트다.
      if (lower.includes('content-type: image/') || lower.includes('content-length')) resync()
      return
    }
    const length = Number(m[1])
    if (!Number.isSafeInteger(length) || length <= 0) {
      resync()
    } else if (length > maxFrameBytes) {
      state = { kind: 'skip', remaining: length }
    } else {
      // 공유 풀(8KB)을 쓰지 않는 자기 소유 버퍼. 포트로 보낼 때 풀 전체가 복사되지 않는다.
      state = { kind: 'body', buf: Buffer.allocUnsafeSlow(length), filled: 0 }
    }
  }

  function push(chunk: Buffer): void {
    let data = chunk
    while (data.length > 0) {
      if (state.kind === 'body') {
        const n = Math.min(state.buf.length - state.filled, data.length)
        // 호출자가 chunk를 재사용해도 안전하도록 자기 버퍼로 복사한다.
        data.copy(state.buf, state.filled, 0, n)
        state.filled += n
        data = data.subarray(n)
        if (state.filled === state.buf.length) finishBody(state.buf)
      } else if (state.kind === 'skip') {
        const n = Math.min(state.remaining, data.length)
        state.remaining -= n
        data = data.subarray(n)
        if (state.remaining === 0) resync()
      } else if (state.kind === 'resync') {
        const all = head.length > 0 ? Buffer.concat([head, data]) : data
        const i = all.indexOf(BOUNDARY_MARK)
        if (i >= 0) {
          head = Buffer.alloc(0)
          state = { kind: 'header' }
          data = all.subarray(i)
        } else {
          // 경계가 청크 사이에 걸칠 수 있어 끝 3바이트만 남긴다.
          head = Buffer.from(all.subarray(Math.max(0, all.length - (BOUNDARY_MARK.length - 1))))
          data = Buffer.alloc(0)
        }
      } else {
        const all = head.length > 0 ? Buffer.concat([head, data]) : data
        const i = all.indexOf(HEADER_END)
        if (i < 0) {
          if (all.length > MAX_HEADER_BYTES) {
            head = Buffer.alloc(0)
            resync()
          } else {
            head = Buffer.from(all)
          }
          data = Buffer.alloc(0)
        } else {
          head = Buffer.alloc(0)
          handleHeader(all.subarray(0, i).toString('latin1'))
          data = all.subarray(i + HEADER_END.length)
        }
      }
    }
  }

  return { push }
}
