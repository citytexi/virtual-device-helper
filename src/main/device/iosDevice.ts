import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { readdir, readFile as fsReadFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SimctlClient } from '../ios/simctlClient'
import { deviceError, isDeviceError, unsupported } from '../../shared/types/errors'
import type {
  Device,
  DeviceInfo,
  DisplayFrame,
  InstallOpts,
  KeyName,
  LogReadResult,
  ScreenshotOpts,
  ScreenshotResult,
  UiDump
} from '../../shared/types/device'
import { assertValidScreenshotScale, DEFAULT_MAX_LONG_EDGE, scaledLongEdge } from './androidDevice'
import { parseSimctlDevices } from './parsers/simctlDevices'
import type { ResizeImage } from './resizeImage'

export interface IosDeviceDeps {
  udid: string
  simctl: SimctlClient
  resizeImage: ResizeImage
  /** `plutil -extract CFBundleIdentifier raw -o - <plist>`. 기본값은 execFile. */
  readBundleId?: (infoPlistPath: string) => Promise<string>
  fileExists?: (path: string) => boolean
  isDirectory?: (path: string) => boolean
  /** 데이터 컨테이너 안쪽을 비운다. 기본값은 readdir + rm({ recursive: true, force: true }). */
  emptyDirectory?: (path: string) => Promise<void>
  /** 스크린샷 임시 파일 읽기·삭제. 기본값은 node:fs/promises. */
  readFile?: (path: string) => Promise<Buffer>
  removeFile?: (path: string) => Promise<void>
  now?: () => number
}

const SCREENSHOT_TIMEOUT_MS = 60_000
const INSTALL_TIMEOUT_MS = 180_000
const DATA_CONTAINER_MARKER = '/data/Containers/Data/Application/'

/** 셸 없이 plutil을 부른다. 경로는 인자 배열로만 넘긴다. */
function defaultReadBundleId(infoPlistPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlistPath], (error, stdout) => {
      if (error) {
        reject(
          deviceError('app_path_invalid', 'Info.plist에서 CFBundleIdentifier를 읽지 못했다', '.app 번들이 온전한지 확인해라', {
            infoPlistPath,
            reason: error.message
          })
        )
        return
      }
      resolve(stdout.trim())
    })
  })
}

async function defaultEmptyDirectory(path: string): Promise<void> {
  for (const entry of await readdir(path)) {
    await rm(join(path, entry), { recursive: true, force: true })
  }
}

/** PNG 원본 크기. IHDR 청크의 너비·높이(빅엔디언)를 읽는다. */
function readPngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.toString('ascii', 12, 16) !== 'IHDR') {
    throw deviceError('command_failed', '스크린샷이 PNG가 아니다', '시뮬레이터가 부팅됐는지 확인해라')
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

function stderrOf(error: unknown): string {
  return isDeviceError(error) && typeof error.toolError.details?.stderr === 'string' ? error.toolError.details.stderr : ''
}

export function createIosDevice(deps: IosDeviceDeps): Device & { readonly platform: 'ios' } {
  const {
    udid,
    simctl,
    resizeImage,
    readBundleId = defaultReadBundleId,
    fileExists = existsSync,
    isDirectory = (path: string) => {
      try {
        return statSync(path).isDirectory()
      } catch {
        return false
      }
    },
    emptyDirectory = defaultEmptyDirectory,
    readFile = fsReadFile,
    removeFile = (path: string) => rm(path, { force: true })
  } = deps

  // 화면 크기는 연결 동안 바뀌지 않으므로 한 번 재서 캐시한다. 실패는 캐시하지 않는다.
  let sizeCache: { width: number; height: number } | null = null

  /** 스크린샷 PNG 원본. `screenshot -`는 stdout에 쓰지 않으므로 임시 파일을 거친다. */
  async function capturePng(): Promise<Buffer> {
    const path = join(tmpdir(), `vdh-ios-${randomUUID()}.png`)
    try {
      await simctl.exec(['io', udid, 'screenshot', '--type=png', path], { timeoutMs: SCREENSHOT_TIMEOUT_MS })
      return await readFile(path)
    } finally {
      await removeFile(path).catch(() => {})
    }
  }

  async function info(): Promise<DeviceInfo> {
    const listed = await simctl.exec(['list', 'devices', '-j'])
    const entry = parseSimctlDevices(listed.stdout).find((candidate) => candidate.udid === udid)
    if (!entry) {
      throw deviceError('no_device', `시뮬레이터 ${udid}를 찾을 수 없다`, 'device_list로 시뮬레이터 UDID를 확인해라', { udid })
    }

    if (!sizeCache) sizeCache = readPngSize(await capturePng())

    return {
      serial: udid,
      platform: 'ios',
      model: entry.name,
      osVersion: entry.osVersion,
      width: sizeCache.width,
      height: sizeCache.height
    }
  }

  async function screenshot(opts: ScreenshotOpts = {}): Promise<ScreenshotResult> {
    assertValidScreenshotScale(opts.scale)

    const png = await capturePng()
    const size = readPngSize(png)
    sizeCache = size

    const maxLongEdge = opts.scale !== undefined ? scaledLongEdge(size, opts.scale) : DEFAULT_MAX_LONG_EDGE
    const resized = resizeImage(png, maxLongEdge)
    return { base64: resized.png.toString('base64'), width: resized.width, height: resized.height }
  }

  async function install(appPath: string, _opts: InstallOpts = {}): Promise<string | null> {
    // simctl install은 늘 덮어쓰므로 reinstall 옵션은 볼 필요가 없다.
    const path = appPath.replace(/\/+$/, '')

    if (!path.endsWith('.app') || !isDirectory(path)) {
      throw deviceError('app_path_invalid', `.app 디렉토리가 아니다: ${appPath}`, '시뮬레이터용으로 빌드한 .app 디렉토리의 절대 경로를 줘라', { appPath })
    }
    const infoPlist = `${path}/Info.plist`
    if (!fileExists(infoPlist)) {
      throw deviceError('app_path_invalid', `Info.plist가 없다: ${infoPlist}`, '.app 번들이 온전한지 확인해라', { appPath })
    }

    const bundleId = await readBundleId(infoPlist)
    await simctl.exec(['install', udid, path], { timeoutMs: INSTALL_TIMEOUT_MS })
    return bundleId
  }

  async function uninstall(pkg: string): Promise<void> {
    await simctl.exec(['uninstall', udid, pkg])
  }

  async function launch(pkg: string, activity?: string): Promise<void> {
    if (activity) throw unsupported('ios', 'activity 지정 실행', 'iOS 앱에는 activity가 없다')

    try {
      await simctl.exec(['launch', udid, pkg])
    } catch (error) {
      if (/not installed|found nothing/i.test(stderrOf(error))) {
        throw deviceError('package_not_found', `시뮬레이터에 ${pkg}가 설치돼 있지 않다`, 'app_install로 먼저 설치해라', { pkg })
      }
      throw error
    }
  }

  async function stop(pkg: string): Promise<void> {
    // 떠 있지 않은 앱을 종료해도 실패하지만 원하는 상태는 이미 됐으므로 성공으로 끝낸다.
    // command_failed(실행 중이 아님)만 삼킨다. 도구 없음·기기 없음 등은 그대로 던진다.
    try {
      await simctl.exec(['terminate', udid, pkg])
    } catch (error) {
      if (isDeviceError(error) && error.toolError.kind === 'command_failed') return
      throw error
    }
  }

  async function clearData(pkg: string): Promise<void> {
    await stop(pkg)

    let container: string
    try {
      container = (await simctl.exec(['get_app_container', udid, pkg, 'data'])).stdout.trim()
    } catch (error) {
      if (isDeviceError(error) && error.toolError.kind === 'command_failed') {
        throw deviceError('package_not_found', `시뮬레이터에 ${pkg}가 설치돼 있지 않다`, 'app_install로 먼저 설치해라', { pkg })
      }
      throw error
    }

    // 이 경로 아래를 재귀 삭제하므로, 앱 데이터 컨테이너가 확실할 때만 비운다.
    if (
      container.includes('\n') ||
      !isAbsolute(container) ||
      container === '/' ||
      !container.includes(DATA_CONTAINER_MARKER)
    ) {
      throw deviceError('command_failed', `앱 데이터 컨테이너 경로가 예상과 다르다: ${container}`, '시뮬레이터 상태를 확인해라', {
        path: container
      })
    }

    await emptyDirectory(container)
  }

  async function grantPermission(pkg: string, permission: string): Promise<void> {
    await simctl.exec(['privacy', udid, 'grant', permission, pkg])
  }

  const later = (action: string) => () => Promise.reject(unsupported('ios', action, 'M4-2에서 지원한다'))
  const logsLater = (action: string) => () => Promise.reject(unsupported('ios', action, 'M4-1 Task 7에서 구현한다'))

  return {
    serial: udid,
    platform: 'ios',
    info,
    screenshot,
    install,
    uninstall,
    launch,
    stop,
    clearData,
    grantPermission,
    tap: later('탭') as (x: number, y: number) => Promise<void>,
    swipe: later('스와이프') as Device['swipe'],
    inputText: later('텍스트 입력') as (text: string) => Promise<void>,
    pressKey: later('키 입력') as (key: KeyName) => Promise<void>,
    dumpUi: later('UI 덤프') as () => Promise<UiDump>,
    displayFrame: later('디스플레이 크기 읽기') as () => Promise<DisplayFrame>,
    readLogs: logsLater('로그 읽기') as () => Promise<LogReadResult>,
    clearLogs: logsLater('로그 지우기') as () => Promise<void>
  }
}
