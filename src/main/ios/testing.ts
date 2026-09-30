import { vi } from 'vitest'
import type { ExecResult } from '../process/processClient'
import type { SimctlClient } from './simctlClient'

/** 성공 응답을 만든다. */
export function execOk(stdout = ''): ExecResult {
  return { stdout, stdoutRaw: Buffer.from(stdout), stderr: '', exitCode: 0 }
}

/**
 * 키가 `args.join(' ')`인 가짜 simctl. 값이 Error면 reject한다.
 * 등록하지 않은 명령은 테스트가 놓친 호출이므로 reject해서 바로 드러낸다.
 */
export function fakeSimctl(handlers: Record<string, ExecResult | Error>): SimctlClient & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    exec: vi.fn(async (args: string[]): Promise<ExecResult> => {
      calls.push(args)
      const handler = handlers[args.join(' ')]
      if (handler === undefined) throw new Error(`fakeSimctl: 등록되지 않은 명령 ${args.join(' ')}`)
      if (handler instanceof Error) throw handler
      return handler
    }),
    stream: vi.fn()
  }
}
