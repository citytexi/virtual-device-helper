import { join } from 'node:path'

/**
 * 번들한 scrcpy-server.jar의 버전. 서버 실행 인자의 첫 값으로 넘기며 서버의
 * BuildConfig.VERSION_NAME과 정확히 같아야 한다. vendor/scrcpy/VERSION과 테스트로 묶여 있다.
 */
export const SCRCPY_SERVER_VERSION = '4.1'

export interface JarLocationInput {
  isPackaged: boolean
  /** Electron의 process.resourcesPath */
  resourcesPath: string
  /** Electron의 app.getAppPath(). 개발 중에는 package.json이 있는 저장소 루트다. */
  appPath: string
}

/** jar는 asar 안에 두지 않는다. adb push가 읽을 실제 파일 경로가 필요하다. */
export function resolveScrcpyJar(input: JarLocationInput): string {
  if (input.isPackaged) return join(input.resourcesPath, 'scrcpy-server.jar')
  return join(input.appPath, 'vendor', 'scrcpy', 'scrcpy-server.jar')
}
