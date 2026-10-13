import { expect, test, mock } from 'claude-code/testing'
import { adoptedName } from '../hooks/lib.js'

// Subagents the swarm did not spawn: the model's Agent calls, another plugin's spawns.
// `seen.list` is what $.agent.list() answers; core's agent.spawn adds to it.
function setup(on: any, opts: { coreCheck?: 'allow' | 'ask' } = {}) {
  const seen = {
    spawns: [] as any[],
    stops: [] as any[],
    sends: [] as any[],
    toasts: [] as string[],
    list: [] as any[],
    store: new Map<string, unknown>(),
  }
  on('session.start', () => ({ cwd: 'C:\\work' }))
  on('session.cwd', () => ({ value: 'C:\\work' }))
  on('session.id', () => ({ value: 'lead-session' }))
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\me', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' })
  on('store.get', ($: any, e: any) => ({ value: seen.store.get(e.key) }))
  on('store.set', ($: any, e: any) => { seen.store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', ($: any, e: any) => { seen.store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...seen.store.keys()] }))
  const clock = mock.clock(on, { now: 1_000_000 })
  for (const name of ['command.register', 'tool.register', 'ui.close', 'ui.status', 'ui.log', 'ui.open']) on(name, () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('ui.toast', ($: any, e: any) => { seen.toasts.push(e.text); return { value: undefined } })
  on('fs.list', () => ({ deny: 'missing' }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('agent.spawn', ($: any, e: any) => {
    seen.spawns.push(e)
    const id = 'A' + seen.spawns.length
    seen.list.push({ id, name: e.name, description: e.description, type: e.subagentType || 'general-purpose', status: 'running' })
    return { model: 'claude-sonnet-5-5', agentId: id }
  })
  on('agent.list', () => ({ value: seen.list.map((x) => ({ ...x })) }))
  on('session.send', ($: any, e: any) => { seen.sends.push(e); return { isDelivered: true } })
  on('turn.step', async function* ($: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, model: 'm' } }
  })
  on('tool.check', () => ({ decision: opts.coreCheck ?? 'ask' }))
  on('tool.call', ($: any, e: any) => {
    if (e.tool === 'TaskStop') seen.stops.push(e)
    return { result: 'ran' }
  })
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  return { seen, clock }
}

const pane = (requestId: string, surface: 'terminal' | 'desktop' = 'terminal') => ({
  plugin: 'swarm-mod', component: 'Pane', requestId, surface,
  viewport: { columns: 160, rows: 40 },
  props: { title: requestId, isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
}) as any

async function start($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work' })
}

async function ticks(clock: any, ms: number) {
  for (let t = 0; t < ms; t += 1600) {
    await clock.advance(1600)
    await clock.settle()
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
}

// What Claude's own Agent tool does: an agent.spawn not raised by the swarm
async function modelSpawns($: any, description: string, prompt = 'do it', subagentType = 'general-purpose') {
  return $.agent.spawn({ prompt, description, subagentType })
}

async function status($: any) {
  return ((await $.command.run({ command: 'swarm', args: 'status' })) as any).text as string
}

test('adopted names come from the agent name, its description, then its type', async () => {
  expect(adoptedName({ description: 'Game UI / HUD / cards' }, [])).toBe('game-ui-hud-cards')
  expect(adoptedName({ name: 'Researcher', description: 'x' }, [])).toBe('researcher')
  expect(adoptedName({ type: 'Explore' }, ['explore'])).toBe('explore-2')
  expect(adoptedName({ description: 'Multiplayer room server + transport layer for lobby' }, []).length).toBeLessThanOrEqual(30)
  expect(adoptedName({}, [])).toBe('subagent')
})

test("Claude's own subagents join the swarm, with their tokens and status", async ($, on) => {
  const { seen, clock } = setup(on)
  await start($)
  await modelSpawns($, 'Physics dice layer', 'build the dice physics')
  await modelSpawns($, 'Rules engine + bot + tests', 'write the rules engine', 'Plan')
  const text = await status($)
  expect(text).toContain('physics-dice-layer (subagent, default')
  expect(text).toContain('rules-engine-bot-tests (subagent, Plan')

  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', effort: 'medium', messageCount: 1, agentId: 'A1' } as any) as any) { /* drain */ }
  const ui = await $.ui.mount(pane('swarm'))
  expect(await ui.find({ type: 'Text', text: /subagent: Physics dice layer · 3\.5k tok/ })).toBeDefined()
  await ui.unmount()

  seen.list = seen.list.filter((x) => x.id !== 'A1')
  await ticks(clock, 1600)
  expect(await status($)).toMatch(/physics-dice-layer[^\n]*\n\s*status: done/)
})

test('a subagent spawned before the mod loaded is picked up from the agent list', async ($, on) => {
  const { seen, clock } = setup(on)
  seen.list.push({ id: 'X1', description: '3D board scene (R3F)', type: 'general-purpose', status: 'completed' })
  seen.list.push({ id: 'X2', description: 'swarm: scout', type: 'general-purpose', status: 'running', name: 'scout', spawnedBy: 'swarm-mod' })
  await start($)
  await ticks(clock, 1600)
  const text = await status($)
  expect(text).toContain('3d-board-scene-r3f (subagent')
  expect(text).not.toContain('scout')
})

test('an event from a subagent loop adopts it even before its spawn resolves', async ($, on) => {
  const { seen } = setup(on)
  seen.list.push({ id: 'Z9', description: 'Procedural music + SFX', type: 'general-purpose', status: 'running' })
  await start($)
  await $.tool.call({ tool: 'Read', tool_use_id: 'u1', agentId: 'Z9', file_path: 'C:\\work\\a.ts' })
  expect(await status($)).toContain('procedural-music-sfx (subagent')
})

test("the swarm's own spawns are not adopted twice", async ($, on) => {
  const { seen, clock } = setup(on)
  await start($)
  await $.command.run({ command: 'swarm', args: 'spawn' })
  const ui = await $.ui.mount(pane('swarm-spawn'))
  await ui.input({ key: 'w-name', text: 'scout' })
  await ui.press({ key: 'w-spawn' })
  await ui.unmount()
  await ticks(clock, 3200)
  expect((await status($)).split('\n').filter((l) => /^\S/.test(l))).toEqual([expect.stringContaining('scout (teammate')])
})

test("an adopted subagent keeps Claude Code's own permission prompt", async ($, on) => {
  setup(on, { coreCheck: 'ask' })
  await start($)
  await modelSpawns($, 'Game UI / HUD / cards')
  const p = $.tool.call({ tool: 'Edit', tool_use_id: 'u7', agentId: 'A1', file_path: 'C:\\work\\a.ts', old_string: 'a', new_string: 'b' })
  const check: any = await $.tool.check({ tool: 'Edit', input: {}, tool_use_id: 'u7' } as any)
  expect(check.decision).toBe('ask')
  await p
})

test('an adopted subagent is renamed and edited, then saved in a roster', async ($, on) => {
  const { seen, clock } = setup(on)
  await start($)
  await modelSpawns($, 'Multiplayer room server', 'write the room server', 'Explore')
  // the detail pane's Edit opens the form filled in from the agent
  const rows: any = await $.ui.mount(pane('swarm'))
  const openBtn: any = await rows.find({ type: 'Button', text: /multiplayer-room-server/ })
  await rows.press({ key: openBtn.key })
  await rows.unmount()
  const detail = await $.ui.mount(pane('swarm-a-' + String(openBtn.key).slice('open-'.length)))
  expect(await detail.find({ type: 'Text', text: /spawned by Claude · Multiplayer room server/ })).toBeDefined()
  await detail.press({ key: 'edit' })
  await detail.unmount()

  const form = await $.ui.mount(pane('swarm-spawn'))
  expect(await form.find({ type: 'Button', key: 'w-spawn' } as any)).toBeUndefined()
  await form.input({ key: 'w-name', text: 'netcode' })
  await form.press({ key: 'w-effort' })
  await form.press({ key: 'w-effort:high' })
  await form.press({ key: 'w-save' })
  await form.unmount()
  const text = await status($)
  expect(text).toContain('netcode (subagent, Explore')
  expect(text).toContain('effort high')

  await $.command.run({ command: 'swarm', args: 'save game team' })
  const saved: any = seen.store.get('roster:game team')
  expect(saved.agents).toEqual([expect.objectContaining({ name: 'netcode', agentType: 'Explore', effort: 'high', task: 'write the room server', transport: 'teammate' })])
  // adopted agents stay out of the automatic last swarm
  await ticks(clock, 1600)
  expect(seen.store.has('last:c:/work')).toBe(false)
})

test('a removed subagent is not adopted again; kill stops it by its agent id', async ($, on) => {
  const { seen, clock } = setup(on)
  await start($)
  await modelSpawns($, 'Physics dice layer')
  await $.command.run({ command: 'swarm', args: 'kill-all' })
  expect(seen.stops.map((s) => s.task_id)).toEqual(['A1'])
  const ui = await $.ui.mount(pane('swarm'))
  await ui.press({ key: 'clear-done' })
  await ui.unmount()
  await ticks(clock, 3200)
  expect(await status($)).toMatch(/swarm is empty/)
})

test('the edit form is valid in the terminal and on Desktop', async ($, on) => {
  setup(on)
  await start($)
  await modelSpawns($, 'Physics dice layer')
  const rows: any = await $.ui.mount(pane('swarm'))
  const openBtn: any = await rows.find({ type: 'Button', text: /physics-dice-layer/ })
  await rows.unmount()
  const key = String(openBtn.key).slice('open-'.length)
  for (const surface of ['terminal', 'desktop'] as const) {
    const d = await $.ui.mount(pane('swarm-a-' + key, surface))
    await d.press({ key: 'edit' })
    await d.unmount()
    const f = await $.ui.mount(pane('swarm-spawn', surface))
    expect(await f.find({ type: 'Button', key: 'w-save' } as any)).toBeDefined()
    await f.unmount()
  }
})
