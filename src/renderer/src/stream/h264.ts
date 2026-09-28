const NAL_TYPE_SPS = 7

function hex(value: number): string {
  return value.toString(16).padStart(2, '0')
}

/**
 * config 패킷(Annex-B)에서 SPS를 찾아 WebCodecs codec 문자열 `avc1.PPCCLL`을 만든다.
 * NAL 헤더 다음 세 바이트가 profile_idc·constraint_flags·level_idc다. 해상도는 여기서
 * 읽지 않는다 — 서버의 session meta가 알려 준다.
 */
export function codecFromConfig(config: Uint8Array): string | null {
  for (let i = 0; i + 2 < config.length; i += 1) {
    if (config[i] !== 0 || config[i + 1] !== 0) continue

    let nal = -1
    if (config[i + 2] === 1) nal = i + 3
    else if (config[i + 2] === 0 && config[i + 3] === 1) nal = i + 4
    if (nal < 0 || nal + 3 >= config.length) continue

    if (((config[nal] as number) & 0x1f) !== NAL_TYPE_SPS) continue
    return `avc1.${hex(config[nal + 1] as number)}${hex(config[nal + 2] as number)}${hex(config[nal + 3] as number)}`
  }
  return null
}
