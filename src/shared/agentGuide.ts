import type { ServerStatus } from './types/ipc'

/**
 * 에이전트에게 보여 주는 안내 문구의 단일 출처. main은 serverInstructions를 MCP
 * instructions로, renderer는 나머지를 에이전트 탭에서 쓴다. README는 사람이 쓰지만
 * 툴 이름은 main 쪽 guideConsistency 테스트가 이 문구·README와 대조한다.
 *
 * 프롬프트와 instructions에는 토큰·URL을 넣지 않는다. 대화 기록은 남고 공유되기도
 * 한다. 연결 정보는 claudeCodeCommand 하나에만 들어간다.
 */

export const MCP_SERVER_NAME = 'virtual-device-helper'

export const CLAUDE_CODE_REMOVE_COMMAND = `claude mcp remove ${MCP_SERVER_NAME}`

export type PromptTemplateId = 'smoke' | 'scenario' | 'bug-repro'

export interface PromptTemplate {
  id: PromptTemplateId
  label: string
  description: string
  body: string
}

const RULES = [
  '대상 기기가 불분명하면 `device_list`로 확인하고 `device_select`로 고른다.',
  '좌표를 추측하지 않는다. `ui_find`로 요소를 찾고, 돌려받은 x, y로 `ui_tap`을 부른다.',
  '조작한 뒤에는 `screenshot` 또는 `ui_find`로 결과를 확인하고 나서 다음 단계로 간다.',
  '실패하거나 앱이 죽은 것 같으면 `log_read`로 로그를 본다. 새 시도 전에 `log_clear`를 부르면 그 뒤 로그만 보인다.',
  '깨끗한 상태에서 다시 시작하려면 `app_reset_and_launch`를 쓴다.',
  '에러 응답의 `hint`를 읽고 그대로 복구를 시도한다. 같은 `kind`의 에러가 되풀이되면 멈추고 보고한다.'
]

export function serverInstructions(): string {
  return [
    `${MCP_SERVER_NAME}는 Android 에뮬레이터를 조작하는 MCP 서버다. 다음 규칙을 지켜라.`,
    ...RULES.map((rule) => `- ${rule}`)
  ].join('\n')
}

function deviceSection(targetSerial: string | null): string {
  const line = targetSerial
    ? `대상 기기는 \`${targetSerial}\`이다. 툴을 부를 때 serial로 이 값을 넘겨라.`
    : '대상 기기가 아직 정해지지 않았다. `device_list`로 실행 중인 기기를 확인하고 `device_select`로 골라라.'
  return ['## 기기', line].join('\n')
}

const APP_SECTION = [
  '## 앱',
  '- 패키지명: <패키지명>',
  '- APK 경로: <APK 경로>',
  '모르면 이 프로젝트에서 찾아라(예: build.gradle의 `applicationId`, 빌드 산출물 경로). APK가 없으면 디버그 빌드부터 만든다.'
].join('\n')

const RULES_SECTION = ['## 규칙', ...RULES.map((rule) => `- ${rule}`)].join('\n')

function reportSection(extra: string[]): string {
  return [
    '## 보고',
    '- 단계마다 성공/실패',
    '- 실패한 단계에서 찍은 스크린샷이 있는지',
    '- 관련 로그 발췌(`log_read`)',
    ...extra.map((line) => `- ${line}`)
  ].join('\n')
}

function body(intro: string, targetSerial: string | null, sections: string[]): string {
  return [intro, deviceSection(targetSerial), APP_SECTION, ...sections, RULES_SECTION].join('\n\n')
}

export function promptTemplates(targetSerial: string | null): PromptTemplate[] {
  return [
    {
      id: 'smoke',
      label: '스모크 테스트',
      description: '설치하고 실행했을 때 죽지 않는지만 빠르게 본다.',
      body: body('virtual-device-helper MCP로 이 프로젝트의 Android 앱을 스모크 테스트해라.', targetSerial, [
        [
          '## 할 일',
          '1. `log_clear`로 로그를 비운다.',
          '2. `app_install`로 APK를 설치한다.',
          '3. `app_launch`로 실행한다.',
          '4. `screenshot`으로 첫 화면을 확인한다.',
          '5. `log_read`로 크래시(FATAL EXCEPTION)나 ANR이 있는지 본다.'
        ].join('\n'),
        reportSection([])
      ])
    },
    {
      id: 'scenario',
      label: '시나리오 E2E',
      description: '적어 둔 사용자 시나리오를 단계마다 확인하며 끝까지 수행한다.',
      body: body('virtual-device-helper MCP로 이 프로젝트의 Android 앱에서 아래 시나리오를 수행하고 검증해라.', targetSerial, [
        ['## 시나리오', '<시나리오>', '(한 줄에 한 단계씩, 단계마다 기대 결과를 적는다)'].join('\n'),
        [
          '## 할 일',
          '1. `app_install`로 APK를 설치한다.',
          '2. `log_clear`로 로그를 비운다.',
          '3. `app_reset_and_launch`로 깨끗한 상태에서 실행한다.',
          '4. 시나리오의 단계마다 `ui_find`로 요소를 찾고, `ui_tap`·`ui_text`·`ui_swipe`·`ui_key`로 조작하고, `screenshot` 또는 `ui_find`로 기대 결과를 확인한다.',
          '5. 기대와 다르면 그 단계에서 멈추고 `screenshot`과 `log_read`로 증거를 모은다.'
        ].join('\n'),
        reportSection(['멈춘 단계와 기대 결과, 실제 결과'])
      ])
    },
    {
      id: 'bug-repro',
      label: '버그 재현',
      description: '증상을 재현하고 스크린샷과 로그를 모은다.',
      body: body('virtual-device-helper MCP로 이 프로젝트의 Android 앱에서 아래 버그를 재현해라.', targetSerial, [
        ['## 버그', '- 증상: <증상>', '- 재현 단계: <재현 단계(모르면 비워 둔다)>'].join('\n'),
        [
          '## 할 일',
          '1. `app_install`로 APK를 설치한다.',
          '2. `log_clear`로 로그를 비운다.',
          '3. `app_reset_and_launch`로 깨끗한 상태에서 실행한다.',
          '4. 재현 단계를 따라 한다. 단계가 비어 있으면 증상에서 추측한 경로를 시도한다.',
          '5. 재현되면 `screenshot`과 `log_read`로 증거를 모은다.'
        ].join('\n'),
        reportSection(['재현 여부', '재현되지 않았으면 시도한 경로 목록'])
      ])
    }
  ]
}

function command(server: ServerStatus, token: string): string {
  return `claude mcp add --transport http ${MCP_SERVER_NAME} ${server.url} --header "Authorization: Bearer ${token}"`
}

/** 복사 전용이다. 화면에는 claudeCodeCommandMasked를 보여 준다. */
export function claudeCodeCommand(server: ServerStatus): string {
  return command(server, server.token)
}

export function claudeCodeCommandMasked(server: ServerStatus): string {
  return command(server, '••••••••')
}
