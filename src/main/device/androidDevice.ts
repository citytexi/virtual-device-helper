import { existsSync } from 'node:fs'
import type { AdbClient } from '../adb/adbClient'
import { deviceError } from '../../shared/types/errors'
import type {
  Device,
  DeviceInfo,
  InstallOpts,
  KeyName,
  LogOpts,
  LogReadResult,
  ScreenshotOpts,
  ScreenshotResult,
  UiNode
} from '../../shared/types/device'
import { parseLogcat } from './parsers/logcat'
import { parseUiDump } from './parsers/uiDump'
import type { ResizeImage } from './resizeImage'

/** 스크린샷 기본 축소 기준. 원본이 필요한 쪽은 사람이고, 사람은 앱 화면으로 본다. */
export const DEFAULT_MAX_LONG_EDGE = 720
export const DEFAULT_LOG_LIMIT = 200
/** 인자로도 넘을 수 없는 상한. 툴 하나가 에이전트의 문맥을 통째로 먹는 것을 막는다. */
export const MAX_LOG_LIMIT = 2000

const SCREENSHOT_TIMEOUT_MS = 60_000
const DUMP_PATH = '/sdcard/window_dump.xml'

export interface AndroidDeviceDeps {
  serial: string
  adb: AdbClient
  resizeImage: ResizeImage
  /** APK 경로 검사용. 기본값은 node:fs의 existsSync. */
  fileExists?: (path: string) => boolean
}

function parseWmSize(stdout: string): { width: number; height: number } {
  const override = /Override size:\s*(\d+)x(\d+)/.exec(stdout)
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(stdout)
  const match = override ?? physical

  if (!match) {
    throw deviceError('command_failed', 'wm size 출력에서 화면 크기를 읽지 못했다', '기기가 완전히 부팅됐는지 확인해라', {
      stdout
    })
  }

  return { width: Number(match[1]), height: Number(match[2]) }
}

export function createAndroidDevice(deps: AndroidDeviceDeps): Device {
  const { serial, adb, resizeImage, fileExists = existsSync } = deps

  async function shell(args: string[], timeoutMs?: number): Promise<string> {
    const result = await adb.exec(serial, ['shell', ...args], timeoutMs ? { timeoutMs } : undefined)
    return result.stdout
  }

  async function getprop(name: string): Promise<string> {
    return (await shell(['getprop', name])).trim()
  }

  async function screenSize(): Promise<{ width: number; height: number }> {
    return parseWmSize(await shell(['wm', 'size']))
  }

  async function info(): Promise<DeviceInfo> {
    const [model, sdk, size] = await Promise.all([
      getprop('ro.product.model'),
      getprop('ro.build.version.sdk'),
      screenSize()
    ])

    return { serial, model, apiLevel: Number(sdk), width: size.width, height: size.height }
  }

  async function screenshot(opts: ScreenshotOpts = {}): Promise<ScreenshotResult> {
    if (opts.scale !== undefined && (opts.scale <= 0 || opts.scale > 1)) {
      throw deviceError('command_failed', `scale은 0보다 크고 1 이하여야 한다: ${opts.scale}`, '0.1에서 1.0 사이 값을 써라')
    }

    const size = await screenSize()
    const longEdge = Math.max(size.width, size.height)
    const maxLongEdge =
      opts.scale === undefined ? DEFAULT_MAX_LONG_EDGE : Math.round(longEdge * opts.scale)

    const captured = await adb.exec(serial, ['exec-out', 'screencap', '-p'], {
      timeoutMs: SCREENSHOT_TIMEOUT_MS
    })

    const resized = resizeImage(captured.stdoutRaw, maxLongEdge)

    return { base64: resized.png.toString('base64'), width: resized.width, height: resized.height }
  }

  async function dumpUi(): Promise<UiNode[]> {
    const size = await screenSize()
    await shell(['uiautomator', 'dump', DUMP_PATH])
    const xml = (await adb.exec(serial, ['exec-out', 'cat', DUMP_PATH])).stdout

    return parseUiDump(xml, { screenWidth: size.width, screenHeight: size.height })
  }

  async function readLogs(opts: LogOpts = {}): Promise<LogReadResult> {
    const limit = Math.min(opts.limit ?? DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT)

    const args = ['logcat', '-d', '-v', 'threadtime']
    if (opts.since) args.push('-T', opts.since)

    const stdout = (await adb.exec(serial, args)).stdout
    let lines = parseLogcat(stdout)

    if (opts.filter) {
      const needle = opts.filter.toLowerCase()
      lines = lines.filter(
        (line) =>
          line.tag.toLowerCase().includes(needle) || line.message.toLowerCase().includes(needle)
      )
    }

    if (lines.length <= limit) {
      return { lines, truncated: false, droppedCount: 0 }
    }

    // 최신 쪽이 쓸모 있다. 앞에서 자른다.
    return {
      lines: lines.slice(lines.length - limit),
      truncated: true,
      droppedCount: lines.length - limit
    }
  }

  async function clearLogs(): Promise<void> {
    await adb.exec(serial, ['logcat', '-c'])
  }

  async function listPackages(): Promise<string[]> {
    const stdout = await shell(['pm', 'list', 'packages'])
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('package:'))
      .map((line) => line.slice('package:'.length))
  }

  async function requirePackage(pkg: string): Promise<void> {
    const packages = await listPackages()
    if (packages.includes(pkg)) return

    throw deviceError('package_not_found', `기기에 ${pkg}가 설치돼 있지 않다`, 'app_install로 먼저 설치해라', {
      pkg
    })
  }

  async function install(apkPath: string, opts: InstallOpts = {}): Promise<string> {
    if (!apkPath.endsWith('.apk')) {
      throw deviceError('apk_path_invalid', `APK 파일이 아니다: ${apkPath}`, '.apk 파일 경로를 줘라', { apkPath })
    }
    if (!fileExists(apkPath)) {
      throw deviceError('apk_path_invalid', `파일이 없다: ${apkPath}`, '경로를 확인해라. 상대 경로면 절대 경로로 바꿔라', {
        apkPath
      })
    }

    const before = new Set(await listPackages())

    const args = ['install']
    if (opts.reinstall) args.push('-r')
    args.push(apkPath)
    await adb.exec(serial, args, { timeoutMs: 180_000 })

    const after = await listPackages()
    const added = after.filter((pkg) => !before.has(pkg))

    // 재설치면 목록이 그대로다. 그때는 이름을 알 방법이 없으므로 빈 문자열 대신 명시적으로 알린다.
    if (added.length === 1) return added[0] as string
    if (added.length === 0 && opts.reinstall) return ''

    throw deviceError('command_failed', '설치 후 패키지명을 특정하지 못했다', 'app_list 대신 패키지명을 직접 지정해 실행해라', {
      added
    })
  }

  async function uninstall(pkg: string): Promise<void> {
    await requirePackage(pkg)
    await adb.exec(serial, ['uninstall', pkg])
  }

  async function launch(pkg: string, activity?: string): Promise<void> {
    await requirePackage(pkg)

    if (activity) {
      const component = `${pkg}/${activity}`
      await shell(['am', 'start', '-n', component])
      return
    }

    // 런처 인텐트를 모를 때 monkey가 기본 액티비티를 대신 찾아 준다.
    await shell(['monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'])
  }

  async function stop(pkg: string): Promise<void> {
    await shell(['am', 'force-stop', pkg])
  }

  async function clearData(pkg: string): Promise<void> {
    await requirePackage(pkg)
    await shell(['pm', 'clear', pkg])
  }

  async function grantPermission(pkg: string, permission: string): Promise<void> {
    await requirePackage(pkg)
    await shell(['pm', 'grant', pkg, permission])
  }

  return {
    serial,
    info,
    screenshot,
    dumpUi,
    readLogs,
    clearLogs,
    install,
    uninstall,
    launch,
    stop,
    clearData,
    grantPermission,
    // UI 조작은 Task 6에서 채운다.
    tap: () => Promise.reject(new Error('tap is implemented in a later task')),
    swipe: () => Promise.reject(new Error('swipe is implemented in a later task')),
    inputText: () => Promise.reject(new Error('inputText is implemented in a later task')),
    pressKey: () => Promise.reject(new Error('pressKey is implemented in a later task'))
  }
}
