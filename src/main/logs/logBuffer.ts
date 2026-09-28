import type { LogEntry } from '../../shared/types/logs'

/** 기기당 로그 버퍼 상한. 테스트가 주입할 수 있다. */
export const LOG_BUFFER_CAPACITY = 50_000

/**
 * 기기별 링 버퍼. LogEntry에 seq를 매긴다.
 */
export interface LogBuffer {
  /** 줄을 덧붙인다. 경계 중복이면 null. */
  append(line: Omit<LogEntry, 'seq'>): LogEntry | null

  /** 다음 append부터 마지막 timestamp와 같은 줄의 중복을 거른다. */
  markResume(): void

  /**
   * afterSeq 이후의 항목을 반환한다.
   * 갭은 afterSeq가 버퍼에 없고 현재 첫 항목이 더 큰 seq를 가질 때만 발생한다.
   */
  since(afterSeq: number): {
    gap: { fromSeq: number; toSeq: number } | null
    entries: LogEntry[]
  }

  /** 현재 버퍼의 모든 항목을 반환한다. */
  all(): LogEntry[]

  /** 버퍼의 마지막 seq를 반환한다. 비었으면 -1. */
  lastSeq(): number

  /**
   * at 이상의 첫 항목을 찾는다.
   * at은 단조 증가하지 않을 수 있으므로 앞에서부터 선형으로 찾는다.
   */
  firstAtOrAfter(at: number): LogEntry | null

  /** 버퍼의 마지막 항목의 timestamp. 비었으면 null. */
  lastTimestamp(): string | null
}

/**
 * 링 버퍼를 만든다.
 * @param capacity 버퍼 크기. 기본값은 LOG_BUFFER_CAPACITY.
 */
export function createLogBuffer(capacity: number = LOG_BUFFER_CAPACITY): LogBuffer {
  // 환형 버퍼: 고정 크기 배열과 시작 seq를 쓴다
  const buffer: (LogEntry | undefined)[] = new Array(capacity)
  let nextSeq = 0 // 다음 append에 매길 seq
  let startSeq = 0 // 버퍼의 첫 항목이 가진 seq

  // markResume 상태: 마지막 timestamp와 일치하는 항목의 중복 키별 남은 개수.
  // 같은 줄이 N번 있었으면 재생도 N번 오므로 개수로 센다.
  let resumeKeys: Map<string, number> | null = null
  let resumeTimestamp: string | null = null

  /**
   * 중복 판정 키를 만든다.
   * (timestamp, pid, tag, message)를 문자열로 연결.
   */
  function makeDedupeKey(entry: Omit<LogEntry, 'seq'>): string {
    return `${entry.timestamp}\x00${entry.pid}\x00${entry.tag}\x00${entry.message}`
  }

  function append(line: Omit<LogEntry, 'seq'>): LogEntry | null {
    // markResume 중이고 timestamp가 같으면 중복을 확인
    if (resumeKeys !== null && line.timestamp === resumeTimestamp) {
      const key = makeDedupeKey(line)
      const remaining = resumeKeys.get(key) ?? 0
      if (remaining > 0) {
        // 버퍼에 있던 개수만큼만 소비된다
        if (remaining === 1) resumeKeys.delete(key)
        else resumeKeys.set(key, remaining - 1)
        return null
      }
    } else if (resumeKeys !== null && line.timestamp !== resumeTimestamp) {
      // timestamp가 바뀌면 markResume을 종료한다
      resumeKeys = null
      resumeTimestamp = null
    }

    // seq를 매기고 항목을 만든다
    const entry: LogEntry = {
      ...line,
      seq: nextSeq,
    }

    // 링 버퍼에 저장
    const index = nextSeq % capacity
    buffer[index] = entry
    nextSeq++

    // 용량 초과 시 시작 seq를 옮긴다
    if (nextSeq - startSeq > capacity) {
      startSeq = nextSeq - capacity
    }

    return entry
  }

  function markResume(): void {
    const last = lastTimestamp()
    if (last === null) {
      resumeKeys = null
      resumeTimestamp = null
      return
    }

    // 마지막 timestamp와 같은 항목들의 중복 키를 모은다
    resumeKeys = new Map()
    resumeTimestamp = last
    for (let seq = startSeq; seq < nextSeq; seq++) {
      const idx = seq % capacity
      const entry = buffer[idx]
      if (entry && entry.timestamp === last) {
        const key = makeDedupeKey(entry)
        resumeKeys.set(key, (resumeKeys.get(key) ?? 0) + 1)
      }
    }
  }

  function since(afterSeq: number): {
    gap: { fromSeq: number; toSeq: number } | null
    entries: LogEntry[]
  } {
    // afterSeq 이후의 seq들
    const firstAvailable = startSeq
    const lastAvailable = nextSeq - 1

    // afterSeq이 현재 버퍼 범위를 벗어났는지 확인
    let gap: { fromSeq: number; toSeq: number } | null = null

    if (afterSeq >= lastAvailable) {
      // afterSeq이 마지막 항목 이상이면 반환할 항목이 없다
      return { gap: null, entries: [] }
    }

    if (afterSeq < firstAvailable - 1) {
      // afterSeq이 버퍼 범위 밖이면 갭을 보고한다
      // fromSeq는 afterSeq + 1, toSeq는 firstAvailable - 1
      gap = { fromSeq: afterSeq + 1, toSeq: firstAvailable - 1 }
    }

    // afterSeq 이후의 항목들을 모은다 (버퍼에 실제로 있는 것만)
    const entries: LogEntry[] = []
    const start = Math.max(afterSeq + 1, firstAvailable)
    for (let seq = start; seq < nextSeq; seq++) {
      const idx = seq % capacity
      const entry = buffer[idx]
      if (entry) {
        entries.push(entry)
      }
    }

    return { gap, entries }
  }

  function all(): LogEntry[] {
    const entries: LogEntry[] = []
    for (let seq = startSeq; seq < nextSeq; seq++) {
      const idx = seq % capacity
      const entry = buffer[idx]
      if (entry) {
        entries.push(entry)
      }
    }
    return entries
  }

  function lastSeq(): number {
    if (nextSeq === 0) return -1
    return nextSeq - 1
  }

  function firstAtOrAfter(at: number): LogEntry | null {
    // 앞에서부터 선형으로 찾는다 (단조 증가 보장 안 됨)
    for (let seq = startSeq; seq < nextSeq; seq++) {
      const idx = seq % capacity
      const entry = buffer[idx]
      if (entry && entry.at >= at) {
        return entry
      }
    }
    return null
  }

  function lastTimestamp(): string | null {
    if (nextSeq === 0) return null
    const lastSeqVal = nextSeq - 1
    const idx = lastSeqVal % capacity
    const entry = buffer[idx]
    return entry?.timestamp ?? null
  }

  return {
    append,
    markResume,
    since,
    all,
    lastSeq,
    firstAtOrAfter,
    lastTimestamp,
  }
}
