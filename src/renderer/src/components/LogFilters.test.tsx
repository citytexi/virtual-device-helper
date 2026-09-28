// @vitest-environment jsdom
import { useState } from 'react'
import type { JSX } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_FILTER, type LogFilter } from '../logs/logFilter'
import { LogFilters } from './LogFilters'

function Controlled({ tags = ['ActivityManager'], packages = [] as string[] }): JSX.Element {
  const [filter, setFilter] = useState<LogFilter>(EMPTY_FILTER)
  return <LogFilters filter={filter} onChange={setFilter} tags={tags} packages={packages} regexError={null} />
}

describe('LogFilters', () => {
  it('shows the regex error next to the input', () => {
    render(
      <LogFilters
        filter={{ ...EMPTY_FILTER, text: '(', regex: true }}
        onChange={() => {}}
        tags={[]}
        packages={[]}
        regexError="Unterminated group"
      />
    )

    const input = screen.getByRole('textbox', { name: '검색' })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const error = screen.getByText('Unterminated group')
    expect(input.getAttribute('aria-describedby')).toBe(error.id)
  })

  it('reports text, regex and level changes', async () => {
    const onChange = vi.fn()
    render(<LogFilters filter={EMPTY_FILTER} onChange={onChange} tags={[]} packages={[]} regexError={null} />)

    await userEvent.type(screen.getByRole('textbox', { name: '검색' }), 'x')
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, text: 'x' })

    await userEvent.click(screen.getByRole('checkbox', { name: '정규식' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, regex: true })

    await userEvent.selectOptions(screen.getByRole('combobox', { name: '최소 레벨' }), 'W')
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, minLevel: 'W' })
  })

  it('cycles a tag chip on click and exposes its state with aria-pressed', async () => {
    render(<Controlled />)
    const chip = screen.getByRole('button', { name: 'ActivityManager' })
    expect(chip.getAttribute('aria-pressed')).toBe('false')

    await userEvent.click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(chip.getAttribute('data-state')).toBe('include')

    await userEvent.click(chip)
    expect(chip.getAttribute('data-state')).toBe('exclude')
    expect(chip.getAttribute('aria-pressed')).toBe('false')

    await userEvent.click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    expect(chip.getAttribute('data-state')).toBe('off')
  })

  it('lists packages in the app select with an 전체 option', async () => {
    render(<Controlled packages={['com.example.a', 'com.example.b']} />)
    const select = screen.getByRole('combobox', { name: '앱' }) as HTMLSelectElement

    const options = [...select.options].map((o) => o.textContent)
    expect(options).toEqual(['전체', 'com.example.a', 'com.example.b'])
    expect(select.value).toBe('')

    await userEvent.selectOptions(select, 'com.example.b')
    expect(select.value).toBe('com.example.b')
    await userEvent.selectOptions(select, '')
    expect(select.value).toBe('')
  })
})
