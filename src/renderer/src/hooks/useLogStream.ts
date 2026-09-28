import { useEffect, useRef, useState } from 'react'
import type { Outcome } from '../../../shared/types/ipc'
import type { LogDown, LogEntry, LogPortMeta, TailState } from '../../../shared/types/logs'
import { onLogPort } from '../logs/logPort'

/** 버퍼 한 행. 실제 줄이거나, resume·flush 사이에 밀려나 못 받은 구간을 나타내는 gap이다. */
export type LogRow = { kind: 'line'; entry: LogEntry } | { kind: 'gap'; fromSeq: number; toSeq: number }

export interface LogStream {
  rows: LogRow[]
  status: TailState | 'idle'
  packages: string[]
  caughtUp: boolean
  /** rows가 바뀔 때마다(비우는 것 포함) 1 늘어난다. */
  version: number
}

/** 브라우저 전역에 닿는 부분. 테스트는 이것을 통째로 넘긴다. */
export interface LogStreamDeps {
  openLogs(serial: string): Promise<Outcome<void>>
  closeLogs(): Promise<Outcome<void>>
  onLogPort(callback: (meta: LogPortMeta, port: MessagePort) => void): () => void
}

/** renderer 버퍼 상한. main의 LOG_BUFFER_CAPACITY와 같다. */
export const RENDERER_LOG_CAPACITY = 50_000

function browserDeps(): LogStreamDeps {
  return {
    openLogs: (serial) => window.api.openLogs(serial),
    closeLogs: () => window.api.closeLogs(),
    onLogPort: (callback) => onLogPort(callback)
  }
}

/** 가변 버퍼. 앞을 자를 때 splice로 당기지 않고 start를 올렸다가, capacity만큼 쌓이면 한 번에 압축한다. */
interface RowBuffer {
  rows: LogRow[]
  start: number
}

function appendRows(buf: RowBuffer, capacity: number, next: LogRow[]): void {
  if (next.length === 0) return
  buf.rows.push(...next)
  const size = buf.rows.length - buf.start
  if (size > capacity) buf.start += size - capacity
  if (buf.start >= capacity) {
    buf.rows.splice(0, buf.start)
    buf.start = 0
  }
}

/**
 * serial의 로그 포트를 받아 버퍼에 쌓는다. 포트는 main이 열고(openLogs), 실제 포트는
 * onLogPort로 따로 온다 — streamPort.ts#onStreamPort/useScrcpyStream.ts와 같은 얼개다.
 *
 * 활성 기기가 바뀌면(serial 변경) 옛 포트를 닫고 새로 연다. 같은 serial이라도 새 포트가
 * 오면(재연결) 이전 포트를 닫고 버퍼를 비워 새로 채운다. status가 stopped가 된 뒤 포트가
 * 닫혀도 버퍼는 남겨 두고 상태만 보인다 — 여기서 자동으로 다시 열지 않는다.
 */
export function useLogStream(
  serial: string | null,
  visible: boolean,
  deps?: LogStreamDeps,
  capacity: number = RENDERER_LOG_CAPACITY
): LogStream {
  const depsRef = useRef<LogStreamDeps | null>(deps ?? null)
  if (!depsRef.current) depsRef.current = browserDeps()

  const [status, setStatus] = useState<TailState | 'idle'>('idle')
  const [packages, setPackages] = useState<string[]>([])
  const [caughtUp, setCaughtUp] = useState(false)
  const [version, setVersion] = useState(0)

  const bufRef = useRef<RowBuffer>({ rows: [], start: 0 })
  const viewRef = useRef<{ version: number; rows: LogRow[] }>({ version: -1, rows: [] })
  // 처리한 마지막 seq. 이 값 이하의 줄·gap은 다시 와도 무시한다 — StrictMode 이중 호출에서도
  // 결과가 같아야 하기 때문이다.
  const lastSeqRef = useRef(-1)
  const portRef = useRef<MessagePort | null>(null)
  // 렌더 중 직접 최신값을 채운다 — 포트를 새로 받을 때(비동기) 그 순간의 가시성을 보려는 것이다.
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  function clearBuffer(): void {
    bufRef.current = { rows: [], start: 0 }
    lastSeqRef.current = -1
    setVersion((v) => v + 1)
  }

  function bumpVersion(): void {
    setVersion((v) => v + 1)
  }

  useEffect(() => {
    const d = depsRef.current as LogStreamDeps
    let active = true

    // 새 effect 실행(serial·capacity 변경, 마운트) = 새 세션 취급.
    clearBuffer()
    setStatus('idle')
    setPackages([])
    setCaughtUp(false)

    if (serial === null) {
      return () => {
        active = false
      }
    }

    function release(): void {
      portRef.current?.close()
      portRef.current = null
    }

    // fresh(비어 있지 않은) 목록을 버퍼에 더하고 lastSeqRef를 마지막 seq로 올린다.
    function appendFreshEntries(entries: LogEntry[]): void {
      const fresh = entries.filter((e) => e.seq > lastSeqRef.current)
      const last = fresh.at(-1)
      if (!last) return
      appendRows(
        bufRef.current,
        capacity,
        fresh.map((e) => ({ kind: 'line' as const, entry: e }))
      )
      lastSeqRef.current = last.seq
      bumpVersion()
    }

    function handleDown(message: LogDown): void {
      if (message.type === 'snapshot') {
        appendFreshEntries(message.entries)
        if (message.done) setCaughtUp(true)
      } else if (message.type === 'batch') {
        appendFreshEntries(message.entries)
      } else if (message.type === 'gap') {
        if (message.toSeq > lastSeqRef.current) {
          appendRows(bufRef.current, capacity, [{ kind: 'gap', fromSeq: message.fromSeq, toSeq: message.toSeq }])
          lastSeqRef.current = message.toSeq
          bumpVersion()
        }
      } else if (message.type === 'packages') {
        setPackages(message.packages)
      } else if (message.type === 'status') {
        setStatus(message.state)
      } else if (message.type === 'resumed') {
        lastSeqRef.current = Math.max(lastSeqRef.current, message.lastSeq)
        setCaughtUp(true)
      }
    }

    function adopt(next: MessagePort): void {
      release()
      // 새 포트 = 새 세션(재연결 포함). 버퍼를 비우고 새로 채운다.
      clearBuffer()
      setStatus('idle')
      setPackages([])
      setCaughtUp(false)
      portRef.current = next
      next.onmessage = (event: MessageEvent) => {
        if (!active || portRef.current !== next) return
        handleDown(event.data as LogDown)
      }
      // 이미 숨겨진 상태로 재연결됐으면 새 포트에도 바로 pause를 보낸다.
      if (!visibleRef.current) next.postMessage({ type: 'pause' })
    }

    const unsubscribe = d.onLogPort((meta, next) => {
      if (!active || meta.serial !== serial) {
        next.close()
        return
      }
      adopt(next)
    })

    d.openLogs(serial).then(
      (outcome) => {
        if (!active) return
        if (!outcome.ok) {
          setStatus('stopped')
          clearBuffer()
        }
      },
      () => {
        if (!active) return
        setStatus('stopped')
        clearBuffer()
      }
    )

    return () => {
      active = false
      unsubscribe()
      release()
      d.closeLogs().catch(() => {})
    }
  }, [serial, capacity])

  // 가시성 전환에만 반응한다 — 마운트 시 최초 값은 건너뛴다(첫 세션은 이미 unpaused로 시작한다).
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }
    if (!visible) {
      // "그 자리에서" caughtUp을 내린다 — main의 확인을 기다리지 않는다.
      setCaughtUp(false)
      portRef.current?.postMessage({ type: 'pause' })
    } else {
      portRef.current?.postMessage({ type: 'resume', afterSeq: lastSeqRef.current })
    }
  }, [visible])

  if (viewRef.current.version !== version) {
    viewRef.current = { version, rows: bufRef.current.rows.slice(bufRef.current.start) }
  }

  return { rows: viewRef.current.rows, status, packages, caughtUp, version }
}
