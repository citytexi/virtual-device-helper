/**
 * Android 패키지명 형식. 점으로 나뉜 조각이 둘 이상이고, 첫 조각은 영문자로 시작한다.
 *
 * `adb shell`은 넘긴 인자를 공백으로 다시 이어 붙이고 기기 셸이 그것을 다시 파싱한다
 * (`androidDevice.ts`의 `quoteComponent` 주석 참고). 그래서 패키지명을 셸 인자로 넘기는
 * 곳은 이 형식을 통과한 값만 넘긴다. `log_read`의 입력 스키마(mcpTools 층)와 `pidof`
 * 래퍼(`logs/adbLogDeps.ts`)가 함께 쓰므로 두 층이 기댈 수 있는 shared에 둔다.
 */
export const ANDROID_PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/

export function isAndroidPackageName(value: string): boolean {
  return ANDROID_PACKAGE_PATTERN.test(value)
}
