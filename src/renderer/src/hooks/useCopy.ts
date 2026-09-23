import { useCallback, useState } from 'react'

export type CopyStatus = { ok: true } | { ok: false; message: string }

export function copyStatusText(status: CopyStatus): string {
  return status.ok ? '복사했다' : `복사하지 못했다 — ${status.message}`
}

/**
 * 클립보드 복사와 그 결과. navigator.clipboard.writeText는 reject할 수 있다(예: 창이
 * 포커스를 잃은 상태). 실패를 삼키면 사용자는 복사됐다고 믿고 빈 값을 붙여넣게 된다.
 * 그래서 성공/실패를 항상 status로 돌려주고, 쓰는 쪽이 버튼 옆에 보여 준다.
 */
export function useCopy(): {
  status: CopyStatus | null
  copy: (text: string) => Promise<void>
  reset: () => void
} {
  const [status, setStatus] = useState<CopyStatus | null>(null)

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setStatus({ ok: true })
    } catch (thrown: unknown) {
      setStatus({ ok: false, message: thrown instanceof Error ? thrown.message : String(thrown) })
    }
  }, [])

  // 복사할 내용이 바뀌었는데 이전 결과가 남아 있으면 사용자는 지금 보이는 것이
  // 클립보드에 있다고 믿는다. 쓰는 쪽이 내용이 바뀔 때 부른다.
  const reset = useCallback(() => setStatus(null), [])

  return { status, copy, reset }
}
