import { describe, expect, it } from 'vitest'
import {
  CLAUDE_CODE_REMOVE_COMMAND,
  MCP_SERVER_NAME,
  claudeCodeCommand,
  claudeCodeCommandMasked,
  promptTemplates,
  serverInstructions
} from './agentGuide'

const server = { url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'secret-token-value' }

describe('serverInstructions', () => {
  it('tells the agent to find elements before tapping and to check logs on failure', () => {
    const text = serverInstructions()

    expect(text).toContain('`ui_find`')
    expect(text).toContain('`log_read`')
    expect(text).toContain('`hint`')
  })

  it('never carries connection details', () => {
    const text = serverInstructions()

    expect(text).not.toContain('Bearer')
    expect(text).not.toContain('127.0.0.1')
  })
})

describe('promptTemplates', () => {
  it('offers smoke, scenario and bug-repro templates in that order', () => {
    expect(promptTemplates(null).map((template) => template.id)).toEqual(['smoke', 'scenario', 'bug-repro'])
  })

  it('gives every template a label and a one-line description', () => {
    for (const template of promptTemplates(null)) {
      expect(template.label.length).toBeGreaterThan(0)
      expect(template.description).not.toContain('\n')
    }
  })

  it('fills in the target serial when there is one', () => {
    for (const template of promptTemplates('emulator-5554')) {
      expect(template.body).toContain('`emulator-5554`')
    }
  })

  it('tells the agent to pick a device when there is no target', () => {
    for (const template of promptTemplates(null)) {
      expect(template.body).toContain('`device_list`')
      expect(template.body).toContain('`device_select`')
    }
  })

  it('leaves package and APK placeholders for the agent to resolve', () => {
    for (const template of promptTemplates(null)) {
      expect(template.body).toContain('<패키지명>')
      expect(template.body).toContain('<APK 경로>')
    }
  })

  it('never carries connection details', () => {
    for (const template of [...promptTemplates(null), ...promptTemplates('emulator-5554')]) {
      expect(template.body).not.toContain('Bearer')
      expect(template.body).not.toContain('127.0.0.1')
      expect(template.body).not.toContain(server.token)
    }
  })

  it('has a slot for the scenario and for the bug symptom', () => {
    const [, scenario, bug] = promptTemplates(null)

    expect(scenario?.body).toContain('<시나리오>')
    expect(bug?.body).toContain('<증상>')
  })
})

describe('claudeCodeCommand', () => {
  it('builds a claude mcp add command with the url and bearer token', () => {
    expect(claudeCodeCommand(server)).toBe(
      `claude mcp add --transport http ${MCP_SERVER_NAME} http://127.0.0.1:9321/mcp --header "Authorization: Bearer secret-token-value"`
    )
  })

  it('has a masked variant for display that hides the token', () => {
    const masked = claudeCodeCommandMasked(server)

    expect(masked).not.toContain(server.token)
    expect(masked).toContain('http://127.0.0.1:9321/mcp')
    expect(masked).toContain('Bearer ')
  })

  it('names the same server in the remove command', () => {
    expect(CLAUDE_CODE_REMOVE_COMMAND).toBe(`claude mcp remove ${MCP_SERVER_NAME}`)
  })
})
