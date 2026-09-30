import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { readdir, readFile as fsReadFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SimctlClient } from '../ios/simctlClient'
import { DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT } from '../../shared/limits'
import { deviceError, isDeviceError, unsupported } from '../../shared/types/errors'
import type {
  Device,
  DeviceInfo,
  DisplayFrame,
  InstallOpts,
  KeyName,
  LogLine,
  LogOpts,
  LogReadResult,
  ScreenshotOpts,
  ScreenshotResult,
  UiDump
} from '../../shared/types/device'
import { assertValidScreenshotScale, DEFAULT_MAX_LONG_EDGE, scaledLongEdge } from './androidDevice'
import { formatLogShowStart, logFilterPredicate, parseIosLogLine, toLogShowStart } from './parsers/iosLog'
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
/** since도 워터마크도 없을 때 읽기 시작점: 최근 5분. */
const DEFAULT_LOG_WINDOW_MS = 300_000
const LOG_SHOW_TIMEOUT_MS = 60_000
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
    removeFile = (path: string) => rm(path, { force: true }),
    now = Date.now
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
      // code=4는 "열기 요청이 실패했다"는 일반 래퍼라 미설치 말고도 나온다(종료 중인 기기, 깨진 앱).
      // 앱 컨테이너가 실제로 없을 때만 package_not_found로 좁힌다.
      if (/not installed|found nothing|FBSOpenApplicationServiceErrorDomain, code=4/i.test(stderrOf(error))) {
        try {
          await simctl.exec(['get_app_container', udid, pkg])
        } catch (probe) {
          if (isDeviceError(probe) && probe.toolError.kind === 'command_failed') {
            throw deviceError('package_not_found', `시뮬레이터에 ${pkg}가 설치돼 있지 않다`, 'app_install로 먼저 설치해라', { pkg })
          }
          throw probe
        }
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

    // 시스템 앱(설정 등)은 데이터 컨테이너가 없어 simctl이 성공 코드와 함께 (null)을 준다.
    if (container === '(null)') throw unsupported('ios', '시스템 앱 데이터 지우기', '데이터 컨테이너가 없다')

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

  // iOS 통합 로그는 지울 수 없어서 clearLogs 시각만 적어 두고 다음 readLogs의 시작점으로 쓴다.
  let logWatermark: number | null = null

  async function readLogs(opts: LogOpts = {}): Promise<LogReadResult> {
    const limit = Math.min(opts.limit ?? DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT)
    const nowMs = now()
    const start = opts.since
      ? toLogShowStart(opts.since, nowMs)
      : formatLogShowStart(logWatermark ?? nowMs - DEFAULT_LOG_WINDOW_MS)

    // filter는 셸을 거치지 않고 --predicate 한 인자로 간다. 이스케이프는 logFilterPredicate가 한다.
    // pids는 정수만 predicate에 넣어 log show가 내보내는 양 자체를 줄인다. 아래 JS 필터가 최종 판정이다.
    const pidList = (opts.pids ?? []).filter((pid) => Number.isInteger(pid) && pid >= 0)
    const filterPredicate = opts.filter ? logFilterPredicate(opts.filter) : null
    const pidPredicate = pidList.length > 0 ? `processID IN {${pidList.join(', ')}}` : null
    const predicate = filterPredicate && pidPredicate ? `(${filterPredicate}) AND ${pidPredicate}` : (filterPredicate ?? pidPredicate)
    const args = ['spawn', udid, 'log', 'show', '--style', 'ndjson', '--start', start]
    if (predicate) args.push('--predicate', predicate)

    // --start는 초 단위라 워터마크 직전 1초 안의 줄이 딸려 온다. since가 없을 때는 epochMs로 정확히 걸러
    // clearLogs 이전 줄이 다시 나오지 않게 한다(Android `logcat -c`와 같은 의미).
    const cutoff = opts.since ? null : logWatermark
    // pid 필터는 줄 수 상한보다 먼저 건다(Android readLogs와 같다).
    const pids = opts.pids ? new Set(opts.pids) : null

    // 조용한 시뮬레이터도 5분 창에 수십만 줄이 나온다. 전체를 exec로 모으지 않고 줄 단위로 읽으며
    // 마지막 limit줄만 고리 버퍼에 남긴다.
    return new Promise<LogReadResult>((resolve, reject) => {
      const ring: LogLine[] = new Array(limit)
      let head = 0
      let size = 0
      let dropped = 0
      let settled = false

      const stream = simctl.stream(args)
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        stream.close()
        reject(
          deviceError('device_unresponsive', `simctl 명령이 ${LOG_SHOW_TIMEOUT_MS}ms 안에 끝나지 않았다: ${args.join(' ')}`, '시뮬레이터 상태를 확인하고 필요하면 device_shutdown 후 다시 부팅해라', {
            args,
            timeoutMs: LOG_SHOW_TIMEOUT_MS
          })
        )
      }, LOG_SHOW_TIMEOUT_MS)

      stream.onLine((raw) => {
        if (settled || !raw) return
        const parsed = parseIosLogLine(raw)
        if (!parsed || (cutoff !== null && parsed.epochMs < cutoff)) return
        const { epochMs: _epochMs, ...line } = parsed
        if (pids && !pids.has(line.pid)) return
        if (limit === 0) {
          dropped += 1
          return
        }
        if (size < limit) {
          ring[(head + size) % limit] = line
          size += 1
          return
        }
        ring[head] = line
        head = (head + 1) % limit
        dropped += 1
      })

      stream.onError((error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })

      stream.onClose(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const lines: LogLine[] = []
        for (let i = 0; i < size; i += 1) lines.push(ring[(head + i) % limit]!)
        resolve({ lines, truncated: dropped > 0, droppedCount: dropped })
      })
    })
  }

  async function clearLogs(): Promise<void> {
    logWatermark = now()
  }

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
    readLogs,
    clearLogs
  }
}
