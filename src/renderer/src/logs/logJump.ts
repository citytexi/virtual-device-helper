import type { LogRow } from '../hooks/useLogStream'

/**
 * 타임라인의 시각 `at`(호스트 epoch ms)에 해당하는 로그 행을 찾는다. M3-3이 이벤트에서
 * 로그로 건너뛸 때 쓴다.
 *
 * - `all`은 걸러지기 전 버퍼(useLogStream의 `rows`)이고 살아있는 행은 `all[start..)`이다.
 *   그 가장 오래된 line 행보다 `at`이 앞이면 이미 밀려난 구간이라 `'evicted'`다.
 * - 그 밖이면 `visible`(걸러진 행)에서 `entry.at >= at`인 첫 line 행의 index를 준다. gap 행은
 *   시각이 없어 건너뛴다. 없으면 마지막 index, `visible`이 비었으면 -1이다.
 *
 * 기기 시각은 엄격히 단조롭지 않을 수 있어서 이분 탐색 대신 앞에서부터 훑는다. 한 번 누를 때
 * 한 번 도는 일이라 비용이 문제 되지 않는다.
 */
export function findJumpIndex(
  all: readonly LogRow[],
  visible: readonly LogRow[],
  at: number,
  start = 0
): { index: number } | 'evicted' {
  for (let i = start; i < all.length; i++) {
    const row = all[i]
    if (row && row.kind === 'line') {
      if (at < row.entry.at) return 'evicted'
      break
    }
  }
  if (visible.length === 0) return { index: -1 }

  for (let i = 0; i < visible.length; i++) {
    const row = visible[i]
    if (row && row.kind === 'line' && row.entry.at >= at) return { index: i }
  }
  return { index: visible.length - 1 }
}
