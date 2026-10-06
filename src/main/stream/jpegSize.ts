/**
 * JPEG 마커를 훑어 프레임 크기를 읽는다. SOF0/SOF1/SOF2 세그먼트에만 크기가 있고,
 * 그 앞의 APPn·DQT 같은 세그먼트는 길이 필드만 보고 건너뛴다.
 * SOF를 못 찾거나 데이터가 잘렸으면 null이다.
 */
/** 범위 밖 인덱스는 0으로 본다. 호출 전에 길이를 확인한다. */
function at(b: Uint8Array, i: number): number {
  return b[i] ?? 0
}

export function jpegSize(jpeg: Uint8Array): { width: number; height: number } | null {
  if (jpeg.length < 4 || at(jpeg, 0) !== 0xff || at(jpeg, 1) !== 0xd8) return null
  let i = 2
  while (i + 4 <= jpeg.length) {
    if (at(jpeg, i) !== 0xff) return null
    const marker = at(jpeg, i + 1)
    // 0xff 채움 바이트
    if (marker === 0xff) {
      i += 1
      continue
    }
    // 길이 필드가 없는 마커(TEM, RSTn, SOI)
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2
      continue
    }
    // EOI, SOS 이후엔 SOF가 올 수 없다.
    if (marker === 0xd9 || marker === 0xda) return null
    const length = (at(jpeg, i + 2) << 8) | at(jpeg, i + 3)
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      // 길이(2) 정밀도(1) 높이(2) 너비(2)
      if (i + 9 > jpeg.length) return null
      const height = (at(jpeg, i + 5) << 8) | at(jpeg, i + 6)
      const width = (at(jpeg, i + 7) << 8) | at(jpeg, i + 8)
      return width > 0 && height > 0 ? { width, height } : null
    }
    if (length < 2) return null
    i += 2 + length
  }
  return null
}
