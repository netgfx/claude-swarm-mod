import { expect, test, mock } from 'claude-code/testing'
import {
  needsRestart, restartDelayMs, RESTART_MAX, planRoster, parsePidLine, killArgv, pidNameArgv, selfPidArgv,
  lastRosterKey, rosterEntry, restartTask, PALETTE,
} from '../hooks/lib.js'

type Opts = { os?: 'windows' | 'mac'; store?: Record<string, unknown>; env?: Record<string, string>; ask?: string; oldStore?: Record<string, unknown> }

// Stubs for kill / restart / roster flows. `seen.list` is what $.agent.list() answers.
function setup(on: any, opts: Opts = {}) {
  const os = opts.os ?? 'windows'
  const cwd = os === 'windows' ? 'C:\\work' : '/work'
  const seen = {
    opened: [] as string[],
    spawns: [] as any[],
    writes: [] as { path: string; text: string }[],
    runs: [] as string[][],
    stops: [] as any[],
    toasts: [] as string[],
    asks: [] as any[],
    reads: [] as string[],
    list: [] as any[],
    pidName: 'claude',
    store: new Map<string, unknown>(Object.entries(opts.store ?? {})),
  }
  on('session.start', () => ({ cwd }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.id', () => ({ value: 'lead-session' }))
  mock.env(on, {
    ...(os === 'windows'
      ? { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\me', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
      : { HOME: '/Users/me', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }),
    ...(opts.env ?? {}),
  })
  on('store.get', ($: any, e: any) => ({ value: seen.store.get(e.key) }))
  on('store.set', ($: any, e: any) => { seen.store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', ($: any, e: any) => { seen.store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...seen.store.keys()] }))
  const clock = mock.clock(on, { now: 1_000_000 })
  for (const name of ['command.register', 'tool.register', 'ui.close', 'ui.status', 'ui.log']) on(name, () => ({ value: undefined }))
  on('ui.toast', ($: any, e: any) => { seen.toasts.push(e.text); return { value: undefined } })
  on('ui.open', ($: any, e: any) => { seen.opened.push(e.id); return { value: { isPlaced: true } } })
  // Claude Code's plugin store folder, holding swarm-mod's store file when opts.oldStore is set
  on('fs.list', ($: any, e: any) => (opts.oldStore && /[\\/]plugins[\\/]store$/.test(e.path)
    ? { value: [
      { name: 'other-mod_x-111111111111.json', kind: 'file', size: 2, isLink: false },
      { name: 'swarm-mod_claude-swarm-mod-222222222222.json', kind: 'file', size: 2, isLink: false },
    ] }
    : { deny: 'missing' }))
  on('fs.read', ($: any, e: any) => {
    seen.reads.push(e.path)
    if (opts.oldStore && /[\\/]plugins[\\/]store[\\/]swarm-mod_claude-swarm-mod-222222222222\.json$/.test(e.path)) return { value: JSON.stringify(opts.oldStore) }
    return { deny: 'missing' }
  })
  on('fs.write', ($: any, e: any) => { seen.writes.push({ path: e.path, text: e.text }); return { value: undefined } })
  on('process.run', ($: any, e: any) => {
    seen.runs.push([...e.argv])
    const a0 = e.argv[0]
    if (a0 === 'uname') return { value: { exitCode: 0, stdout: os === 'mac' ? 'Darwin\n' : 'Linux\n', stderr: '' } }
    if (a0 === 'ps' || (a0 === 'powershell' && /Get-Process -Id \d+ -ErrorAction/.test(e.argv.join(' ')))) {
      return { value: { exitCode: 0, stdout: seen.pidName + '\n', stderr: '' } }
    }
    if (e.argv.join(' ').includes('ParentProcessId') || (a0 === '/bin/sh' && /PPID/.test(e.argv.join(' ')))) {
      return { value: { exitCode: 0, stdout: '5555 claude\n', stderr: '' } }
    }
    if (a0 === 'ping' || a0 === 'sleep') return new Promise((r) => setTimeout(() => r({ value: { exitCode: 0, stdout: '', stderr: '' } }), 5))
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('agent.spawn', ($: any, e: any) => {
    seen.spawns.push(e)
    seen.list = seen.list.filter((x) => x.name !== e.name)
    seen.list.push({ id: 'A' + seen.spawns.length, name: e.name, description: e.description, type: 'general-purpose', status: 'running', teammateId: e.name + '@t' })
    return { model: 'm', agentId: 'A' + seen.spawns.length, teammateId: e.name + '@t' }
  })
  on('agent.list', () => ({ value: seen.list.map((x) => ({ ...x })) }))
  on('session.send', () => ({ isDelivered: true }))
  // Claude Code's own permission decision: TaskStop and the mod's own questions need none
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', ($: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      // $.ui.ask reaches Claude Code as an AskUserQuestion call
      seen.asks.push(e.questions[0])
      return opts.ask ? { result: { answers: { [e.questions[0].question]: opts.ask } } } : { deny: 'dismissed' }
    }
    if (e.tool === 'TaskStop') {
      seen.stops.push(e)
      for (const x of seen.list) if (x.teammateId === e.task_id || x.name === e.task_id) x.status = 'killed'
      return { result: 'stopped' }
    }
    return { result: 'ran' }
  })
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  return { seen, clock }
}

const pane = (requestId: string, surface: 'terminal' | 'desktop' = 'terminal') => ({
  plugin: 'powermods-swarm', component: 'Pane', requestId, surface,
  viewport: { columns: 160, rows: 40 },
  props: { title: requestId, isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
}) as any

const band = () => ({
  plugin: 'powermods-swarm', component: 'AbovePrompt', requestId: 'single', surface: 'terminal',
  viewport: { columns: 160, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140 },
}) as any

async function start($: any, os: 'windows' | 'mac' = 'windows') {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: os === 'windows' ? 'C:\\work' : '/work' })
}

async function spawnVia($: any, fill: Record<string, string> = {}) {
  await $.command.run({ command: 'swarm', args: 'spawn' })
  const ui = await $.ui.mount(pane('swarm-spawn'))
  if (fill.mode) (await ui.press({ key: 'w-mode' }), await ui.press({ key: 'w-mode:' + fill.mode }))
  if (fill.restart) (await ui.press({ key: 'w-restart' }), await ui.press({ key: 'w-restart:' + fill.restart }))
  if (fill.name) await ui.input({ key: 'w-name', text: fill.name })
  if (fill.task) await ui.input({ key: 'w-task', text: fill.task })
  await ui.press({ key: 'w-spawn' })
  await ui.unmount()
}

// runs the 1.5 s poll a few times
async function ticks(clock: any, ms: number) {
  for (let t = 0; t < ms; t += 1600) {
    await clock.advance(1600)
    await clock.settle()
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
}

function keyOf(seen: any, name: string) {
  // the worker's reply key is r:<key>; teammates are found through the pane
  return [...seen.store.keys()].find((k: string) => k.startsWith('r:'))?.slice(2)
}

// ---------------- pure helpers ----------------

test('auto-restart policy', async () => {
  const base = { autoRestart: true, restarts: 0 }
  expect(needsRestart({ ...base, transport: 'teammate', status: 'failed' }, 0)).toBe(true)
  expect(needsRestart({ ...base, transport: 'teammate', status: 'killed' }, 0)).toBe(false) // stopped by a person
  expect(needsRestart({ ...base, transport: 'teammate', status: 'completed' }, 0)).toBe(false)
  expect(needsRestart({ ...base, transport: 'session', status: 'exited', exitReason: 'other' }, 0)).toBe(true)
  expect(needsRestart({ ...base, transport: 'session', status: 'exited', exitReason: 'prompt_input_exit' }, 0)).toBe(false)
  expect(needsRestart({ ...base, transport: 'session', status: 'unresponsive', unresponsiveSince: 1000 }, 30_000)).toBe(false)
  expect(needsRestart({ ...base, transport: 'session', status: 'unresponsive', unresponsiveSince: 1000 }, 70_000)).toBe(true)
  expect(needsRestart({ ...base, transport: 'session', status: 'failed', killedByUser: true }, 0)).toBe(false)
  expect(needsRestart({ ...base, transport: 'session', status: 'failed', restarts: RESTART_MAX }, 0)).toBe(false)
  expect(needsRestart({ autoRestart: false, transport: 'session', status: 'failed' }, 0)).toBe(false)
  expect([0, 1, 2].map(restartDelayMs)).toEqual([5000, 15000, 45000])
  expect(restartTask('fix it')).toMatch(/restarted[\s\S]*\n\nfix it$/)
})

test('pids are read and killed per platform', async () => {
  expect(parsePidLine('5172 claude\r\n')).toEqual({ pid: 5172, name: 'claude' })
  expect(parsePidLine('812 /usr/local/bin/claude\n')).toEqual({ pid: 812, name: 'claude' })
  expect(parsePidLine('')).toBe(null)
  expect(killArgv('windows', 42)).toEqual(['taskkill', '/PID', '42', '/T', '/F'])
  expect(killArgv('mac', 42)).toEqual(['kill', '-TERM', '42'])
  expect(pidNameArgv('mac', 42)).toEqual(['ps', '-o', 'comm=', '-p', '42'])
  expect(selfPidArgv('mac')[0]).toBe('/bin/sh')
  expect(selfPidArgv('windows').join(' ')).toContain('ParentProcessId')
})

test('a roster is fitted beside the agents already here', async () => {
  const entries = [{ name: 'scout', color: PALETTE[0].hex, transport: 'teammate' }, { name: 'rook', color: PALETTE[1].hex, transport: 'session' }]
  const plan = planRoster(entries, ['scout'], [PALETTE[1].hex], () => 0)
  expect(plan[0].name).toBe('scout-2')
  expect(plan[0].color).toBe(PALETTE[0].hex)
  expect(plan[1].name).toBe('rook')
  expect(plan[1].color).not.toBe(PALETTE[1].hex)
  expect(new Set(plan.map((p: any) => p.color)).size).toBe(2)
  expect(Object.keys(rosterEntry({ name: 'x', color: '#fff', agentType: 'default', model: 'inherit', effort: 'high', approval: 'plan', transport: 'session', task: 't', autoRestart: true, tokens: {}, pid: 3 })).sort())
    .toEqual(['agentType', 'approval', 'autoRestart', 'color', 'effort', 'model', 'name', 'task', 'transport'])
  expect(lastRosterKey('C:\\Work\\', true)).toBe('last:c:/work')
  expect(lastRosterKey('/Users/me/Proj', false)).toBe('last:/Users/me/Proj')
})

// ---------------- the mod ----------------

test('kill all asks twice, then stops teammates and ends separate sessions by pid', async ($, on) => {
  const { seen, clock } = setup(on)
  await start($)
  await spawnVia($, { name: 'scout', task: 'a' })
  await spawnVia($, { mode: 'session', name: 'rook' })
  const key = keyOf(seen, 'rook')!
  seen.store.set('w:' + key, { status: 'working', heartbeat: 1_000_100, pid: 4242, pidName: 'claude', sessionId: 'S1', tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, log: [], files: [] })
  await ticks(clock, 1600)

  const ui = await $.ui.mount(pane('swarm'))
  await ui.press({ key: 'kill-all' })
  expect(seen.stops.length).toBe(0)
  expect(await ui.find({ type: 'Button', text: /Press again to kill 2/ } as any)).toBeDefined()
  await ui.press({ key: 'kill-all' })
  expect(seen.stops.map((s) => s.task_id)).toEqual(['scout@t'])
  expect(seen.runs.some((r) => r[0] === 'taskkill' && r[2] === '4242')).toBe(true)
  expect((seen.store.get('r:' + key) as any).killed).toBe(true)
  expect(seen.toasts).toContain('Killed 2 agents')
  expect(await ui.find({ type: 'Text', text: /✕ stopped/ })).toBeDefined()
})

test('a reused pid is never killed', async ($, on) => {
  const { seen, clock } = setup(on)
  await start($)
  await spawnVia($, { mode: 'session', name: 'rook' })
  const key = keyOf(seen, 'rook')!
  seen.store.set('w:' + key, { status: 'idle', heartbeat: 1_000_100, pid: 4242, pidName: 'claude', tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, log: [], files: [] })
  await ticks(clock, 1600)
  seen.pidName = 'chrome'
  const out: any = await $.command.run({ command: 'swarm', args: 'kill-all' })
  expect(out.text).toBe('Killed 1 swarm agent')
  expect(seen.runs.some((r) => r[0] === 'taskkill')).toBe(false)
  // the worker is told to end itself instead
  expect((seen.store.get('r:' + key) as any).killed).toBe(true)
})

test('a killed worker ends its own process when asked', async ($, on) => {
  const { seen, clock } = setup(on, { env: { SWARM_MOD_WORKER: 'k9', SWARM_MOD_NAME: 'rook' } })
  await start($)
  const boot: any = seen.store.get('w:k9')
  expect(boot.pid).toBe(5555)
  expect(boot.pidName).toBe('claude')
  seen.store.set('r:k9', { decisions: {}, abortSeq: 0, killed: true })
  await ticks(clock, 1600)
  expect((seen.store.get('w:k9') as any).status).toBe('killed')
  expect(seen.runs.some((r) => r[0] === 'taskkill' && r[2] === '5555')).toBe(true)
})

test('a crashed teammate with auto-restart comes back with the same settings', async ($, on) => {
  const { seen, clock } = setup(on)
  await start($)
  await spawnVia($, { name: 'scout', task: 'review auth', restart: 'on' })
  expect(seen.spawns.length).toBe(1)
  await ticks(clock, 1600)
  seen.list[0].status = 'failed'
  await ticks(clock, 1600)
  expect(seen.toasts.some((t) => /scout failed · auto-restart in 5s/.test(t))).toBe(true)
  expect(seen.spawns.length).toBe(1)
  await ticks(clock, 6000)
  expect(seen.spawns.length).toBe(2)
  expect(seen.spawns[1].name).toBe('scout')
  expect(seen.spawns[1].prompt).toMatch(/restarted[\s\S]*review auth/)
  expect(seen.toasts.some((t) => /scout restarted \(1\/3\)/.test(t))).toBe(true)
})

test('without auto-restart, or after you kill it, nothing comes back', async ($, on) => {
  const { seen, clock } = setup(on)
  await start($)
  await spawnVia($, { name: 'scout', task: 'a' })
  await spawnVia($, { name: 'forge', task: 'b', restart: 'on' })
  await ticks(clock, 1600)
  seen.list.find((x) => x.name === 'scout').status = 'failed'
  await $.command.run({ command: 'swarm', args: 'kill-all' })
  await ticks(clock, 70_000)
  expect(seen.spawns.length).toBe(2)
})

test('a hung worker is killed and relaunched after a minute of silence', async ($, on) => {
  const { seen, clock } = setup(on)
  await start($)
  await spawnVia($, { mode: 'session', name: 'rook', task: 'build it', restart: 'on' })
  const key = keyOf(seen, 'rook')!
  seen.store.set('w:' + key, { status: 'working', heartbeat: 1_000_100, pid: 777, pidName: 'claude', sessionId: 'S1', tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, log: [], files: [] })
  await ticks(clock, 1600)
  const launchesBefore = seen.runs.filter((r) => r[0] === 'wt.exe').length
  // no more heartbeats: unresponsive after 20 s, restart after 60 s more plus the 5 s backoff
  await ticks(clock, 30_000)
  expect(seen.runs.filter((r) => r[0] === 'wt.exe').length).toBe(launchesBefore)
  await ticks(clock, 75_000)
  expect(seen.runs.some((r) => r[0] === 'taskkill' && r[2] === '777')).toBe(true)
  expect(seen.runs.filter((r) => r[0] === 'wt.exe').length).toBe(launchesBefore + 1)
  const scripts = seen.writes.filter((w) => /\.ps1$/.test(w.path))
  expect(scripts[scripts.length - 1].text).toMatch(/SWARM_MOD_TASK = '\(You were restarted[\s\S]*build it'/)
})

test('a worker you /exit is not restarted', async ($, on) => {
  const { seen, clock } = setup(on)
  await start($)
  await spawnVia($, { mode: 'session', name: 'rook', restart: 'on' })
  const key = keyOf(seen, 'rook')!
  seen.store.set('w:' + key, { status: 'exited', exitReason: 'prompt_input_exit', heartbeat: 1_000_100, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, log: [], files: [] })
  const before = seen.runs.filter((r) => r[0] === 'wt.exe').length
  await ticks(clock, 70_000)
  expect(seen.runs.filter((r) => r[0] === 'wt.exe').length).toBe(before)
})

test('auto-restart can be toggled and a stopped agent respawned from its panel', async ($, on) => {
  const { seen } = setup(on)
  await start($)
  await spawnVia($, { name: 'scout', task: 'review auth' })
  const main = await $.ui.mount(pane('swarm'))
  const row: any = await main.find({ type: 'Button', text: 'scout' } as any)
  const rowKey = row.key ?? row.props?.key
  expect(rowKey).toMatch(/^open-/)
  await main.press({ key: rowKey })
  await main.unmount()
  const detail = await $.ui.mount(pane('swarm-a-' + rowKey.slice('open-'.length)))
  await detail.press({ key: 'auto-restart' })
  expect(await detail.find({ type: 'Button', text: /Auto-restart on/ } as any)).toBeDefined()
  await detail.press({ key: 'kill' })
  expect(seen.stops.length).toBe(1)
  expect(await detail.find({ type: 'Button', key: 'respawn' } as any)).toBeDefined()
  await detail.press({ key: 'respawn' })
  expect(seen.spawns.length).toBe(2)
  expect(seen.spawns[1].prompt).toBe('review auth') // a manual respawn keeps the task as given
  const status: any = await $.command.run({ command: 'swarm', args: 'status' })
  expect(status.text).toContain('auto-restart on (0/3 used)')
})

test('save a roster, then launch it in a fresh session with free names and colors', async ($, on) => {
  const { seen } = setup(on)
  await start($)
  await spawnVia($, { name: 'scout', task: 'review', restart: 'on' })
  await spawnVia($, { mode: 'session', name: 'rook', task: 'build' })
  await $.command.run({ command: 'swarm', args: 'rosters' })
  expect(seen.opened).toContain('swarm-rosters')
  const r = await $.ui.mount(pane('swarm-rosters'))
  await r.input({ key: 'r-name', text: 'backend team' })
  const saved: any = seen.store.get('roster:backend team')
  expect(saved.agents.map((a: any) => a.name)).toEqual(['scout', 'rook'])
  expect(saved.agents[0]).toMatchObject({ transport: 'teammate', task: 'review', autoRestart: true })
  expect(saved.agents[1]).toMatchObject({ transport: 'session', task: 'build' })
  expect(saved.agents[0].tokens).toBeUndefined()
  expect(await r.find({ type: 'Button', key: 'rl-0' } as any)).toBeDefined()
  await r.unmount()
  // launching it again here: names are taken, so they get suffixes
  const out: any = await $.command.run({ command: 'swarm', args: 'load backend team' })
  expect(out.text).toBe('Spawning 2 agents from roster "backend team"')
  expect(seen.spawns.map((s) => s.name)).toEqual(['scout', 'scout-2'])
  const status: any = await $.command.run({ command: 'swarm', args: 'status' })
  expect(status.text).toContain('rook-2 (session')
})

test('a roster from another session launches from the rosters pane', async ($, on) => {
  const roster = { cwd: 'C:\\other', savedAt: 1, agents: [
    { name: 'atlas', color: PALETTE[2].hex, agentType: 'default', model: 'claude-haiku-4-5-20251001', effort: 'low', approval: 'plan', transport: 'teammate', task: 'map the repo', autoRestart: false },
  ] }
  const { seen } = setup(on, { store: { 'roster:mapper': roster } })
  await start($)
  await $.command.run({ command: 'swarm', args: 'rosters' })
  const r = await $.ui.mount(pane('swarm-rosters'))
  expect(await r.find({ type: 'Text', text: 'mapper' })).toBeDefined()
  await r.press({ key: 'rl-0' })
  expect(seen.spawns[0]).toMatchObject({ name: 'atlas', model: 'haiku', prompt: 'map the repo' })
  const rows: any = await $.command.run({ command: 'swarm', args: 'status' })
  expect(rows.text).toContain('effort low, approval plan')
})

test('deleting a roster removes it', async ($, on) => {
  const { seen } = setup(on, { store: { 'roster:old': { cwd: 'C:\\w', savedAt: 1, agents: [{ name: 'x', transport: 'teammate' }] } } })
  await start($)
  await $.command.run({ command: 'swarm', args: 'rosters' })
  const r = await $.ui.mount(pane('swarm-rosters'))
  await r.press({ key: 'rd-0' })
  expect(seen.store.has('roster:old')).toBe(false)
})

test('the last swarm of this workspace is saved and offered after a restart', async ($, on) => {
  const last = { cwd: 'C:\\work', savedAt: 5, agents: [
    { name: 'scout', color: PALETTE[0].hex, transport: 'teammate', task: 'review' },
    { name: 'rook', color: PALETTE[1].hex, transport: 'session', task: 'build' },
  ] }
  const { seen } = setup(on, { store: { 'last:c:/work': last } })
  await start($)
  const b = await $.ui.mount(band())
  expect(await b.find({ type: 'Button', key: 'band-restore' } as any)).toBeDefined()
  await b.press({ key: 'band-restore' })
  await b.unmount()
  expect(seen.spawns.map((s) => s.name)).toEqual(['scout'])
  expect(seen.runs.some((r) => r[0] === 'wt.exe')).toBe(true)
  const b2 = await $.ui.mount(band())
  expect(await b2.find({ type: 'Button', key: 'band-restore' } as any)).toBeUndefined()
})

test('the current swarm is kept as this workspace\'s last swarm', async ($, on) => {
  const { seen, clock } = setup(on, { os: 'mac' })
  await start($, 'mac')
  await spawnVia($, { name: 'scout', task: 'review' })
  await ticks(clock, 1600)
  const last: any = seen.store.get('last:/work')
  expect(last.agents.map((a: any) => a.name)).toEqual(['scout'])
})

test('new panes are valid in the terminal and on Desktop', async ($, on) => {
  const { seen } = setup(on, { store: { 'roster:a': { cwd: '/w', savedAt: 1, agents: [{ name: 'x', color: PALETTE[0].hex, transport: 'teammate' }] } } })
  await start($)
  await spawnVia($, { name: 'scout', task: 'a', restart: 'on' })
  await $.command.run({ command: 'swarm', args: 'rosters' })
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const id of ['swarm', 'swarm-rosters', 'swarm-spawn']) {
      const ui = await $.ui.mount(pane(id, surface))
      await ui.unmount()
    }
  }
  expect(seen.opened).toContain('swarm-rosters')
})

// ---------------- "Bypass all checks" in rosters ----------------

const bypassRoster = { cwd: 'C:\\work', savedAt: 1, agents: [
  { name: 'rook', color: PALETTE[3].hex, agentType: 'default', model: 'inherit', effort: 'default', approval: 'bypassPermissions', transport: 'session', task: 'build', autoRestart: false },
] }

test('without allowBypass, a roster agent saved with "Bypass all checks" launches as "Ask me"', async ($, on) => {
  const { seen } = setup(on, { store: { 'roster:yolo': bypassRoster } })
  await start($)
  await $.command.run({ command: 'swarm', args: 'load yolo' })
  expect(seen.asks).toEqual([])
  const script = seen.writes.find((w) => /\.ps1$/.test(w.path))!
  expect(script.text).not.toContain('--dangerously-skip-permissions')
  expect(script.text).toContain("$env:SWARM_MOD_APPROVAL = 'default'")
  expect(seen.toasts.some((t) => /rook: "Bypass all checks" is turned off \(allowBypass\), so it runs as "Ask me"/.test(t))).toBe(true)
})

test('with allowBypass, launching a bypass roster asks first, naming the folder', { options: { allowBypass: true } }, async ($, on) => {
  const { seen } = setup(on, { store: { 'roster:yolo': bypassRoster }, ask: 'Turn checks off' })
  await start($)
  await $.command.run({ command: 'swarm', args: 'load yolo' })
  expect(seen.asks.length).toBe(1)
  expect(seen.asks[0].question).toBe('Run rook with every permission check off (Bypass all checks) in C:\\work?')
  expect(seen.asks[0].options.map((o: any) => o.label)).toEqual(['Turn checks off', 'Use Ask me', 'Cancel'])
  const script = seen.writes.find((w) => /\.ps1$/.test(w.path))!
  expect(script.text).toContain("'--dangerously-skip-permissions'")
})

test('with allowBypass, "Use Ask me" launches the roster without bypass', { options: { allowBypass: true } }, async ($, on) => {
  const { seen } = setup(on, { store: { 'roster:yolo': bypassRoster }, ask: 'Use Ask me' })
  await start($)
  await $.command.run({ command: 'swarm', args: 'load yolo' })
  const script = seen.writes.find((w) => /\.ps1$/.test(w.path))!
  expect(script.text).not.toContain('--dangerously-skip-permissions')
})

test('with allowBypass, dismissing the question launches nothing', { options: { allowBypass: true } }, async ($, on) => {
  const { seen } = setup(on, { store: { 'roster:yolo': bypassRoster } })
  await start($)
  await $.command.run({ command: 'swarm', args: 'load yolo' })
  expect(seen.asks.length).toBe(1)
  expect(seen.writes.some((w) => /\.ps1$/.test(w.path))).toBe(false)
  expect(seen.spawns.length).toBe(0)
  expect(seen.toasts).toContain('Not launched: "yolo"')
})

// ---------------- renamed from swarm-mod ----------------

for (const os of ['windows', 'mac'] as const) {
  test('saved rosters are copied once from the swarm-mod store (' + os + ')', async ($, on) => {
    const old = {
      'roster:old team': { cwd: '/w', savedAt: 3, agents: [{ name: 'scout', transport: 'teammate' }] },
      'roster:mine': { cwd: '/w', savedAt: 1, agents: [{ name: 'stale', transport: 'teammate' }] },
      'last:c:/work': { cwd: 'C:\\work', savedAt: 2, agents: [{ name: 'forge', transport: 'teammate' }] },
      band: 'off',
      'w:k1': { status: 'working' },
      'r:k1': { decisions: {} },
    }
    const mine = { cwd: '/w', savedAt: 9, agents: [{ name: 'keep', transport: 'teammate' }] }
    const { seen } = setup(on, { os, oldStore: old, store: { 'roster:mine': mine } })
    await start($, os)
    expect(seen.store.get('roster:old team')).toEqual(old['roster:old team'])
    expect(seen.store.get('last:c:/work')).toEqual(old['last:c:/work'])
    expect(seen.store.get('band')).toBe('off')
    // what is already here wins, and worker traffic stays behind
    expect(seen.store.get('roster:mine')).toEqual(mine)
    expect(seen.store.has('w:k1')).toBe(false)
    expect(seen.store.has('r:k1')).toBe(false)
    // only swarm-mod's own file is read, from Claude Code's plugin store folder (fs stubs
    // see host-absolute paths, so compare the tail)
    const storeReads = seen.reads.filter((p) => /plugins[\\/]store/.test(p))
    expect(storeReads.length).toBe(1)
    expect(storeReads[0]).toMatch(/[\\/]Users[\\/]me[\\/]\.claude[\\/]plugins[\\/]store[\\/]swarm-mod_claude-swarm-mod-222222222222\.json$/)
    expect(seen.store.get('migrated:swarm-mod')).toBe(true)
    // the next session does not copy again
    seen.store.delete('roster:old team')
    await start($, os)
    expect(seen.store.has('roster:old team')).toBe(false)
  })
}

test('the swarm-mod store is found under CLAUDE_CONFIG_DIR when it is set', async ($, on) => {
  const old = { 'roster:cfg': { cwd: '/w', savedAt: 1, agents: [{ name: 'x', transport: 'teammate' }] } }
  const { seen } = setup(on, { os: 'mac', oldStore: old, env: { CLAUDE_CONFIG_DIR: '/opt/claude-cfg' } })
  await start($, 'mac')
  expect(seen.store.has('roster:cfg')).toBe(true)
  expect(seen.reads.some((p) => /[\\/]opt[\\/]claude-cfg[\\/]plugins[\\/]store[\\/]swarm-mod_/.test(p))).toBe(true)
})

test('a worker session never copies the old store', async ($, on) => {
  const { seen } = setup(on, { oldStore: { 'roster:x': { agents: [] } }, env: { SWARM_MOD_WORKER: 'k9', SWARM_MOD_NAME: 'rook' } })
  await start($)
  expect(seen.store.has('roster:x')).toBe(false)
  expect(seen.store.has('migrated:swarm-mod')).toBe(false)
})

test('worker reports of agents no longer in the swarm are deleted after a week of silence', async ($, on) => {
  const day = 24 * 60 * 60 * 1000
  const { seen } = setup(on, { store: {
    'w:old': { status: 'idle', heartbeat: 1_000_000 - 8 * day, log: [{ t: 0, text: 'secret prompt' }] },
    'r:old': { decisions: {} },
    'w:recent': { status: 'working', heartbeat: 1_000_000 - day },
    'r:recent': { decisions: {} },
    'roster:keep': { agents: [] },
  } })
  await start($)
  expect(seen.store.has('w:old')).toBe(false)
  expect(seen.store.has('r:old')).toBe(false)
  // another lead's live worker, and saved rosters, stay
  expect(seen.store.has('w:recent')).toBe(true)
  expect(seen.store.has('r:recent')).toBe(true)
  expect(seen.store.has('roster:keep')).toBe(true)
})
