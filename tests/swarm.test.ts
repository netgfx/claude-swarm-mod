import { expect, test, mock } from 'claude-code/testing'
import { pickColor, PALETTE, decide, claudeArgs, launchScript, launchCandidates, focusArgv, findConflicts, validateName, suggestName, MODELS, modelAlias } from '../hooks/lib.js'

type Opts = { os?: 'windows' | 'mac'; env?: Record<string, string>; coreCheck?: 'allow' | 'ask' | 'deny'; ttyFile?: string; spawnDeny?: string }

// Registers every stub the mod needs; returns what the stubs saw
function setup(on: any, opts: Opts = {}) {
  const os = opts.os ?? 'windows'
  const seen = {
    opened: [] as string[],
    spawns: [] as any[],
    writes: [] as { path: string; text: string }[],
    runs: [] as string[][],
    steps: [] as any[],
    sends: [] as any[],
    toasts: [] as string[],
    copies: [] as string[],
    store: new Map<string, unknown>(),
  }
  on('session.start', () => ({ cwd: os === 'windows' ? 'C:\\work' : '/work' }))
  on('session.cwd', () => ({ value: os === 'windows' ? 'C:\\work' : '/work' }))
  on('session.id', () => ({ value: 'lead-session' }))
  mock.env(on, {
    ...(os === 'windows' ? { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\me' } : { HOME: '/Users/me' }),
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    ...(opts.env ?? {}),
  })
  on('store.get', ($: any, e: any) => ({ value: seen.store.get(e.key) }))
  on('store.set', ($: any, e: any) => { seen.store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', ($: any, e: any) => { seen.store.delete(e.key); return { value: undefined } })
  const clock = mock.clock(on, { now: 1_000_000 })
  for (const name of ['command.register', 'tool.register', 'ui.close', 'ui.status', 'ui.log']) on(name, () => ({ value: undefined }))
  on('ui.copy', ($: any, e: any) => { seen.copies.push(e.text); return { value: { isCopied: true } } })
  on('ui.focus', () => ({}))
  on('ui.toast', ($: any, e: any) => { seen.toasts.push(e.text); return { value: undefined } })
  on('ui.open', ($: any, e: any) => { seen.opened.push(e.id); return { value: { isPlaced: true } } })
  on('fs.list', () => ({ deny: 'missing' }))
  on('fs.read', ($: any, e: any) => (/\.tty$/.test(e.path) && opts.ttyFile ? { value: opts.ttyFile } : { deny: 'missing' }))
  on('fs.write', ($: any, e: any) => { seen.writes.push({ path: e.path, text: e.text }); return { value: undefined } })
  on('process.run', ($: any, e: any) => {
    seen.runs.push([...e.argv])
    if (e.argv[0] === 'uname') return { value: { exitCode: 0, stdout: os === 'mac' ? 'Darwin\n' : 'Linux\n', stderr: '' } }
    // the hold loop's one-second wait: take real time so the test gets turns
    if (e.argv[0] === 'ping' || e.argv[0] === 'sleep') return new Promise((r) => setTimeout(() => r({ value: { exitCode: 0, stdout: '', stderr: '' } }), 5))
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('agent.spawn', ($: any, e: any) => { seen.spawns.push(e); if (opts.spawnDeny) return { deny: opts.spawnDeny }; return { model: 'claude-sonnet-5-5', agentId: 'A1', teammateId: e.name + '@session-abc' } })
  on('agent.list', () => ({ value: [{ id: 'A1', description: 'swarm', type: 'general-purpose', status: 'running', name: 'scout', teammateId: 'scout@session-abc' }] }))
  on('session.send', ($: any, e: any) => { seen.sends.push(e); return { isDelivered: true } })
  on('turn.step', async function* ($: any, e: any) {
    seen.steps.push(e)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, model: 'm' } }
  })
  on('tool.check', () => ({ decision: opts.coreCheck ?? 'ask' }))
  // acts as core for tool.call: holds the call until the test releases it
  const held: { release?: (v: any) => void } = {}
  on('tool.call', () => new Promise((r) => { held.release = r }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  return { seen, clock, held }
}

const pane = (requestId: string, surface: 'terminal' | 'desktop' = 'terminal') => ({
  plugin: 'swarm-mod', component: 'Pane', requestId, surface,
  viewport: { columns: 160, rows: 40 },
  props: { title: requestId, isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
}) as any

const band = (surface: 'terminal' | 'desktop' = 'terminal') => ({
  plugin: 'swarm-mod', component: 'AbovePrompt', requestId: 'single', surface,
  viewport: { columns: 160, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 },
}) as any

async function start($: any, os: 'windows' | 'mac' = 'windows') {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: os === 'windows' ? 'C:\\work' : '/work' })
}

// Starts a tool call, runs the permission check while core holds it, then lets it finish
async function callWithCheck($: any, held: any, call: any) {
  held.release = undefined
  const p = $.tool.call(call)
  for (let i = 0; i < 100 && !held.release; i++) await Promise.resolve()
  const check = $.tool.check({ tool: call.tool, input: call, tool_use_id: call.tool_use_id })
  return { p, check }
}

// Fills in the wizard and spawns; returns the wizard mount for further checks
async function spawnVia($: any, fill: Record<string, string> = {}) {
  await $.command.run({ command: 'swarm', args: 'spawn' })
  const ui = await $.ui.mount(pane('swarm-spawn'))
  if (fill.mode) (await ui.press({ key: 'w-mode' }), await ui.press({ key: 'w-mode:' + fill.mode }))
  if (fill.model) (await ui.press({ key: 'w-model' }), await ui.press({ key: 'w-model:' + fill.model }))
  if (fill.effort) (await ui.press({ key: 'w-effort' }), await ui.press({ key: 'w-effort:' + fill.effort }))
  if (fill.approval) (await ui.press({ key: 'w-approval' }), await ui.press({ key: 'w-approval:' + fill.approval }))
  if (fill.name) await ui.input({ key: 'w-name', text: fill.name })
  if (fill.task) await ui.input({ key: 'w-task', text: fill.task })
  await ui.press({ key: 'w-spawn' })
  await ui.unmount()
}

// ---------------- pure helpers ----------------

test('pickColor never suggests a color a live agent has', async () => {
  const used = PALETTE.slice(0, PALETTE.length - 1).map((c) => c.hex)
  for (let i = 0; i < 20; i++) expect(pickColor(used, () => i / 20)).toBe(PALETTE[PALETTE.length - 1].hex)
})

test('approval modes map engine decisions', async () => {
  expect(decide('acceptEdits', 'Edit', 'ask')).toBe('allow')
  expect(decide('acceptEdits', 'Bash', 'ask')).toBe('ask')
  expect(decide('plan', 'Write', 'allow')).toBe('deny')
  expect(decide('plan', 'Read', 'allow')).toBe('allow')
  expect(decide('dontAsk', 'Bash', 'ask')).toBe('deny')
  expect(decide('bypassPermissions', 'Bash', 'ask')).toBe('allow')
  expect(decide('bypassPermissions', 'Bash', 'deny')).toBe('deny')
})

test('names are validated and suggested', async () => {
  expect(validateName('scout', ['Scout'])).toMatch(/taken/)
  expect(validateName('bad name', [])).toMatch(/letters/)
  expect(validateName('ok_1', [])).toBe(null)
  expect(suggestName('scout', ['scout', 'scout-2'])).toBe('scout-3')
})

test('worker CLI args carry every choice and quote safely', async () => {
  const spec = { id: 'k1', lead: 'L', name: 'rook', cwd: "C:\\it's here", pluginRoot: 'C:\\mods\\swarm-mod', settingsPath: 'C:\\s.json', agentType: 'reviewer', model: 'claude-haiku-4-5-20251001', effort: 'high', approval: 'acceptEdits', task: "fix the 'auth' bug" }
  const args = claudeArgs(spec)
  expect(args).toEqual(['--name', 'rook', '--plugin-dir', 'C:\\mods\\swarm-mod', '--agent', 'reviewer', '--model', 'claude-haiku-4-5-20251001', '--effort', 'high', '--permission-mode', 'acceptEdits', '--settings', 'C:\\s.json'])
  const ps = launchScript('windows', spec)
  expect(ps).toContain("Set-Location -LiteralPath 'C:\\it''s here'")
  expect(ps).toContain("$env:SWARM_MOD_TASK = 'fix the ''auth'' bug'")
  expect(ps).not.toContain('"')
  expect(ps).toContain("$env:SWARM_MOD_WORKER = 'k1'")
  const sh = launchScript('posix', { ...spec, cwd: "/w/it's" })
  expect(sh).toContain("cd '/w/it'\\''s'")
  expect(claudeArgs({ ...spec, agentType: 'Explore', approval: 'bypassPermissions', task: '' })).toContain('--dangerously-skip-permissions')
  expect(launchCandidates('windows', 'C:\\s.ps1', spec)[0].argv[0]).toBe('wt.exe')
  expect(launchCandidates('mac', '/s.command', spec)[0]).toEqual({ app: 'Terminal', argv: ['open', '-a', 'Terminal', '/s.command'] })
})

test('the macOS script runs claude through the login shell and records its tty', async () => {
  const spec = { id: 'k1', lead: 'L', name: 'rook', cwd: '/Users/me/proj', pluginRoot: '/Users/me/mods/swarm-mod', settingsPath: '/Users/me/.claude/swarm-mod/launch/worker-settings.json', ttyPath: '/Users/me/.claude/swarm-mod/launch/k1.tty', agentType: 'default', model: 'inherit', effort: 'default', approval: 'default', task: 'hi' }
  const sh = launchScript('posix', spec)
  expect(sh.startsWith('#!/bin/sh\n')).toBe(true)
  expect(sh).toContain("tty > '/Users/me/.claude/swarm-mod/launch/k1.tty'")
  expect(sh).toContain('LSH="$SHELL"')
  expect(sh).toContain(`exec "$LSH" -lic 'exec claude "$@"' claude '--name' 'rook' '--plugin-dir' '/Users/me/mods/swarm-mod'`)
  expect(sh).not.toContain('\r')
})

test('macOS prefers iTerm2 when the lead runs in it, then Terminal.app', async () => {
  const spec = { name: 'rook', cwd: '/w' }
  const withIterm = launchCandidates('mac', '/Users/me/x.command', spec, { iterm: true })
  expect(withIterm.map((c: any) => c.app)).toEqual(['iTerm', 'Terminal'])
  expect(withIterm[0].argv.join(' ')).toContain(`create window with default profile command "/bin/sh '/Users/me/x.command'"`)
  expect(launchCandidates('mac', '/x.command', spec).map((c: any) => c.app)).toEqual(['Terminal'])
})

test('macOS focus finds the tab by its tty', async () => {
  const term = focusArgv('mac', 'rook', { tty: '/dev/ttys004', app: 'Terminal' })
  expect(term[0]).toBe('osascript')
  expect(term.join('\n')).toContain('if tty of t is "/dev/ttys004" then')
  expect(term.join('\n')).toContain('set selected tab of w to t')
  const it = focusArgv('mac', 'rook', { tty: '/dev/ttys004', app: 'iTerm' })
  expect(it.join('\n')).toContain('tell application "iTerm"')
  expect(it.join('\n')).toContain('if tty of s is "/dev/ttys004" then')
  // each -e carries one AppleScript line; blocks are balanced
  for (const argv of [term, it]) {
    const lines = argv.filter((_: string, i: number) => argv[i - 1] === '-e')
    expect(lines.filter((l: string) => /^tell /.test(l)).length).toBe(lines.filter((l: string) => l === 'end tell').length)
    expect(lines.filter((l: string) => /^repeat /.test(l)).length).toBe(lines.filter((l: string) => l === 'end repeat').length)
    expect(lines.filter((l: string) => /^if .* then$/.test(l)).length).toBe(lines.filter((l: string) => l === 'end if').length)
    expect(lines.filter((l: string) => l === 'try').length).toBe(lines.filter((l: string) => l === 'end try').length)
  }
  expect(focusArgv('windows', 'rook')[0]).toBe('powershell')
})

test('conflicts compare paths case-insensitively on Windows and macOS', async () => {
  const c = findConflicts([{ key: 'a', files: ['C:\\w\\App.ts'] }, { key: 'b', files: ['c:/w/app.ts'] }], true)
  expect(c.length).toBe(1)
  expect(findConflicts([{ key: 'a', files: ['/Users/me/App.ts'] }, { key: 'b', files: ['/Users/me/app.ts'] }], true).length).toBe(1)
  expect(findConflicts([{ key: 'a', files: ['/w/App.ts'] }, { key: 'b', files: ['/w/app.ts'] }], false).length).toBe(0)
})

test('teammate spawns get the model family alias, never a full id', async () => {
  expect(MODELS.map((m) => modelAlias(m.value))).toEqual(['', 'opus', 'sonnet', 'haiku', 'fable'])
  expect(modelAlias('sonnet')).toBe('sonnet')
  expect(modelAlias('gpt-4')).toBe('')
})

// ---------------- the mod ----------------

test('the wizard suggests a name and an unused color, and spawns a teammate', async ($, on) => {
  const { seen } = setup(on)
  await start($)
  await spawnVia($, { model: 'claude-sonnet-5-5', task: 'review src/auth' })
  expect(seen.opened).toContain('swarm-spawn')
  expect(seen.spawns.length).toBe(1)
  expect(seen.spawns[0]).toMatchObject({ name: 'scout', model: 'sonnet', prompt: 'review src/auth' })

  const ui = await $.ui.mount(pane('swarm'))
  expect(await ui.find({ type: 'Text', text: /1 agents/ })).toBeDefined()
  await ui.unmount()

  // the second agent gets another name and a color different from the first
  await $.command.run({ command: 'swarm', args: 'spawn' })
  const w2 = await $.ui.mount(pane('swarm-spawn'))
  const nameInput = await w2.find({ type: 'Input', key: 'w-name' } as any)
  expect(nameInput).toBeDefined()
  await w2.unmount()
})

test('a duplicate name is refused in the wizard', async ($, on) => {
  const { seen } = setup(on)
  await start($)
  await spawnVia($, { name: 'scout', task: 'a' })
  await $.command.run({ command: 'swarm', args: 'spawn' })
  const ui = await $.ui.mount(pane('swarm-spawn'))
  await ui.input({ key: 'w-name', text: 'scout' })
  await ui.press({ key: 'w-spawn' })
  expect(await ui.find({ type: 'Text', text: /taken/ })).toBeDefined()
  expect(seen.spawns.length).toBe(1)
})

test('effort is applied per agent and tokens are counted', async ($, on) => {
  const { seen } = setup(on)
  await start($)
  await spawnVia($, { effort: 'max', task: 'go' })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'm', effort: 'medium', messageCount: 1, agentId: 'A1' } as any)
  for await (const _ of stream as any) { /* drain */ }
  expect(seen.steps[0].effort).toBe('max')
  // the main loop keeps its own effort
  const main = $.turn.step({ turnId: 't2', index: 0, model: 'm', effort: 'medium', messageCount: 1 } as any)
  for await (const _ of main as any) { /* drain */ }
  expect(seen.steps[1].effort).toBe('medium')

  const ui = await $.ui.mount(pane('swarm'))
  expect(await ui.find({ type: 'Text', text: /3\.5k tok/ })).toBeDefined()
})

test('accept-edits teammates get edits approved; plan teammates are read-only', async ($, on) => {
  const { held } = setup(on, { coreCheck: 'ask' })
  await start($)
  await spawnVia($, { approval: 'acceptEdits', task: 'go' })
  const { p, check } = await callWithCheck($, held, { tool: 'Edit', tool_use_id: 'u1', agentId: 'A1', file_path: 'C:\\work\\a.ts', old_string: 'a', new_string: 'b' })
  expect((await check).decision).toBe('allow')
  held.release!({ result: 'ran' })
  await p
})

test('plan-mode teammates cannot edit', async ($, on) => {
  const { held } = setup(on, { coreCheck: 'allow' })
  await start($)
  await spawnVia($, { approval: 'plan', task: 'go' })
  const { p, check } = await callWithCheck($, held, { tool: 'Write', tool_use_id: 'u2', agentId: 'A1', file_path: 'C:\\work\\a.ts', content: 'x' })
  const c: any = await check
  expect(c.decision).toBe('deny')
  expect(c.reason).toMatch(/read-only/)
  held.release!({ deny: c.reason })
  await p
})

test('an approval waits for the swarm pane and the pane approves it', async ($, on) => {
  const { seen, held } = setup(on, { coreCheck: 'ask' })
  await start($)
  await spawnVia($, { task: 'go' })
  const { p, check: pending } = await callWithCheck($, held, { tool: 'Bash', tool_use_id: 'u3', agentId: 'A1', command: 'npm test' })
  // wait until the hold is visible in the band, then open it from there
  let attn: any
  for (let i = 0; i < 50 && !attn; i++) {
    const b = await $.ui.mount(band())
    attn = await b.find({ type: 'Button', key: 'band-attn' } as any)
    if (attn) await b.press({ key: 'band-attn' })
    await b.unmount()
  }
  expect(attn).toBeDefined()
  expect(seen.toasts.some((t) => /needs approval/.test(t))).toBe(true)
  const detailId = seen.opened.find((id) => id.startsWith('swarm-a-'))!
  const ui = await $.ui.mount(pane(detailId))
  expect(await ui.find({ type: 'Text', text: 'npm test' })).toBeDefined()
  await ui.press({ key: 'ap-allow' })
  const r: any = await pending
  expect(r.decision).toBe('allow')
  expect(r.reason).toMatch(/Approved by the user/)
  held.release!({ result: 'ran' })
  await p
})

test('a teammate question is answered from the pane', async ($, on) => {
  const { seen } = setup(on)
  await start($)
  await spawnVia($, { task: 'go' })
  const questions = [{ question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: '' }, { label: 'SQLite', description: '' }] }]
  const pending = $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'u4', agentId: 'A1', questions } as any)
  let opened = ''
  for (let i = 0; i < 50 && !opened; i++) {
    const b = await $.ui.mount(band())
    if (await b.find({ type: 'Button', key: 'band-attn' } as any)) await b.press({ key: 'band-attn' })
    await b.unmount()
    opened = seen.opened.find((id) => id.startsWith('swarm-a-')) ?? ''
  }
  const ui = await $.ui.mount(pane(opened))
  await ui.press({ key: 'q-0-1' })
  await ui.press({ key: 'q-send' })
  const r: any = await pending
  expect(r.result.answers).toEqual({ 'Which DB?': 'SQLite' })
})

for (const os of ['windows', 'mac'] as const) {
  test('a separate session launches in a new terminal on ' + os, async ($, on) => {
    const { seen } = setup(on, { os })
    await start($, os)
    await spawnVia($, { mode: 'session', name: 'rook', effort: 'high', task: 'hello' })
    const script = seen.writes.find((w) => /swarm-mod[\\/]launch[\\/]\w+\.(ps1|command|sh)$/.test(w.path))!
    expect(script).toBeDefined()
    expect(script.text).toContain("'--effort' 'high'")
    expect(script.text).toContain(os === 'windows' ? "$env:SWARM_MOD_TASK = 'hello'" : "export SWARM_MOD_TASK='hello'")
    expect(seen.writes.some((w) => /worker-settings\.json$/.test(w.path) && /crossSessionInbound/.test(w.text))).toBe(true)
    expect(script.text).toContain(os === 'windows' ? "Set-Location -LiteralPath 'C:\\work'" : "cd '/work'")
    const launch = seen.runs.find((r) => r[0] === (os === 'windows' ? 'wt.exe' : 'open'))
    expect(launch).toBeDefined()
    if (os === 'mac') {
      // fs stubs see host-absolute paths, so compare the tail; argv keeps the mod's own path
      expect(script.path).toMatch(/[\\/]Users[\\/]me[\\/]\.claude[\\/]swarm-mod[\\/]launch[\\/]\w+\.command$/)
      const chmod = seen.runs.find((r) => r[0] === 'chmod')!
      expect(chmod[2]).toMatch(/^\/Users\/me\/\.claude\/swarm-mod\/launch\/\w+\.command$/)
      expect(seen.runs.find((r) => r[0] === 'open')![3]).toBe(chmod[2])
      expect(script.text).toContain('.tty')
    }
    expect([...seen.store.keys()].some((k) => /^r:/.test(k))).toBe(true)
  })
}

test('on macOS inside iTerm2 the worker opens in iTerm2 and focus uses its tty', async ($, on) => {
  const { seen } = setup(on, { os: 'mac', env: { TERM_PROGRAM: 'iTerm.app' }, ttyFile: '/dev/ttys007\n' })
  await start($, 'mac')
  await spawnVia($, { mode: 'session', name: 'rook' })
  const first = seen.runs.find((r) => r[0] === 'osascript')!
  expect(first.join(' ')).toContain('create window with default profile command')
  const key = [...seen.store.keys()].find((k) => k.startsWith('r:'))!.slice(2)
  const ui = await $.ui.mount(pane('swarm-a-' + key))
  await ui.press({ key: 'focus' })
  const focus = seen.runs.filter((r) => r[0] === 'osascript').pop()!
  expect(focus.join('\n')).toContain('if tty of s is "/dev/ttys007" then')
})

test('a worker session reports its state for the lead', async ($, on) => {
  const { seen } = setup(on, { env: { SWARM_MOD_WORKER: 'k9', SWARM_MOD_LEAD: 'lead', SWARM_MOD_NAME: 'rook' } })
  await start($)
  expect((seen.store.get('w:k9') as any).status).toBe('idle')
  await $.turn.start({ text: 'do it', turnId: 'T1' } as any)
  expect((seen.store.get('w:k9') as any).status).toBe('working')
  await $.turn.complete({ turnId: 'T1', answer: 'done!', durationMs: 5, isAborted: false, reason: 'answer' } as any)
  const rep: any = seen.store.get('w:k9')
  expect(rep.status).toBe('idle')
  expect(rep.lastAnswer).toBe('done!')
  expect(rep.sessionId).toBe('lead-session')
})

test('the lead picks up a worker report and messages it by session id', async ($, on) => {
  const { seen, clock } = setup(on)
  await start($)
  await spawnVia($, { mode: 'session', name: 'rook' })
  const key = [...seen.store.keys()].find((k) => k.startsWith('r:'))!.slice(2)
  seen.store.set('w:' + key, { status: 'working', activity: 'Bash: ls', tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }, ctx: 10, turns: 0, log: [], files: [], lastAnswer: '', sessionId: 'S-rook', heartbeat: 1_000_500 })
  await clock.advance(1600)
  const ui = await $.ui.mount(pane('swarm-a-' + key))
  expect(await ui.find({ type: 'Text', text: /working · Bash: ls/ })).toBeDefined()
  await ui.input({ key: 'msg', text: 'please also run the linter' })
  expect(seen.sends[0].to).toBe('S-rook')
})

test('every pane and the band are valid in the terminal and on Desktop', async ($, on) => {
  const { seen } = setup(on)
  await start($)
  await spawnVia($, { task: 'go' })
  await $.command.run({ command: 'swarm', args: 'spawn' })
  const detailId = 'swarm-a-' + 'x'
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const id of ['swarm', 'swarm-spawn', detailId]) {
      const ui = await $.ui.mount(pane(id, surface))
      await ui.unmount()
    }
    const b = await $.ui.mount(band(surface))
    expect(await b.find({ type: 'Button', key: 'band-spawn' } as any)).toBeDefined()
    await b.unmount()
  }
  expect(seen.opened.length).toBeDefined()
})

test('wizard fields open as clickable lists; a pick closes the list', async ($, on) => {
  const { seen } = setup(on)
  await start($)
  await $.command.run({ command: 'swarm', args: 'spawn' })
  const ui = await $.ui.mount(pane('swarm-spawn'))
  expect(await ui.find({ type: 'Button', key: 'w-model:claude-opus-5-5' } as any)).toBeUndefined()
  await ui.press({ key: 'w-model' })
  expect(await ui.find({ type: 'Button', key: 'w-model:claude-opus-5-5' } as any)).toBeDefined()
  await ui.press({ key: 'w-model:claude-opus-5-5' })
  expect(await ui.find({ type: 'Button', key: 'w-model:claude-opus-5-5' } as any)).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /Model: .*Opus/i } as any)).toBeDefined()
  await ui.input({ key: 'w-task', text: 'go' })
  await ui.press({ key: 'w-spawn' })
  expect(seen.spawns[0].model).toBe('opus')
})

test('a refused spawn keeps the whole error, and pressing failed copies it', async ($, on) => {
  const long = '<tool_use_error>InputValidationError: [' + 'x'.repeat(400) + ']</tool_use_error>'
  const { seen } = setup(on, { spawnDeny: long })
  await start($)
  await spawnVia($, { task: 'review' })
  const main = await $.ui.mount(pane('swarm'))
  const btn: any = await main.find({ type: 'Button', text: /failed · copy error/ } as any)
  expect(btn).toBeDefined()
  await main.press({ key: btn.props.key })
  expect(seen.copies).toEqual(['Spawn refused: ' + long])
})
