import { vi } from 'vitest'
import type { ExecOpts, ExecResult } from '../process/processClient'
import type { AxeClient } from './axeClient'
import type { SimctlClient } from './simctlClient'

/** 성공 응답을 만든다. */
export function execOk(stdout = ''): ExecResult {
  return { stdout, stdoutRaw: Buffer.from(stdout), stderr: '', exitCode: 0 }
}

/**
 * 키가 `args.join(' ')`인 가짜 simctl. 값이 Error면 reject한다.
 * 등록하지 않은 명령은 테스트가 놓친 호출이므로 reject해서 바로 드러낸다.
 */
export function fakeSimctl(
  handlers: Record<string, ExecResult | Error>
): SimctlClient & { calls: string[][]; inputs: Array<string | undefined> } {
  const calls: string[][] = []
  // calls와 같은 인덱스로 그 호출의 stdin 입력을 담는다. 입력이 없으면 undefined다.
  const inputs: Array<string | undefined> = []
  return {
    calls,
    inputs,
    exec: vi.fn(async (args: string[], opts?: ExecOpts): Promise<ExecResult> => {
      calls.push(args)
      inputs.push(opts?.input === undefined ? undefined : opts.input.toString())
      const handler = handlers[args.join(' ')]
      if (handler === undefined) throw new Error(`fakeSimctl: 등록되지 않은 명령 ${args.join(' ')}`)
      if (handler instanceof Error) throw handler
      return handler
    }),
    stream: vi.fn()
  }
}

/**
 * 키가 `args.join(' ')`인 가짜 axe. `--udid`는 클라이언트가 붙이므로 키에 넣지 않는다.
 * 값이 Error면 reject하고, 등록하지 않은 명령은 reject해서 바로 드러낸다.
 */
export function fakeAxe(handlers: Record<string, ExecResult | Error>): AxeClient & { calls: Array<{ args: string[]; input?: string }> } {
  const calls: Array<{ args: string[]; input?: string }> = []
  return {
    calls,
    exec: vi.fn(async (_udid: string, args: string[], opts?: ExecOpts): Promise<ExecResult> => {
      calls.push(opts?.input === undefined ? { args } : { args, input: opts.input.toString() })
      const handler = handlers[args.join(' ')]
      if (handler === undefined) throw new Error(`fakeAxe: 등록되지 않은 명령 ${args.join(' ')}`)
      if (handler instanceof Error) throw handler
      return handler
    }),
    stream: vi.fn()
  }
}
