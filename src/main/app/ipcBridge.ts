import type { IpcMain } from 'electron'
import { isDeviceError, type ToolError } from '../../shared/types/errors'
import type { ScreenshotResult } from '../../shared/types/device'
import { IPC_CHANNELS, type MainEvent, type Outcome } from '../../shared/types/ipc'
import type { AppState } from './appState'

export interface BridgeActions {
  selectDevice(serial: string): void
  bootAvd(name: string): Promise<void>
  shutdownDevice(serial: string): Promise<void>
  captureScreenshot(serial: string): Promise<ScreenshotResult>
}

export type SendToRenderer = (channel: string, payload: MainEvent) => void

/**
 * 실패를 예외로 던지지 않는다. Electron IPC를 넘는 Error는 stack 문자열만 남고
 * 우리가 붙인 정보가 사라진다. 결과 객체로 바꿔 renderer가 이유를 보게 한다.
 */
async function outcome<T>(run: () => Promise<T> | T): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (thrown) {
    if (isDeviceError(thrown)) return { ok: false, error: thrown.toolError }
    return {
      ok: false,
      error: {
        kind: 'command_failed',
        message: thrown instanceof Error ? thrown.message : String(thrown),
        hint: '다시 시도하고, 반복되면 활동 탭에서 맥락을 확인해라'
      }
    }
  }
}

function invalidArgument(name: string): Outcome<never> {
  const error: ToolError = {
    kind: 'command_failed',
    message: `${name}은 비어 있지 않은 문자열이어야 한다`,
    hint: '기기 목록에서 대상을 다시 골라라'
  }
  return { ok: false, error }
}

/**
 * renderer가 보내는 인자는 타입 선언과 상관없이 무엇이든 올 수 있다. 문자열 하나를
 * 받는 액션은 여기서 모양을 확인하고, 아니면 액션을 부르지 않고 실패를 돌려준다.
 */
function withText<T>(name: string, run: (text: string) => Promise<T> | T) {
  return (_event: unknown, value: unknown): Promise<Outcome<T>> => {
    if (typeof value !== 'string' || value.length === 0) return Promise.resolve(invalidArgument(name))
    return outcome(() => run(value))
  }
}

export function registerIpcBridge(
  ipcMain: IpcMain,
  state: AppState,
  actions: BridgeActions,
  send: SendToRenderer
): void {
  ipcMain.handle(IPC_CHANNELS.getSnapshot, () => state.snapshot())
  ipcMain.handle(IPC_CHANNELS.selectDevice, withText('serial', (serial) => actions.selectDevice(serial)))
  ipcMain.handle(IPC_CHANNELS.bootAvd, withText('AVD 이름', (name) => actions.bootAvd(name)))
  ipcMain.handle(IPC_CHANNELS.shutdownDevice, withText('serial', (serial) => actions.shutdownDevice(serial)))
  ipcMain.handle(IPC_CHANNELS.captureScreenshot, withText('serial', (serial) => actions.captureScreenshot(serial)))

  state.onEvent((event) => send(IPC_CHANNELS.event, event))
}
