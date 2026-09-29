// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { LogEntry } from '../../../shared/types/logs'
import type { LogRow, LogStream, LogStreamDeps } from '../hooks/useLogStream'
import { EMPTY_FILTER, compileFilter } from '../logs/logFilter'
import { LOG_ROW_HEIGHT, LogTab, createFilterCache, refreshFilter } from './LogTab'

function entry(seq: number, over: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: '09-28 12:34:56.789',
    level: 'I',
    tag: 'Tag',
    pid: 42,
    message: `line ${seq}`,
    seq,
    at: seq,
    ...over
  }
}

const line = (seq: number, over: Partial<LogEntry> = {}): LogRow => ({ kind: 'line', entry: entry(seq, over) })

function makeStream(rows: LogRow[], over: Partial<LogStream> = {}): LogStream {
  return { rows, start: 0, status: 'running', packages: [], caughtUp: true, version: 1, ...over }
}

const idleStream = makeStream([], { status: 'idle', caughtUp: false, version: 0 })

/** jsdom에는 레이아웃이 없어서 목록 컨테이너의 치수를 직접 정한다. */
function sizeList(height: number): HTMLElement {
  const list = screen.getByTestId('log-list')
  Object.defineProperty(list, 'clientHeight', { value: height, configurable: true })
  Object.defineProperty(list, 'scrollTop', { value: 0, writable: true, configurable: true })
  return list
}

function renderedRows(): HTMLElement[] {
  return [...screen.getByTestId('log-list').querySelectorAll<HTMLElement>('.log-row')]
}

describe('LogTab', () => {
  it('shows an empty hint when there is no device', () => {
    render(<LogTab serial={null} visible stream={idleStream} />)

    expect(screen.getByText('활성 기기가 없다. 기기를 고르면 로그가 여기 흐른다.')).toBeDefined()
  })

  it('renders only the visible window of a long list', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => line(i))
    render(<LogTab serial="emulator-5554" visible stream={makeStream(rows)} />)
    const list = sizeList(200)

    // 위쪽 어딘가로 스크롤한다.
    list.scrollTop = 5000 * LOG_ROW_HEIGHT
    fireEvent.scroll(list)

    const shown = renderedRows()
    expect(shown.length).toBeLessThanOrEqual(200 / LOG_ROW_HEIGHT + 2 * 10)
    expect(shown.some((row) => row.textContent?.includes('line 5000'))).toBe(true)
    const spacer = list.firstElementChild as HTMLElement
    expect(spacer.style.height).toBe(`${10_000 * LOG_ROW_HEIGHT}px`)
    const first = shown[0] as HTMLElement
    expect(first.style.top).toBe(`${(5000 - 10) * LOG_ROW_HEIGHT}px`)
  })

  it('shows the time as HH:mm:ss.SSS with the level, tag and message', () => {
    render(<LogTab serial="emulator-5554" visible stream={makeStream([line(0, { level: 'E', tag: 'Boom' })])} />)

    const row = renderedRows()[0] as HTMLElement
    expect(row.getAttribute('data-level')).toBe('E')
    expect(within(row).getByText('12:34:56.789')).toBeDefined()
    expect(within(row).getByText('E')).toBeDefined()
    expect(within(row).getByText('Boom')).toBeDefined()
    expect(within(row).getByText('line 0')).toBeDefined()
  })

  it('follows new lines at the bottom and stops when scrolled up', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => line(i))
    const { rerender } = render(<LogTab serial="emulator-5554" visible stream={makeStream(rows, { version: 1 })} />)
    const list = sizeList(200)

    // 새 batch: 같은 버퍼 배열에 붙고 version만 오른다.
    rows.push(line(100), line(101))
    rerender(<LogTab serial="emulator-5554" visible stream={makeStream(rows, { version: 2 })} />)
    expect(list.scrollTop).toBe(102 * LOG_ROW_HEIGHT - 200)
    expect(screen.queryByRole('button', { name: '맨 아래로' })).toBeNull()

    // 사용자가 위로 스크롤한다.
    list.scrollTop = 100
    fireEvent.scroll(list)
    rows.push(line(102))
    rerender(<LogTab serial="emulator-5554" visible stream={makeStream(rows, { version: 3 })} />)
    expect(list.scrollTop).toBe(100)

    await userEvent.click(screen.getByRole('button', { name: '맨 아래로' }))
    expect(list.scrollTop).toBe(103 * LOG_ROW_HEIGHT - 200)
    expect(screen.queryByRole('button', { name: '맨 아래로' })).toBeNull()

    rows.push(line(103))
    rerender(<LogTab serial="emulator-5554" visible stream={makeStream(rows, { version: 4 })} />)
    expect(list.scrollTop).toBe(104 * LOG_ROW_HEIGHT - 200)
  })

  it('stops following on a wheel up even before the scroll event arrives', () => {
    const rows = Array.from({ length: 100 }, (_, i) => line(i))
    const { rerender } = render(<LogTab serial="emulator-5554" visible stream={makeStream(rows, { version: 1 })} />)
    const list = sizeList(200)
    rows.push(line(100))
    rerender(<LogTab serial="emulator-5554" visible stream={makeStream(rows, { version: 2 })} />)
    const bottom = 101 * LOG_ROW_HEIGHT - 200
    expect(list.scrollTop).toBe(bottom)

    // 휠을 올렸다. scroll 이벤트는 아직 안 왔고, 그 사이 batch가 렌더된다.
    fireEvent.wheel(list, { deltaY: -40 })
    list.scrollTop = bottom - 40
    rows.push(line(101))
    rerender(<LogTab serial="emulator-5554" visible stream={makeStream(rows, { version: 3 })} />)

    expect(list.scrollTop).toBe(bottom - 40)
    expect(screen.getByRole('button', { name: '맨 아래로' })).toBeDefined()
  })

  it('keeps following on a wheel up when the list does not overflow', () => {
    const rows = [line(0), line(1)]
    const { rerender } = render(<LogTab serial="emulator-5554" visible stream={makeStream(rows, { version: 1 })} />)
    const list = sizeList(200)

    // 줄이 몇 개 안 돼 스크롤할 곳이 없다 — scroll 이벤트도 오지 않는다.
    fireEvent.wheel(list, { deltaY: -40 })
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    rows.push(line(2))
    rerender(<LogTab serial="emulator-5554" visible stream={makeStream(rows, { version: 2 })} />)

    expect(screen.queryByRole('button', { name: '맨 아래로' })).toBeNull()
  })

  it('keeps following after pressing and releasing the scrollbar at the bottom', () => {
    const rows = Array.from({ length: 100 }, (_, i) => line(i))
    const { rerender } = render(<LogTab serial="emulator-5554" visible stream={makeStream(rows, { version: 1 })} />)
    const list = sizeList(200)
    rows.push(line(100))
    rerender(<LogTab serial="emulator-5554" visible stream={makeStream(rows, { version: 2 })} />)
    expect(list.scrollTop).toBe(101 * LOG_ROW_HEIGHT - 200)

    // 스크롤바를 눌렀다 끌지 않고 놓는다.
    fireEvent.pointerDown(list)
    fireEvent.pointerUp(window)
    rows.push(line(101))
    rerender(<LogTab serial="emulator-5554" visible stream={makeStream(rows, { version: 3 })} />)

    expect(screen.queryByRole('button', { name: '맨 아래로' })).toBeNull()
    expect(list.scrollTop).toBe(102 * LOG_ROW_HEIGHT - 200)
  })

  it('treats a position above the last auto scroll as a user scroll when a batch lands first', () => {
    const rows = Array.from({ length: 100 }, (_, i) => line(i))
    const { rerender } = render(<LogTab serial="emulator-5554" visible stream={makeStream(rows, { version: 1 })} />)
    const list = sizeList(200)
    rows.push(line(100))
    rerender(<LogTab serial="emulator-5554" visible stream={makeStream(rows, { version: 2 })} />)

    // 스크롤바를 끌어 올렸지만 scroll 이벤트가 한 프레임 늦다.
    list.scrollTop = 300
    rows.push(line(101))
    rerender(<LogTab serial="emulator-5554" visible stream={makeStream(rows, { version: 3 })} />)

    expect(list.scrollTop).toBe(300)
    expect(screen.getByRole('button', { name: '맨 아래로' })).toBeDefined()
  })

  it('restores the reading place when the tab is shown again while not following', () => {
    const rows = Array.from({ length: 100 }, (_, i) => line(i))
    const stream = makeStream(rows)
    const { rerender } = render(<LogTab serial="emulator-5554" visible stream={stream} />)
    const list = sizeList(200)
    list.scrollTop = 600
    fireEvent.scroll(list)
    expect(screen.getByRole('button', { name: '맨 아래로' })).toBeDefined()

    rerender(<LogTab serial="emulator-5554" visible={false} stream={stream} />)
    // display: none이 스크롤 위치를 버린다.
    list.scrollTop = 0
    rerender(<LogTab serial="emulator-5554" visible stream={stream} />)

    expect(list.scrollTop).toBe(600)
    expect(renderedRows().some((row) => row.textContent?.includes('line 30'))).toBe(true)
  })

  it('keeps showing the received rows with the stopped banner after the device goes away', () => {
    render(<LogTab serial={null} visible stream={makeStream([line(0), line(1)], { status: 'stopped' })} />)

    expect(screen.queryByText('활성 기기가 없다. 기기를 고르면 로그가 여기 흐른다.')).toBeNull()
    expect(renderedRows()).toHaveLength(2)
    expect(screen.getByRole('status').textContent).toContain('로그 수집이 멈췄다')
  })

  it('never opens logs through the real hook without a serial', () => {
    const deps: LogStreamDeps = {
      openLogs: vi.fn(async () => ({ ok: true as const, value: undefined })),
      closeLogs: vi.fn(async () => ({ ok: true as const, value: undefined })),
      onLogPort: vi.fn(() => () => {})
    }

    render(<LogTab serial={null} visible deps={deps} />)

    expect(deps.openLogs).not.toHaveBeenCalled()
    expect(screen.getByText('활성 기기가 없다. 기기를 고르면 로그가 여기 흐른다.')).toBeDefined()
  })

  it('resets selection and following when a new session starts', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => line(i))
    const { rerender } = render(<LogTab serial="emulator-5554" visible stream={makeStream(rows)} />)
    const list = sizeList(200)
    await userEvent.click(renderedRows()[0] as HTMLElement)
    list.scrollTop = 0
    fireEvent.scroll(list)
    expect(screen.getByRole('button', { name: '맨 아래로' })).toBeDefined()

    // 새 포트 = 새 버퍼 배열.
    rerender(<LogTab serial="emulator-5554" visible stream={makeStream([line(0, { message: 'fresh' })], { version: 5 })} />)

    expect(screen.queryByRole('region', { name: '로그 상세' })).toBeNull()
    expect(screen.queryByRole('button', { name: '맨 아래로' })).toBeNull()
  })

  it('shows the full message of the clicked row in the detail area', async () => {
    const long = 'x'.repeat(300) + ' the end'
    render(
      <LogTab
        serial="emulator-5554"
        visible
        stream={makeStream([line(0), line(1, { message: long, tag: 'Detail', level: 'W', pid: 7 })])}
      />
    )

    await userEvent.click(renderedRows()[1] as HTMLElement)

    const detail = screen.getByRole('region', { name: '로그 상세' })
    expect(within(detail).getByText(long)).toBeDefined()
    expect(detail.textContent).toContain('Detail')
    expect(detail.textContent).toContain('pid 7')
    expect(renderedRows()[1]?.getAttribute('aria-current')).toBe('true')
  })

  it('shows a reconnecting banner', () => {
    render(<LogTab serial="emulator-5554" visible stream={makeStream([], { status: 'reconnecting' })} />)

    expect(within(screen.getByRole('status')).getByText('로그 연결을 다시 잇는 중이다')).toBeDefined()
  })

  it('renders a gap row as 밀려난 구간', () => {
    render(
      <LogTab
        serial="emulator-5554"
        visible
        stream={makeStream([line(0), { kind: 'gap', fromSeq: 1, toSeq: 9 }, line(10)])}
      />
    )

    const gapRow = renderedRows()[1] as HTMLElement
    expect(gapRow.textContent).toContain('밀려난 구간')
  })

  it('marks rows inside the highlight window', () => {
    render(
      <LogTab
        serial="emulator-5554"
        visible
        stream={makeStream([line(0), line(1), line(2)])}
        highlight={{ fromAt: 1, toAt: 1 }}
      />
    )

    expect(renderedRows().map((row) => row.hasAttribute('data-highlight'))).toEqual([false, true, false])
  })

  it('applies a jump only when visible and caughtUp', () => {
    const rows = Array.from({ length: 100 }, (_, i) => line(i))
    const onJumpDone = vi.fn()
    const jump = { id: 'c1', at: 30, highlight: { fromAt: 30, toAt: 32 } }
    const hidden = makeStream(rows, { caughtUp: false })
    const { rerender } = render(<LogTab serial="emulator-5554" visible={false} stream={hidden} />)
    const list = sizeList(200)

    // 숨겨진 채로 점프를 받는다 — 아직 resume 전이라 적용하지 않는다.
    rerender(<LogTab serial="emulator-5554" visible={false} stream={hidden} jump={jump} onJumpDone={onJumpDone} />)
    expect(onJumpDone).not.toHaveBeenCalled()

    // 보이게 됐지만 resumed가 아직 오지 않았다 — 여전히 맨 아래를 따라간다.
    rerender(<LogTab serial="emulator-5554" visible stream={hidden} jump={jump} onJumpDone={onJumpDone} />)
    expect(onJumpDone).not.toHaveBeenCalled()
    expect(list.scrollTop).toBe(100 * LOG_ROW_HEIGHT - 200)

    // resumed로 따라잡았다 — 이제 점프한다.
    rerender(
      <LogTab
        serial="emulator-5554"
        visible
        stream={makeStream(rows, { caughtUp: true, version: 2 })}
        jump={jump}
        onJumpDone={onJumpDone}
      />
    )
    expect(onJumpDone).toHaveBeenCalledWith('c1', 'ok')
    expect(list.scrollTop).toBe(30 * LOG_ROW_HEIGHT)
    expect(screen.getByRole('button', { name: '맨 아래로' })).toBeDefined()
    const lit = renderedRows()
      .filter((row) => row.hasAttribute('data-highlight'))
      .map((row) => row.textContent)
    expect(lit).toEqual([
      expect.stringContaining('line 30'),
      expect.stringContaining('line 31'),
      expect.stringContaining('line 32')
    ])
  })

  it('jumps to the first visible row after the time when filters hide the exact row', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => line(i, { tag: i === 30 ? 'B' : 'A' }))
    const stream = makeStream(rows)
    const onJumpDone = vi.fn()
    const { rerender } = render(<LogTab serial="emulator-5554" visible stream={stream} />)
    const list = sizeList(200)
    await userEvent.click(screen.getByRole('button', { name: 'A' }))

    rerender(
      <LogTab
        serial="emulator-5554"
        visible
        stream={stream}
        jump={{ id: 'c1', at: 30, highlight: { fromAt: 30, toAt: 30 } }}
        onJumpDone={onJumpDone}
      />
    )

    // 걸러진 목록에서 line 31이 index 30이다.
    expect(onJumpDone).toHaveBeenCalledWith('c1', 'ok')
    expect(list.scrollTop).toBe(30 * LOG_ROW_HEIGHT)
    expect(renderedRows().some((row) => row.textContent?.includes('line 31'))).toBe(true)
    expect(renderedRows().some((row) => row.textContent?.includes('line 30'))).toBe(false)
  })

  it('shows 로그 버퍼에서 밀려난 구간이다 when the jump is evicted', () => {
    const rows = Array.from({ length: 10 }, (_, i) => line(100 + i))
    const onJumpDone = vi.fn()
    render(
      <LogTab
        serial="emulator-5554"
        visible
        stream={makeStream(rows)}
        jump={{ id: 'c1', at: 50, highlight: { fromAt: 52, toAt: 60 } }}
        onJumpDone={onJumpDone}
      />
    )

    expect(onJumpDone).toHaveBeenCalledWith('c1', 'evicted')
    expect(within(screen.getByRole('status')).getByText('로그 버퍼에서 밀려난 구간이다')).toBeDefined()
  })

  it('applies the same jump id only once', () => {
    const rows = Array.from({ length: 100 }, (_, i) => line(i))
    const onJumpDone = vi.fn()
    const { rerender } = render(<LogTab serial="emulator-5554" visible stream={makeStream(rows)} />)
    const list = sizeList(200)
    rerender(
      <LogTab
        serial="emulator-5554"
        visible
        stream={makeStream(rows, { version: 2 })}
        jump={{ id: 'c1', at: 30, highlight: { fromAt: 30, toAt: 30 } }}
        onJumpDone={onJumpDone}
      />
    )
    expect(list.scrollTop).toBe(30 * LOG_ROW_HEIGHT)

    // 사용자가 다른 곳으로 옮긴 뒤 같은 id의 점프가 새 객체로 다시 온다.
    list.scrollTop = 0
    fireEvent.scroll(list)
    rows.push(line(100))
    rerender(
      <LogTab
        serial="emulator-5554"
        visible
        stream={makeStream(rows, { version: 3 })}
        jump={{ id: 'c1', at: 30, highlight: { fromAt: 30, toAt: 30 } }}
        onJumpDone={onJumpDone}
      />
    )

    expect(list.scrollTop).toBe(0)
    expect(onJumpDone).toHaveBeenCalledTimes(1)
  })

  it('applies filters to the whole buffer and offers top tags as chips', async () => {
    render(
      <LogTab
        serial="emulator-5554"
        visible
        stream={makeStream([line(0, { tag: 'A' }), line(1, { tag: 'B' }), line(2, { tag: 'A', level: 'E' })])}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'A' }))
    expect(renderedRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('line 0'),
      expect.stringContaining('line 2')
    ])

    await userEvent.selectOptions(screen.getByRole('combobox', { name: '최소 레벨' }), 'E')
    expect(renderedRows()).toHaveLength(1)
  })

  it('gives the same rows under StrictMode', () => {
    const rows = [line(0), line(1)]
    const { rerender } = render(
      <StrictMode>
        <LogTab serial="emulator-5554" visible stream={makeStream(rows, { version: 1 })} />
      </StrictMode>
    )
    rows.push(line(2))
    act(() => {
      rerender(
        <StrictMode>
          <LogTab serial="emulator-5554" visible stream={makeStream(rows, { version: 2 })} />
        </StrictMode>
      )
    })

    expect(renderedRows()).toHaveLength(3)
  })
})

describe('refreshFilter', () => {
  const all = compileFilter(EMPTY_FILTER)

  it('appends only rows after the processed seq and is idempotent', () => {
    const cache = createFilterCache()
    const rows = [line(0), line(1)]
    refreshFilter(cache, rows, 0, all)
    rows.push(line(2))
    refreshFilter(cache, rows, 0, all)
    refreshFilter(cache, rows, 0, all)

    expect(cache.result.map((r) => (r.kind === 'line' ? r.entry.seq : -1))).toEqual([0, 1, 2])
    expect(cache.processedUpToSeq).toBe(2)
  })

  it('drops trimmed rows and the gap before them from the front', () => {
    const cache = createFilterCache()
    const rows: LogRow[] = [line(0), { kind: 'gap', fromSeq: 1, toSeq: 4 }, line(5), line(6)]
    refreshFilter(cache, rows, 0, all)
    const epoch = cache.epoch

    // 버퍼 앞 3행(줄·gap·줄)이 밀려났다.
    rows.push(line(7))
    refreshFilter(cache, rows, 3, all)

    expect(cache.result.map((r) => (r.kind === 'line' ? r.entry.seq : -1))).toEqual([6, 7])
    expect(cache.epoch).toBe(epoch)
    expect(cache.dropped).toBe(3)
  })

  it('recomputes from scratch when the filter changes or the buffer was cleared', () => {
    const cache = createFilterCache()
    const rows = [line(0, { level: 'D' }), line(1, { level: 'E' })]
    refreshFilter(cache, rows, 0, all)
    const epoch = cache.epoch

    refreshFilter(cache, rows, 0, compileFilter({ ...EMPTY_FILTER, minLevel: 'E' }))
    expect(cache.result).toHaveLength(1)
    expect(cache.epoch).toBe(epoch + 1)

    // 새 세션: 새 배열, seq는 0부터.
    const fresh = [line(0, { level: 'E', message: 'new' })]
    const key = compileFilter(EMPTY_FILTER)
    refreshFilter(cache, fresh, 0, key)
    expect(cache.result.map((r) => (r.kind === 'line' ? r.entry.message : ''))).toEqual(['new'])
  })
})
