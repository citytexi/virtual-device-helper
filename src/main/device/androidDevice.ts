import { existsSync } from 'node:fs'
import type { AdbClient } from '../adb/adbClient'
import { deviceError, isDeviceError } from '../../shared/types/errors'
import { DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT } from '../../shared/limits'
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

const SCREENSHOT_TIMEOUT_MS = 60_000
const DUMP_PATH = '/sdcard/window_dump.xml'

const KEYCODES: Record<KeyName, string> = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  enter: 'KEYCODE_ENTER',
  tab: 'KEYCODE_TAB'
}

/**
 * `input text`는 ASCII만 안전하게 보낼 수 있다. 공백은 %s로, 셸 메타문자는
 * 백슬래시로 이스케이프한다. ASCII 밖의 문자와 %는 조용히 깨뜨리는 대신 거부한다.
 */
function escapeInputText(text: string): string {
  if (!/^[\x20-\x7e]*$/.test(text)) {
    throw deviceError('command_failed', 'adb input text로는 ASCII 문자만 보낼 수 있다', '해당 문자는 클립보드 붙여넣기 등 다른 방법이 필요하다. M1 범위 밖이다', {
      text
    })
  }

  if (text.includes('%')) {
    throw deviceError('command_failed', 'adb input text로는 %를 포함한 문자열을 보낼 수 없다', '기기가 %s를 공백으로 되돌려 읽기 때문에 %가 섞인 문자열은 안전하게 보낼 방법이 없다. %를 뺀 다음 나눠서 보내거나 다른 방법을 써라', {
      text
    })
  }

  // 기기 셸은 mksh다. #은 단어 첫머리에서 주석을 열어 뒤를 통째로 삼키고, ~는 틸드
  // 확장, {}는 중괄호 확장을 부른다. 앞의 메타문자들과 같은 이유로 여기서 막는다.
  return text.replace(/(["#$&'()*;<>?\[\\\]`{|}~])/g, '\\$1').replace(/ /g, '%s')
}

/**
 * `pm install`이 기존 패키지와 충돌할 때 adb stderr에 남기는 실패 코드다. 이 둘은
 * 흔한 재현 경로(다른 키로 서명된 빌드를 그 위에 덮어쓰거나, versionCode를
 * 내려서 설치)가 있고 복구 경로도 같아서(`app_uninstall` 후 재설치) 여기서
 * 같이 다룬다. ToolErrorKind를 늘리지 않는다 — 공개 인터페이스 변경은 ADR-0004가
 * 관장한다. 대신 `kind: 'command_failed'`를 유지하고 message·hint·details.reason으로
 * 구분한다.
 */
const INSTALL_CONFLICT_REASONS = ['INSTALL_FAILED_UPDATE_INCOMPATIBLE', 'INSTALL_FAILED_VERSION_DOWNGRADE'] as const
type InstallConflictReason = (typeof INSTALL_CONFLICT_REASONS)[number]

const INSTALL_CONFLICT_HINT =
  'app_uninstall로 기존 앱을 지운 뒤 app_install을 다시 불러라. app_uninstall은 앱 데이터도 함께 지운다'

/** stderr에서 충돌한 패키지명을 뽑는다. 못 찾으면 null — 메시지는 패키지명 없이도 뜻이 통한다. */
function extractInstallConflictPackage(stderr: string): string | null {
  const match =
    /Existing package (\S+) signatures/.exec(stderr) ?? /[Pp]ackage (\S+) (?:new version|signatures)/.exec(stderr)
  return match ? (match[1] as string).replace(/[.,;:]+$/, '') : null
}

function installConflictMessage(reason: InstallConflictReason, pkg: string | null): string {
  if (reason === 'INSTALL_FAILED_UPDATE_INCOMPATIBLE') {
    return pkg
      ? `기기에 이미 설치된 ${pkg}가 다른 서명 키로 서명돼 있어 그 위에 덮어설치할 수 없다`
      : '기기에 이미 설치된 패키지가 다른 서명 키로 서명돼 있어 그 위에 덮어설치할 수 없다'
  }
  return pkg
    ? `설치하려는 APK의 versionCode가 기기에 이미 설치된 ${pkg}보다 낮아 다운그레이드로 설치할 수 없다`
    : '설치하려는 APK의 versionCode가 기기에 이미 설치된 버전보다 낮아 다운그레이드로 설치할 수 없다'
}

/**
 * adb install 실패를 다시 던진다. adbClient의 classify는 모든 adb 명령에 공통인
 * 실패(no_device 등)만 분류하고, INSTALL_FAILED_* 코드는 install에만 있는 의미라
 * 여기 Android 도메인 층에서 읽는다.
 */
function rethrowInstallFailure(error: unknown): never {
  if (isDeviceError(error) && error.toolError.kind === 'command_failed') {
    const stderr = typeof error.toolError.details?.stderr === 'string' ? error.toolError.details.stderr : ''
    const reason = INSTALL_CONFLICT_REASONS.find((candidate) => stderr.includes(candidate))
    if (reason) {
      const pkg = extractInstallConflictPackage(stderr)
      throw deviceError('command_failed', installConflictMessage(reason, pkg), INSTALL_CONFLICT_HINT, {
        reason,
        stderr
      })
    }
  }
  throw error
}

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

    // scale이 없으면 기기 해상도를 알 필요가 없다. 기본 경로에서 wm size 왕복을
    // 한 번 아낀다.
    let maxLongEdge = DEFAULT_MAX_LONG_EDGE
    if (opts.scale !== undefined) {
      const size = await screenSize()
      maxLongEdge = Math.round(Math.max(size.width, size.height) * opts.scale)
    }

    const captured = await adb.exec(serial, ['exec-out', 'screencap', '-p'], {
      timeoutMs: SCREENSHOT_TIMEOUT_MS
    })

    const resized = resizeImage(captured.stdoutRaw, maxLongEdge)

    return { base64: resized.png.toString('base64'), width: resized.width, height: resized.height }
  }

  async function dumpUi(): Promise<UiNode[]> {
    // uiautomator dump는 화면이 안정되지 않으면 "ERROR: could not get idle state."를
    // 내고 파일을 건드리지 않는다. 앞선 덤프가 그 자리에 남아 있으면 지난 화면의
    // 좌표가 지금 화면인 것처럼 돌아간다 — 틀린 성공은 UI를 조작하는 에이전트에게
    // 가장 나쁜 실패 모양이다. 그래서 먼저 지워서 읽을 수 있는 헌 덤프 자체를 없앤다.
    // 성공 메시지 문구로 판정하지 않는 이유는 그 문구가 Android 버전마다 다르기 때문이다.
    await shell(['rm', '-f', DUMP_PATH])
    const dumpOutput = await shell(['uiautomator', 'dump', DUMP_PATH])

    function dumpFailed(): never {
      throw deviceError('command_failed', 'UI 덤프를 뜨지 못했다', '화면 전환이나 애니메이션이 끝난 뒤 다시 불러라', {
        stdout: dumpOutput.trim()
      })
    }

    // uiautomator는 실패를 종료 코드가 아니라 stdout의 ERROR 줄로 말한다. 먼저 지웠더라도
    // 그 rm이 듣지 않는 기기가 있을 수 있어, 실패를 말한 덤프는 읽지 않고 여기서 끊는다.
    if (/^\s*ERROR\b/im.test(dumpOutput)) dumpFailed()

    const xml = (await adb.exec(serial, ['exec-out', 'cat', DUMP_PATH])).stdout
    if (!xml.includes('<hierarchy')) dumpFailed()

    // 화면 사각형은 덤프의 루트 노드 bounds에 들어 있다. wm size는 회전을 반영하지
    // 않아 가로 화면에서 틀린 답을 준다.
    return parseUiDump(xml)
  }

  async function readLogs(opts: LogOpts = {}): Promise<LogReadResult> {
    // 줄 수 기본값과 상한은 mcpTools 층(`observe.ts`)과 같은 값이라 shared의 `limits.ts`에
    // 있다. mcpTools를 거치지 않고 여기를 직접 부르는 경로(장차 M3의 renderer/IPC 경로,
    // 테스트)에도 같은 안전판이 걸리도록 이 층에서도 상한을 적용한다.
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

  async function install(apkPath: string, opts: InstallOpts = {}): Promise<string | null> {
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
    try {
      await adb.exec(serial, args, { timeoutMs: 180_000 })
    } catch (error) {
      rethrowInstallFailure(error)
    }

    const after = await listPackages()
    const added = after.filter((pkg) => !before.has(pkg))

    // 재설치면 목록이 그대로다. 설치 자체는 성공했으니 실패로 올리지 않되, 패키지명을
    // 알 수 없다는 사실은 null로 말한다. 빈 문자열은 그대로 app_launch에 흘러들어가
    // package_not_found가 되고, 이 브랜치의 다른 "모름"들도 모두 null이다.
    if (added.length === 1) return added[0] as string
    if (added.length === 0 && opts.reinstall) return null

    throw deviceError(
      'command_failed',
      '설치 후 패키지명을 특정하지 못했다',
      '패키지명을 알고 있다면 그 값을 그대로 app_launch에 넘겨 실행해라',
      { added }
    )
  }

  async function uninstall(pkg: string): Promise<void> {
    await requirePackage(pkg)
    await adb.exec(serial, ['uninstall', pkg])
  }

  /**
   * `monkey -p <pkg> -c android.intent.category.LAUNCHER 1`로 기본 액티비티를 찾던
   * 예전 방식은 API 36 실기기(emulator-5554)에서 exit 251로 죽어 항상 command_failed를
   * 냈다. `cmd package resolve-activity`는 같은 정보를 셸을 흉내 내지 않고 직접 준다.
   * 출력 마지막 줄 중 `/`가 든 줄이 컴포넌트다. 런처 액티비티가 없으면
   * "No activity found"만 오고 `/`가 든 줄이 없다.
   */
  async function resolveLauncherComponent(pkg: string): Promise<string> {
    const output = await shell([
      'cmd',
      'package',
      'resolve-activity',
      '--brief',
      '-c',
      'android.intent.category.LAUNCHER',
      pkg
    ])
    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const component = [...lines].reverse().find((line) => line.includes('/'))

    if (!component) {
      throw deviceError(
        'command_failed',
        `${pkg}에 런처 액티비티가 없다`,
        'app_launch를 부를 때 activity를 직접 지정해라',
        { pkg, stdout: output }
      )
    }

    return component
  }

  /**
   * am start 출력(성공 stdout이든 실패 stderr든)에서 "Error"로 시작하는 줄을 모두
   * 뽑는다. 관찰된 실패는 "Error type 3"와 "Error: Activity class ... does not
   * exist." 두 줄로 오는데, 뒤쪽이 실제 원인이라 둘 다 남겨 메시지에서 잘리지 않게 한다.
   */
  function findErrorLine(text: string): string | null {
    const lines = text.match(/^Error.*$/gm)
    return lines && lines.length > 0 ? lines.map((line) => line.trim()).join(' ') : null
  }

  /**
   * `am start`는 존재하지 않는 액티비티를 줘도 adb 자체는 종료 코드만으로 원인을
   * 말해 주지 않을 때가 있고(관찰: exit 1, stderr에 "Error type 3" / "Error: Activity
   * class ... does not exist."), 반대로 성공(exit 0)해 놓고 stdout에 같은 형태의
   * 경고를 남기는 경우도 있어 두 경로 모두 "Error"로 시작하는 줄을 찾는다.
   */
  async function startComponent(component: string): Promise<void> {
    let output: string

    try {
      const result = await adb.exec(serial, ['shell', 'am', 'start', '-n', component])
      output = [result.stdout, result.stderr].filter((chunk) => chunk.length > 0).join('\n')
    } catch (error) {
      if (isDeviceError(error) && error.toolError.kind === 'command_failed') {
        const stderr = typeof error.toolError.details?.stderr === 'string' ? error.toolError.details.stderr : ''
        const errorLine = findErrorLine(stderr)
        if (errorLine) {
          throw deviceError(
            'command_failed',
            `${component} 실행이 실패했다: ${errorLine}`,
            '액티비티 이름이 맞는지 확인하거나 activity를 직접 지정해서 app_launch를 다시 불러라',
            { component, stderr }
          )
        }
      }
      throw error
    }

    const errorLine = findErrorLine(output)
    if (errorLine) {
      throw deviceError(
        'command_failed',
        `${component} 실행이 실패했다: ${errorLine}`,
        '액티비티 이름이 맞는지 확인하거나 activity를 직접 지정해서 app_launch를 다시 불러라',
        { component, output }
      )
    }
  }

  async function launch(pkg: string, activity?: string): Promise<void> {
    await requirePackage(pkg)

    const component = activity ? `${pkg}/${activity}` : await resolveLauncherComponent(pkg)
    await startComponent(component)
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

  async function tap(x: number, y: number): Promise<void> {
    await shell(['input', 'tap', String(Math.round(x)), String(Math.round(y))])
  }

  async function swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number
  ): Promise<void> {
    if (durationMs <= 0) {
      throw deviceError('command_failed', `durationMs는 0보다 커야 한다: ${durationMs}`, '100에서 1000 사이 값을 써라')
    }

    await shell([
      'input',
      'swipe',
      String(Math.round(x1)),
      String(Math.round(y1)),
      String(Math.round(x2)),
      String(Math.round(y2)),
      String(Math.round(durationMs))
    ])
  }

  async function inputText(text: string): Promise<void> {
    await shell(['input', 'text', escapeInputText(text)])
  }

  async function pressKey(key: KeyName): Promise<void> {
    await shell(['input', 'keyevent', KEYCODES[key]])
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
    tap,
    swipe,
    inputText,
    pressKey
  }
}
