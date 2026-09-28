import type { LogLine } from './device'

/**
 * tail 줄의 상태.
 */
export type TailState = 'running' | 'reconnecting' | 'stopped'

/**
 * 로그 버퍼의 항목. LogLine에 메타데이터를 더한다.
 */
export interface LogEntry extends LogLine {
  /** 기기별 단조 증가. 연결마다 0부터. */
  seq: number
  /** 기기 timestamp를 호스트 epoch ms로 바꾼 값. 타임라인과 맞출 때 쓴다. */
  at: number
  /** 이 줄을 받은 순간 pid의 주인 패키지. 모르면 없다. */
  pkg?: string
}

/**
 * renderer에서 main으로 보내는 메시지.
 */
export type LogUp =
  | { type: 'pause' }
  | { type: 'resume'; afterSeq: number }

/**
 * main에서 renderer로 보내는 메시지.
 */
export type LogDown =
  | { type: 'snapshot'; entries: LogEntry[]; done: boolean }
  | { type: 'batch'; entries: LogEntry[] }
  | { type: 'gap'; fromSeq: number; toSeq: number }
  | { type: 'packages'; packages: string[] }
  | { type: 'status'; state: TailState }
  | { type: 'resumed'; lastSeq: number }

/**
 * 로그 포트의 메타데이터.
 */
export interface LogPortMeta {
  serial: string
  /** 포트 하나를 가리킨다. renderer는 마지막으로 받은 sessionId의 포트만 쓰고 이전 포트는 닫는다. */
  sessionId: string
}
