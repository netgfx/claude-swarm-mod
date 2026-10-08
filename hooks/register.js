// swarm-mod: spawn, watch and steer a swarm of Claude Code agents from a pane.
//
// Two transports:
//  - teammate: $.agent.spawn with a name, so it joins this session's agent team
//    (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1) or runs as a named background agent.
//    Its loop runs in this process, so these hooks see its steps, tools and checks.
//  - session: a separate interactive `claude` in a new terminal, started in this
//    workspace with this mod loaded. There the mod runs in "worker" mode and
//    reports to the lead through $.store; the lead messages it over
//    cross-session messaging and answers its approvals through $.store.

import {
  PALETTE, MODES, MODELS, EFFORTS, APPROVALS, BUILTIN_AGENTS, EDIT_TOOLS,
  colorName, pickColor, labelOf, suggestName, validateName, fmtTokens, emptyTokens,
  addUsage, totalTokens, clip, summarizeTool, describeCall, baseName, decide, statusView,
  isLive, launchScript, launchCandidates, WORKER_SETTINGS, focusArgv, parseAgentFile, findConflicts, randomId,
  selfPidArgv, parsePidLine, pidNameArgv, killArgv, RESTART_MAX, restartDelayMs, needsRestart, restartTask,
  rosterEntry, rosterKey, lastRosterKey, planRoster, validRosterName, modelAlias,
} from './lib.js'

const MAIN = 'swarm'
const WIZARD = 'swarm-spawn'
const DETAIL = 'swarm-a-'
const ROSTERS = 'swarm-rosters'
const STATUS_TOOL = 'swarm_status'
const TEAMMATE_HOLD_MS = 15 * 60 * 1000 // then the normal permission prompt
const WORKER_HOLD_MS = 3 * 60 * 1000 // then the worker's own prompt
const STALE_MS = 20000
const LAUNCH_TIMEOUT_MS = 90000
const LOG_MAX = 40
const NAMES = ['scout', 'forge', 'atlas', 'echo', 'nova', 'pixel', 'rook', 'sage', 'vega', 'zephyr', 'orion', 'quill']

// ---- lead state (module variables; snapshot kept in $.state across reloads) ----
let agents = {} // key -> agent record
let order = [] // keys, spawn order
let platform = null // 'windows' | 'mac' | 'linux'
let homeDir = ''
let leadId = ''
let callInfo = {} // tool_use_id -> { key, tool, input, workerMain }
let decisions = {} // reqId -> decision, for holds in this process
let agentTypes = {} // agent type -> description
let draft = null // the spawn form
let wizardError = ''
let openPick = null // the spawn-form field whose option list is open
let qDraft = {} // reqId -> { [question]: answer }
let bandOn = true
let expanded = {}
let snapshotDirty = false
let ticking = false
let seenAttention = {}
let seenConflicts = {}
let conflicts = []
let killArmed = false // kill-all asks for a second press
let rosterList = [] // saved rosters, loaded when the roster pane opens
let rosterNameDraft = ''
let rosterError = ''
let lastRoster = null // this workspace's last swarm, offered after a restart of Claude Code
let lastSavedSig = ''

// ---- worker state (only when this session was launched by a lead) ----
let worker = null // { id, lead, name, approval }
let w = null // what the worker reports
let wDirty = false
let wLastFlush = 0
let wSeenAbort = 0

// ======================= helpers that take $ =======================

async function detectPlatform($) {
  if (platform) return platform
  let isWin = false
  try {
    const cwd = await $.session.cwd()
    isWin = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\')
  } catch {}
  if (!isWin) {
    try {
      isWin = (await $.env.get('OS')) === 'Windows_NT'
    } catch {}
  }
  if (isWin) {
    platform = 'windows'
  } else {
    platform = 'linux'
    try {
      const r = await $.process.run(['uname', '-s'], { timeoutMs: 5000 })
      if (String(r.stdout).trim() === 'Darwin') platform = 'mac'
    } catch {}
  }
  return platform
}

function sep() {
  return platform === 'windows' ? '\\' : '/'
}

async function toast($, text) {
  try {
    await $.ui.toast(text)
  } catch {}
}

function changed($) {
  snapshotDirty = true
  $.ui.invalidate('ui.render')
}

async function persist($) {
  if (!snapshotDirty) return
  snapshotDirty = false
  try {
    await $.state.set({ plugin: 'swarm-mod', key: 'snapshot' }, { agents, order })
  } catch {}
}

async function restore($) {
  try {
    const { value } = await $.state.get({ plugin: 'swarm-mod', key: 'snapshot' })
    if (value && Array.isArray(value.order) && value.agents) {
      agents = { ...value.agents }
      order = value.order.filter((k) => agents[k])
    }
  } catch {}
}

// Waits about a second without a timer (hook budgets exclude time in $ calls)
async function waitTick($) {
  const argv = platform === 'windows' ? ['ping', '-n', '2', '127.0.0.1'] : ['sleep', '1']
  try {
    await $.process.run(argv, { timeoutMs: 5000 })
  } catch {
    await $.clock.sleep(250)
  }
}

function pushLog(a, text, now) {
  a.log = [...(a.log || []), { t: now, text: clip(text, 160) }].slice(-LOG_MAX)
}

function addFile(a, path) {
  if (!path) return
  const files = a.files || []
  if (!files.includes(path)) a.files = [...files, path].slice(-200)
}

function keyOfAgentId(agentId) {
  if (!agentId) return null
  for (const k of order) if (agents[k] && agents[k].agentId === agentId) return k
  return null
}

// Matches a loop id to a teammate whose spawn has not resolved yet
async function resolveKey($, agentId) {
  const k = keyOfAgentId(agentId)
  if (k || !agentId) return k
  const waiting = order.filter((x) => agents[x].transport === 'teammate' && !agents[x].agentId && agents[x].status === 'pending')
  if (!waiting.length) return null
  try {
    const list = await $.agent.list()
    const hit = list.find((x) => x.id === agentId)
    if (!hit) return null
    const kk = waiting.find((x) => agents[x].name === hit.name || String(hit.teammateId || '').startsWith(agents[x].name + '@'))
    if (kk) {
      agents[kk].agentId = agentId
      return kk
    }
  } catch {}
  return null
}

function liveColors(exceptKey) {
  return order.filter((k) => k !== exceptKey && isLive(agents[k])).map((k) => agents[k].color)
}

// ======================= worker side =======================

async function workerBoot($) {
  w = {
    status: 'idle', activity: '', tokens: emptyTokens(), ctx: 0, turns: 0, pending: null,
    log: [], files: [], lastAnswer: '', turnId: '', sessionId: '', startedAt: (await $.clock.now()),
  }
  try {
    w.sessionId = await $.session.id()
  } catch {}
  try {
    const r = await $.store.get('r:' + worker.id)
    wSeenAbort = (r && r.abortSeq) || 0
  } catch {}
  await workerFlush($)
  try {
    await $.ui.status('swarm worker "' + worker.name + '" · reporting to the lead session')
  } catch {}
  // this session's own pid, so the lead can end it (kill, or restart when it hangs)
  try {
    const r = await $.process.run(selfPidArgv(await detectPlatform($)), { timeoutMs: 20000 })
    const p = parsePidLine(r.stdout)
    if (p) {
      w.pid = p.pid
      w.pidName = p.name
      await workerFlush($)
    }
  } catch {}
}

// The worker's first task, given in the spawn form
async function submitTask($, text) {
  try {
    await $.prompt.submit({ text })
  } catch (err) {
    $.ui.log('swarm: could not submit the first task: ' + (err && err.message), { to: 'debug' })
  }
}

async function workerFlush($) {
  if (!worker || !w) return
  wDirty = false
  wLastFlush = (await $.clock.now())
  try {
    await $.store.set('w:' + worker.id, { ...w, name: worker.name, heartbeat: wLastFlush })
  } catch {}
}

function workerLog(text, now) {
  if (!w) return
  w.log = [...w.log, { t: now, text: clip(text, 160) }].slice(-LOG_MAX)
  wDirty = true
}

async function workerTick($) {
  let r = null
  try {
    r = await $.store.get('r:' + worker.id)
  } catch {}
  if (r && r.abortSeq && r.abortSeq > wSeenAbort) {
    wSeenAbort = r.abortSeq
    if (w.turnId && w.status === 'working') {
      try {
        await $.turn.abort({ turnId: w.turnId })
        workerLog('interrupted by the lead', (await $.clock.now()))
      } catch {}
    }
  }
  if (r && r.killed && w.status !== 'killed') {
    // the lead killed this agent but could not end the process itself
    w.status = 'killed'
    w.pending = null
    await workerFlush($)
    if (w.pid) {
      try {
        await $.process.run(killArgv(await detectPlatform($), w.pid), { timeoutMs: 15000 })
      } catch {}
    }
    return
  }
  if (wDirty || (await $.clock.now()) - wLastFlush > 5000) await workerFlush($)
}

// ======================= lead side: polling =======================

function mergeReport(a, rep) {
  const fields = ['status', 'activity', 'tokens', 'ctx', 'turns', 'log', 'files', 'lastAnswer', 'sessionId', 'heartbeat', 'pid', 'pidName', 'exitReason']
  for (const f of fields) if (rep[f] !== undefined) a[f] = rep[f]
  a.unresponsiveSince = null
  a.pending = rep.pending && rep.pending.reqId !== a.resolvedReq ? rep.pending : null
}

async function leadTick($) {
  let dirty = false
  const now = (await $.clock.now())

  if (order.some((k) => agents[k].transport === 'teammate' && isLive(agents[k]))) {
    let list = null
    try {
      list = await $.agent.list()
    } catch {}
    if (list) {
      for (const k of order) {
        const a = agents[k]
        if (a.transport !== 'teammate' || a.agentId || a.status !== 'pending') continue
        const hit = list.find((x) => x.name === a.name || String(x.teammateId || '').startsWith(a.name + '@'))
        if (hit) {
          a.agentId = hit.id
          dirty = true
        }
      }
      for (const k of order) {
        const a = agents[k]
        if (a.transport !== 'teammate' || !a.agentId || !isLive(a)) continue
        const hit = list.find((x) => x.id === a.agentId)
        const status = hit ? hit.status : 'completed'
        if (hit && hit.teammateId && a.teammateId !== hit.teammateId) {
          a.teammateId = hit.teammateId
          dirty = true
        }
        if (status !== a.status) {
          a.status = status
          if (status === 'failed') await toast($, a.name + ' failed')
          dirty = true
        }
      }
    }
  }

  for (const k of order) {
    const a = agents[k]
    if (a.transport !== 'session' || a.killedByUser || a.restartAt || (['exited', 'failed'].includes(a.status) && !a.heartbeat)) continue
    let rep = null
    try {
      rep = await $.store.get('w:' + k)
    } catch {}
    if (rep && rep.heartbeat) {
      if (rep.heartbeat !== a.heartbeat) {
        mergeReport(a, rep)
        dirty = true
      } else if (isLive(a) && a.status !== 'unresponsive' && now - rep.heartbeat > STALE_MS) {
        a.status = 'unresponsive'
        a.unresponsiveSince = now
        dirty = true
      }
    } else if (a.status === 'launching' && now - a.startedAt > LAUNCH_TIMEOUT_MS) {
      fail(a, 'No report from the new session. Is `claude` on PATH there? Script: ' + (a.script || '?'))
      dirty = true
    }
  }

  for (const k of order) {
    const a = agents[k]
    if (a.pending && seenAttention[k] !== a.pending.reqId) {
      seenAttention[k] = a.pending.reqId
      await toast($, a.name + (a.pending.kind === 'approval' ? ' needs approval' : ' has a question') + ' · open the swarm pane')
    }
  }

  conflicts = findConflicts(order.map((k) => agents[k]), platform !== 'linux')
  for (const c of conflicts) {
    const id = c.path + '|' + c.keys.join(',')
    if (!seenConflicts[id]) {
      seenConflicts[id] = true
      await toast($, '▲ ' + c.keys.map((k) => agents[k].name).join(' & ') + ' both edited ' + baseName(c.path))
      dirty = true
    }
  }

  // auto-restart: wait the backoff, then bring it back with the same settings
  for (const k of [...order]) {
    const a = agents[k]
    if (!a) continue
    if (!needsRestart(a, now)) {
      if (a.restartAt) {
        a.restartAt = null
        dirty = true
      }
      continue
    }
    if (!a.restartAt) {
      const delay = restartDelayMs(a.restarts || 0)
      a.restartAt = now + delay
      a.activity = 'restarting in ' + Math.round(delay / 1000) + 's (' + ((a.restarts || 0) + 1) + '/' + RESTART_MAX + ')'
      await toast($, a.name + ' ' + (a.status === 'unresponsive' ? 'stopped responding' : a.status) + ' · auto-restart in ' + Math.round(delay / 1000) + 's')
      dirty = true
      continue
    }
    if (now >= a.restartAt) {
      await restartAgent($, k)
      dirty = true
    }
  }

  if (dirty) changed($)
}

async function tick($) {
  if (ticking) return
  ticking = true
  try {
    if (worker && w) await workerTick($)
    if (order.length) await leadTick($)
    await persist($)
    await saveLastRoster($)
  } finally {
    ticking = false
  }
}

// ======================= kill, restart =======================

// Ends a separate session's process, after checking its pid still names the same program
async function killPid($, a) {
  if (!a.pid) return false
  const os = await detectPlatform($)
  try {
    const r = await $.process.run(pidNameArgv(os, a.pid), { timeoutMs: 15000 })
    const name = baseName(String(r.stdout || '').trim())
    if (!name || (a.pidName && name.toLowerCase() !== String(a.pidName).toLowerCase())) return false
    const k = await $.process.run(killArgv(os, a.pid), { timeoutMs: 15000 })
    return k.exitCode === 0
  } catch {
    return false
  }
}

async function killAgent($, key) {
  const a = agents[key]
  if (!a) return false
  const wasLive = isLive(a) || !!a.restartAt
  a.killedByUser = true
  a.restartAt = null
  // release a request it is holding, so nothing waits on a dead agent
  if (a.pending) {
    decisions[a.pending.reqId] = { decision: 'deny' }
    a.pending = null
  }
  if (a.transport === 'teammate') {
    if (isLive(a)) {
      try {
        await $.tool.call({ tool: 'TaskStop', task_id: a.teammateId || a.name })
      } catch (err) {
        $.ui.log('swarm: TaskStop ' + a.name + ': ' + (err && err.message), { to: 'debug' })
      }
    }
  } else {
    let cur = null
    try {
      cur = await $.store.get('r:' + key)
    } catch {}
    try {
      await $.store.set('r:' + key, { ...(cur || { decisions: {}, abortSeq: 0 }), killed: true })
    } catch {}
    const ended = await killPid($, a)
    pushLog(a, ended ? 'process ' + a.pid + ' ended' : 'asked the session to end itself', await $.clock.now())
  }
  a.status = 'killed'
  a.activity = ''
  pushLog(a, '■ killed by you', await $.clock.now())
  changed($)
  return wasLive
}

async function killAll($) {
  killArmed = false
  let n = 0
  for (const k of [...order]) if (agents[k] && (await killAgent($, k))) n++
  await toast($, 'Killed ' + n + ' agent' + (n === 1 ? '' : 's'))
  changed($)
  return n
}

async function restartAgent($, key, manual) {
  const a = agents[key]
  if (!a) return
  a.restartAt = null
  if (manual) {
    a.killedByUser = false
    a.restarts = 0
    pushLog(a, '↻ respawned by you', await $.clock.now())
  } else {
    a.restarts = (a.restarts || 0) + 1
    pushLog(a, '↻ auto-restart ' + a.restarts + '/' + RESTART_MAX, await $.clock.now())
  }
  a.pending = null
  a.error = ''
  if (a.transport === 'session') {
    if (a.status === 'unresponsive' || (manual && isLive(a))) await killPid($, a)
    try {
      await $.store.delete('w:' + key)
    } catch {}
    a.heartbeat = null
    a.unresponsiveSince = null
    a.exitReason = null
    a.pid = null
    a.pidName = null
    a.sessionId = ''
    a.status = 'launching'
    a.startedAt = await $.clock.now()
    await launchWorker($, a, manual ? a.task : restartTask(a.task))
  } else {
    a.agentId = null
    a.teammateId = null
    a.status = 'pending'
    await spawnTeammate($, a, manual ? a.task : restartTask(a.task))
  }
  await toast($, a.name + (manual ? ' respawned' : ' restarted (' + a.restarts + '/' + RESTART_MAX + ')'))
  changed($)
}

// ======================= saved rosters =======================

function currentRoster() {
  return order.map((k) => rosterEntry(agents[k]))
}

// Keeps this workspace's latest swarm, offered again when Claude Code restarts here
async function saveLastRoster($) {
  if (worker || !order.length) return
  const entries = currentRoster()
  const sig = JSON.stringify(entries)
  if (sig === lastSavedSig) return
  lastSavedSig = sig
  try {
    const cwd = await $.session.cwd()
    await $.store.set(lastRosterKey(cwd, platform !== 'linux'), { cwd, savedAt: await $.clock.now(), agents: entries })
  } catch {}
}

async function loadRosters($) {
  const list = []
  let keys = []
  try {
    keys = await $.store.keys()
  } catch {}
  for (const key of keys) {
    if (!key.startsWith('roster:')) continue
    try {
      const v = await $.store.get(key)
      if (v && Array.isArray(v.agents)) list.push({ ...v, key, name: key.slice('roster:'.length) })
    } catch {}
  }
  rosterList = list.sort((x, y) => (y.savedAt || 0) - (x.savedAt || 0))
  return rosterList
}

async function saveRoster($, rawName) {
  const name = String(rawName || '').trim()
  if (!validRosterName(name)) {
    rosterError = 'Roster name: 1-40 letters, digits, spaces, . _ or -'
    $.ui.invalidate('ui.render')
    return false
  }
  if (!order.length) {
    rosterError = 'The swarm is empty; spawn agents first'
    $.ui.invalidate('ui.render')
    return false
  }
  let cwd = ''
  try {
    cwd = await $.session.cwd()
  } catch {}
  await loadRosters($)
  const existed = rosterList.some((r) => r.name === name)
  await $.store.set(rosterKey(name), { cwd, savedAt: await $.clock.now(), agents: currentRoster() })
  rosterError = ''
  rosterNameDraft = ''
  await loadRosters($)
  await toast($, (existed ? 'Updated' : 'Saved') + ' roster "' + name + '" (' + order.length + ' agents)')
  $.ui.invalidate('ui.render')
  return true
}

async function deleteRoster($, name) {
  try {
    await $.store.delete(rosterKey(name))
  } catch {}
  await loadRosters($)
  $.ui.invalidate('ui.render')
}

// Spawns every agent of a roster into this workspace, with free names and colors
async function launchRoster($, entries, label) {
  const plan = planRoster(entries || [], order.map((k) => agents[k].name), liveColors())
  lastRoster = null
  try {
    await $.ui.open({ id: MAIN, title: 'Swarm' })
  } catch {}
  for (const e of plan) await spawnSpec($, e)
  await toast($, 'Spawned ' + plan.length + ' agent' + (plan.length === 1 ? '' : 's') + (label ? ' from "' + label + '"' : ''))
  return plan.length
}

async function openRosters($) {
  await loadRosters($)
  rosterError = ''
  let cwd = ''
  try {
    cwd = await $.session.cwd()
  } catch {}
  if (!rosterNameDraft) rosterNameDraft = baseName(String(cwd).replace(/[\\/]+$/, '')) || 'my swarm'
  await $.ui.open({ id: ROSTERS, title: 'Rosters', focus: true, closeOnEscape: true })
}

// ======================= holds (approvals and questions) =======================

async function setPending($, key, pending) {
  if (key) {
    const a = agents[key]
    a.pending = pending
    pushLog(a, (pending.kind === 'approval' ? '! approval: ' + pending.summary : '? question'), (await $.clock.now()))
    if (seenAttention[key] !== pending.reqId) {
      seenAttention[key] = pending.reqId
      await toast($, a.name + (pending.kind === 'approval' ? ' needs approval' : ' has a question') + ' · open the swarm pane')
    }
    changed($)
  } else if (w) {
    w.pending = pending
    workerLog(pending.kind === 'approval' ? '! approval: ' + pending.summary : '? question', (await $.clock.now()))
    await workerFlush($)
    try {
      await $.ui.status('swarm: waiting for the lead to ' + (pending.kind === 'approval' ? 'approve ' + pending.summary : 'answer a question') + ' (falls back to the prompt here)')
    } catch {}
  }
}

async function clearPending($, key, reqId) {
  if (key) {
    if (agents[key] && agents[key].pending && agents[key].pending.reqId === reqId) agents[key].pending = null
    changed($)
  } else if (w) {
    if (w.pending && w.pending.reqId === reqId) w.pending = null
    await workerFlush($)
    try {
      await $.ui.status('swarm worker "' + worker.name + '" · reporting to the lead session')
    } catch {}
  }
}

// Waits for a decision from the pane (this process) or the lead (worker); null on timeout
async function holdFor($, reqId, ms, signal) {
  const until = (await $.clock.now()) + ms
  while ((await $.clock.now()) < until) {
    if (signal && signal.aborted) return null
    if (decisions[reqId]) {
      const d = decisions[reqId]
      delete decisions[reqId]
      return d
    }
    if (worker) {
      let r = null
      try {
        r = await $.store.get('r:' + worker.id)
      } catch {}
      const d = r && r.decisions && r.decisions[reqId]
      if (d) return d
    }
    await waitTick($)
  }
  return null
}

async function holdQuestion($, key, e, signal) {
  const reqId = randomId()
  const questions = (e.questions || []).map((q) => ({
    question: q.question,
    header: q.header || '',
    multiSelect: !!q.multiSelect,
    options: (q.options || []).map((o) => ({ label: o.label, description: o.description || '' })),
  }))
  await setPending($, key, { kind: 'question', reqId, tool: 'AskUserQuestion', summary: clip(questions[0] && questions[0].question, 60), questions, since: (await $.clock.now()) })
  const d = await holdFor($, reqId, key ? TEAMMATE_HOLD_MS : WORKER_HOLD_MS, signal)
  await clearPending($, key, reqId)
  if (!d || !d.answers) return null
  return { questions: e.questions, answers: d.answers }
}

// The lead resolves an agent's pending request
async function resolvePending($, key, decision) {
  const a = agents[key]
  const p = a && a.pending
  if (!p) return
  if (a.transport === 'session') {
    let cur = null
    try {
      cur = await $.store.get('r:' + key)
    } catch {}
    cur = cur || { decisions: {}, abortSeq: 0 }
    const kept = Object.entries(cur.decisions || {}).slice(-20)
    await $.store.set('r:' + key, { ...cur, decisions: { ...Object.fromEntries(kept), [p.reqId]: decision } })
  } else {
    decisions[p.reqId] = decision
  }
  a.resolvedReq = p.reqId
  a.pending = null
  delete qDraft[p.reqId]
  const what = decision.answers ? 'answered' : decision.decision === 'allow' ? 'approved' : decision.decision === 'deny' ? 'denied' : 'sent to its own prompt'
  pushLog(a, 'you ' + what + ': ' + p.summary, (await $.clock.now()))
  changed($)
}

// ======================= spawning =======================

async function scanAgentFiles($) {
  const dirs = ['.claude' + sep() + 'agents']
  if (homeDir) dirs.unshift(homeDir + sep() + '.claude' + sep() + 'agents')
  for (const d of dirs) {
    let entries = []
    try {
      entries = await $.fs.list(d)
    } catch {
      continue
    }
    for (const ent of entries.slice(0, 80)) {
      if (ent.kind === 'directory' || !/\.md$/i.test(ent.name)) continue
      try {
        const parsed = parseAgentFile(await $.fs.read(d + sep() + ent.name))
        if (parsed && !agentTypes[parsed.name]) agentTypes[parsed.name] = parsed.description
      } catch {}
    }
  }
}

async function openWizard($) {
  await scanAgentFiles($)
  const taken = order.map((k) => agents[k].name)
  let teamsOn = false
  try {
    teamsOn = (await $.env.get('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS')) === '1'
  } catch {}
  let cwd = ''
  try {
    cwd = await $.session.cwd()
  } catch {}
  draft = {
    mode: 'teammate',
    agentType: 'default',
    model: 'inherit',
    effort: 'default',
    approval: 'default',
    name: suggestName(NAMES.find((n) => !taken.map((t) => t.toLowerCase()).includes(n)) || 'agent', taken),
    color: pickColor(liveColors()),
    task: '',
    teamsOn,
    autoRestart: false,
    cwd,
  }
  wizardError = ''
  openPick = null
  await $.ui.open({ id: WIZARD, title: 'Spawn agent', focus: true, closeOnEscape: true, rows: 36 })
}

async function spawnTeammate($, a, taskOverride) {
  let cwd = ''
  try {
    cwd = await $.session.cwd()
  } catch {}
  const prompt = (taskOverride || a.task || '').trim() ||
    'You are "' + a.name + '", a member of the user\'s agent swarm, working in ' + cwd + '. Introduce yourself in one line, then wait for instructions.'
  const args = { prompt, description: 'swarm: ' + a.name, name: a.name }
  if (a.agentType && a.agentType !== 'default') args.subagentType = a.agentType
  const alias = a.model && a.model !== 'inherit' ? modelAlias(a.model) : ''
  if (alias) args.model = alias
  let r
  try {
    r = await $.agent.spawn(args)
  } catch (err) {
    fail(a, 'Spawn failed: ' + String((err && err.message) || err))
    await toast($, a.activity)
    return
  }
  if (!r || r.deny) {
    fail(a, 'Spawn refused: ' + String((r && r.deny) || 'no answer from the agent spawner'))
    await toast($, a.activity)
    return
  }
  a.agentId = r.agentId
  a.teammateId = r.teammateId
  a.resolvedModel = r.model
  if (r.teammateId) a.name = String(r.teammateId).split('@')[0] || a.name
  // without an id yet, it stays pending and is matched by name from $.agent.list()
  if (a.agentId && a.status === 'pending') a.status = 'running'
  a.activity = ''
  pushLog(a, r.teammateId ? 'joined the team as ' + r.teammateId : 'started as a named background agent', (await $.clock.now()))
}

async function launchWorker($, a, taskOverride) {
  const os = await detectPlatform($)
  let cwd = ''
  try {
    cwd = await $.session.cwd()
  } catch {}
  if (!homeDir) {
    fail(a, 'Could not find the home directory to write the launch script')
    return
  }
  const s = sep()
  const dir = homeDir + s + '.claude' + s + 'swarm-mod' + s + 'launch' + s
  const script = dir + a.key + (os === 'windows' ? '.ps1' : os === 'mac' ? '.command' : '.sh')
  const settingsPath = dir + 'worker-settings.json'
  const ttyPath = os === 'windows' ? '' : dir + a.key + '.tty'
  const spec = {
    id: a.key, lead: leadId, name: a.name, cwd, pluginRoot: $.plugin.root, settingsPath, ttyPath,
    agentType: a.agentType, model: a.model, effort: a.effort, approval: a.approval, task: taskOverride || a.task,
  }
  a.script = script
  a.ttyPath = ttyPath
  let iterm = false
  if (os === 'mac') {
    try {
      iterm = (await $.env.get('TERM_PROGRAM')) === 'iTerm.app'
    } catch {}
  }
  try {
    await $.fs.write(settingsPath, WORKER_SETTINGS)
    await $.fs.write(script, launchScript(os === 'windows' ? 'windows' : 'posix', spec))
    await $.store.set('r:' + a.key, { decisions: {}, abortSeq: 0 })
  } catch (err) {
    fail(a, 'Could not write the launch script: ' + String((err && err.message) || err))
    return
  }
  if (os !== 'windows') {
    try {
      await $.process.run(['chmod', '+x', script], { timeoutMs: 5000 })
    } catch {}
  }
  let lastErr = ''
  for (const { argv, app } of launchCandidates(os, script, spec, { iterm })) {
    try {
      const r = await $.process.run(argv, { cwd, timeoutMs: 15000 })
      if (r.exitCode === 0) {
        a.termApp = app
        pushLog(a, 'launched in a new ' + app + ' window', (await $.clock.now()))
        a.activity = 'waiting for the session to start…'
        return
      }
      lastErr = String(r.stderr || r.stdout || 'exit ' + r.exitCode).trim()
    } catch (err) {
      lastErr = String(err && err.message)
    }
  }
  fail(a, 'Could not open a terminal (' + String(lastErr) + '). Run it yourself: ' + script)
}

async function spawnFromDraft($) {
  const d = draft
  if (!d) return
  const taken = order.map((k) => agents[k].name)
  const name = String(d.name || '').trim()
  const err = validateName(name, taken)
  if (err) {
    wizardError = err
    $.ui.invalidate('ui.render')
    return
  }
  if (liveColors().includes(d.color) && liveColors().length < PALETTE.length) {
    wizardError = 'That color is in use; pick another'
    $.ui.invalidate('ui.render')
    return
  }
  draft = null
  try {
    await $.ui.close({ id: WIZARD })
  } catch {}
  try {
    await $.ui.open({ id: MAIN, title: 'Swarm' })
  } catch {}
  await spawnSpec($, {
    name, color: d.color, agentType: d.agentType, model: d.model, effort: d.effort, approval: d.approval,
    transport: d.mode, task: d.task || '', autoRestart: !!d.autoRestart,
  })
}

// Adds one agent to the swarm and starts it: from the form, a roster, or a restore
async function spawnSpec($, spec) {
  const key = randomId()
  const transport = spec.transport === 'session' ? 'session' : 'teammate'
  const a = {
    key, name: spec.name, color: spec.color, agentType: spec.agentType || 'default', model: spec.model || 'inherit',
    effort: spec.effort || 'default', approval: spec.approval || 'default', transport,
    autoRestart: !!spec.autoRestart, restarts: 0,
    status: transport === 'session' ? 'launching' : 'pending', activity: 'spawning…',
    tokens: emptyTokens(), ctx: 0, turns: 0, pending: null, log: [], files: [], lastAnswer: '',
    startedAt: await $.clock.now(), task: spec.task || '',
  }
  agents[key] = a
  order = [...order, key]
  lastRoster = null
  changed($)
  if (transport === 'teammate') await spawnTeammate($, a)
  else await launchWorker($, a)
  changed($)
  return key
}

// ======================= actions on an agent =======================

// Marks an agent failed: the whole error is kept for copying, a short line is shown
function fail(a, text) {
  a.status = 'failed'
  a.error = String(text)
  a.activity = clip(a.error, 140)
}

// Copies an agent's whole error (not the clipped line) to the clipboard of the surface pressed on
async function copyError($, key, press) {
  const a = agents[key]
  if (!a) return
  const text = a.error || a.activity || ''
  if (!text) return toast($, a.name + ' has no error text to copy')
  let r
  try {
    r = await $.ui.copy({ text, ...(press && press.surface ? { surface: press.surface } : {}) })
  } catch (err) {
    r = { isCopied: false, reason: err && err.message }
  }
  await toast($, r.isCopied ? 'Copied ' + a.name + "'s error (" + text.length + ' chars)' : 'Could not copy the error: ' + r.reason)
}

async function sendTo($, key, text) {
  const a = agents[key]
  const t = String(text || '').trim()
  if (!a || !t) return false
  let to = null
  if (a.transport === 'session') {
    if (!a.sessionId) {
      await toast($, a.name + ' has not reported its session yet')
      return false
    }
    to = { sessionId: a.sessionId }
  } else if (a.agentId) {
    to = { agentId: a.agentId }
  }
  if (!to) return false
  try {
    let r = await $.session.send({ to, text: t })
    if (!r.isDelivered && a.transport === 'teammate') r = await $.session.send({ to: a.name, text: t })
    if (r.isDelivered) {
      pushLog(a, '→ you: ' + t, (await $.clock.now()))
      changed($)
      return true
    }
    await toast($, 'Not delivered to ' + a.name + ': ' + r.reason)
  } catch (err) {
    await toast($, 'Not delivered to ' + a.name + ': ' + (err && err.message))
  }
  return false
}

async function broadcast($, text) {
  let n = 0
  for (const k of order) if (isLive(agents[k]) && (await sendTo($, k, text))) n++
  await toast($, 'Broadcast reached ' + n + ' agent' + (n === 1 ? '' : 's'))
}

async function stopAgent($, key) {
  const a = agents[key]
  if (!a) return
  if (a.transport === 'session') {
    let cur = null
    try {
      cur = await $.store.get('r:' + key)
    } catch {}
    cur = cur || { decisions: {}, abortSeq: 0 }
    await $.store.set('r:' + key, { ...cur, abortSeq: (cur.abortSeq || 0) + 1 })
    pushLog(a, 'interrupt requested', (await $.clock.now()))
  } else {
    try {
      await $.tool.call({ tool: 'TaskStop', task_id: a.teammateId || a.name })
      pushLog(a, 'stop requested', (await $.clock.now()))
    } catch (err) {
      await toast($, 'Could not stop ' + a.name + ': ' + (err && err.message))
    }
  }
  changed($)
}

async function focusWindow($, key) {
  const a = agents[key]
  if (!a) return
  const os = await detectPlatform($)
  let tty = ''
  if (a.ttyPath) {
    try {
      tty = String(await $.fs.read(a.ttyPath)).trim()
    } catch {}
  }
  try {
    const r = await $.process.run(focusArgv(os, a.name, { tty: /^\/dev\//.test(tty) ? tty : '', app: a.termApp }), { timeoutMs: 10000 })
    if (r.exitCode !== 0) throw new Error(String(r.stderr || 'exit ' + r.exitCode).trim())
  } catch (err) {
    const hint = os === 'mac' ? ' (allow Automation for your terminal in System Settings > Privacy & Security)' : ''
    await toast($, 'Could not bring ' + a.name + ' forward' + hint + '; look for its "' + a.name + '" window or tab')
  }
}

async function removeAgent($, key) {
  const a = agents[key]
  if (!a) return
  delete agents[key]
  order = order.filter((k) => k !== key)
  try {
    await $.store.delete('w:' + key)
    await $.store.delete('r:' + key)
  } catch {}
  try {
    await $.ui.close({ id: DETAIL + key })
  } catch {}
  changed($)
}

async function openDetail($, key) {
  const a = agents[key]
  if (!a) return
  await $.ui.open({
    id: DETAIL + key,
    title: a.name,
    focus: true,
    closeOnEscape: true,
    ...(expanded[key] ? { rows: 40, columns: 110 } : {}),
  })
}

function statusText() {
  if (!order.length) return 'The swarm is empty. The user spawns agents from the swarm pane (/swarm).'
  return order
    .map((k) => {
      const a = agents[k]
      const sv = statusView(a)
      return [
        a.name + ' (' + a.transport + ', ' + a.agentType + ', ' + labelOf(MODELS, a.model) + ', effort ' + a.effort + ', approval ' + a.approval + ')',
        'status: ' + sv.word + (a.activity ? ' - ' + a.activity : ''),
        'tokens: ' + fmtTokens(totalTokens(a.tokens)) + ', turns: ' + (a.turns || 0) + (a.autoRestart ? ', auto-restart on (' + (a.restarts || 0) + '/' + RESTART_MAX + ' used)' : ''),
        a.pending ? 'waiting on the user: ' + a.pending.summary : '',
        a.lastAnswer ? 'last answer: ' + clip(a.lastAnswer, 300) : '',
      ].filter(Boolean).join('\n  ')
    })
    .join('\n')
}

// ======================= drawing =======================

function counts() {
  const list = order.map((k) => agents[k])
  return {
    list,
    working: list.filter((a) => ['running', 'working'].includes(a.status)).length,
    attention: list.filter((a) => a.pending).length,
    total: list.reduce((s, a) => s + totalTokens(a.tokens), 0),
  }
}

function renderMain($, e) {
  const { Box, Text, Button, Input } = $.ui.resolve(e)
  const { list, working, attention, total } = counts()
  const rows = []
  rows.push(
    Box({
      key: 'head',
      flexDirection: 'row',
      columnGap: 1,
      children: [
        Text({ bold: true, color: '#c678dd', children: ['SWARM'] }),
        Text({ dimColor: true, children: [list.length + ' agents · ' + working + ' working'] }),
        ...(attention ? [Text({ bold: true, color: '#ff5555', children: ['· ' + attention + ' need you'] })] : []),
      ],
    }),
  )
  const liveCount = list.filter((a) => isLive(a) || a.restartAt).length
  rows.push(
    Box({
      key: 'toolbar',
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Button({ key: 'spawn', label: 'n: + Spawn agent', hotkey: 'n', onPress: () => openWizard($) }),
        Button({ key: 'rosters', label: 'Rosters', hotkey: 'r', plain: true, onPress: () => openRosters($) }),
        ...(liveCount
          ? [Button({
              key: 'kill-all',
              label: killArmed ? 'k: Press again to kill ' + liveCount : 'Kill all',
              hotkey: 'k',
              ...(killArmed ? {} : { plain: true }),
              onPress: async () => {
                if (!killArmed) {
                  killArmed = true
                  $.ui.invalidate('ui.render')
                  $.clock.after(6000, () => {
                    killArmed = false
                    $.ui.invalidate('ui.render')
                  })
                  return
                }
                await killAll($)
              },
            })]
          : []),
      ],
    }),
  )
  if (lastRoster && lastRoster.agents && lastRoster.agents.length) {
    rows.push(
      Button({
        key: 'restore-last',
        label: 'Restore last swarm here (' + lastRoster.agents.length + ' agents: ' + clip(lastRoster.agents.map((x) => x.name).join(', '), 50) + ')',
        onPress: () => launchRoster($, lastRoster.agents, 'last swarm'),
      }),
    )
  }
  if (!list.length) {
    rows.push(Text({ dimColor: true, children: ['No agents yet. Spawn one, or launch a saved roster (r).'] }))
  }
  for (const a of list) {
    const sv = statusView(a)
    rows.push(
      Box({
        key: 'row-' + a.key,
        flexDirection: 'column',
        children: [
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Text({ color: a.color, children: ['●'] }),
              Button({ key: 'open-' + a.key, label: a.name, plain: true, onPress: () => openDetail($, a.key) }),
              a.status === 'failed'
                ? Button({ key: 'err-' + a.key, label: sv.glyph + ' ' + sv.word + ' · copy error', plain: true, onPress: async (press) => { await copyError($, a.key, press); await openDetail($, a.key) } })
                : Text({ color: sv.color, bold: !!sv.bold, children: [sv.glyph + ' ' + sv.word] }),
              ...(a.pending
                ? [Button({ key: 'attn-' + a.key, label: a.pending.kind === 'approval' ? '! review' : '? answer', onPress: () => openDetail($, a.key) })]
                : []),
            ],
          }),
          Text({
            dimColor: true,
            wrap: 'truncate-end',
            children: ['  ' + (a.activity || (a.transport === 'session' ? 'own window' : 'teammate')) + ' · ' + fmtTokens(totalTokens(a.tokens)) + ' tok' + (a.autoRestart ? ' · ↻' + (a.restarts ? ' ' + a.restarts + '/' + RESTART_MAX : '') : '')],
          }),
        ],
      }),
    )
  }
  for (const c of conflicts) {
    rows.push(Text({ key: 'conf-' + c.path, color: '#e5c07b', wrap: 'truncate-end', children: ['▲ ' + c.keys.map((k) => (agents[k] ? agents[k].name : k)).join(' & ') + ' both edited ' + baseName(c.path)] }))
  }
  if (list.length) {
    rows.push(Text({ dimColor: true, children: ['total ' + fmtTokens(total) + ' tokens'] }))
    rows.push(
      Input({
        key: 'broadcast',
        label: 'Broadcast',
        placeholder: 'message every live agent',
        value: '',
        submitLabel: 'send',
        onSubmit: (v) => broadcast($, v),
      }),
    )
    if (list.some((a) => !isLive(a))) {
      rows.push(
        Button({
          key: 'clear-done',
          label: 'Clear finished',
          hotkey: 'x',
          plain: true,
          onPress: async () => {
            for (const a of list) if (!isLive(a)) await removeAgent($, a.key)
          },
        }),
      )
    }
  }
  return Box({ flexDirection: 'column', gap: 0, children: rows })
}

// One spawn-form field as a dropdown built from Buttons, so a click works as well as Enter:
// pressing the field opens its options; pressing an option picks it, closes the list and
// moves the focus to the next field. Focus leaving an open list closes it (ui.focus hook).
async function moveFocus($, key) {
  try {
    await $.ui.focus({ requestId: WIZARD, key })
  } catch {}
}

function picker($, ui, f) {
  const { Box, Button } = ui
  const cur = f.options.find((o) => o.value === f.value) || f.options[0]
  const isOpen = openPick === f.key
  const head = Button({
    key: 'w-' + f.key,
    label: f.label + ': ' + cur.label + (isOpen ? ' ▴' : ' ▾'),
    plain: true,
    onPress: async () => {
      openPick = isOpen ? null : f.key
      $.ui.invalidate('ui.render')
      if (!isOpen) await moveFocus($, 'w-' + f.key + ':' + cur.value)
    },
  })
  const rows = [f.prefix ? Box({ flexDirection: 'row', columnGap: 1, children: [...f.prefix, head] }) : head]
  if (isOpen) {
    rows.push(Box({
      flexDirection: 'column',
      paddingLeft: 2,
      children: f.options.map((o) => Button({
        key: 'w-' + f.key + ':' + o.value,
        label: (o.value === cur.value ? '● ' : '○ ') + o.label,
        plain: true,
        onPress: async () => {
          f.set(o.value)
          openPick = null
          $.ui.invalidate('ui.render')
          await moveFocus($, f.next)
        },
      })),
    }))
  }
  return Box({ key: 'f-' + f.key, flexDirection: 'column', children: rows })
}

function renderWizard($, e) {
  const { Box, Text, Button, Input } = $.ui.resolve(e)
  const redraw = () => $.ui.invalidate('ui.render')
  if (!draft) {
    return Box({ flexDirection: 'column', children: [Text({ dimColor: true, children: ['Nothing to spawn.'] }), Button({ key: 'w-close', label: 'Close', onPress: () => $.ui.close({ id: WIZARD }) })] })
  }
  const d = draft
  const typeOptions = [{ value: 'default', label: 'Default (general-purpose)' }]
  for (const t of [...BUILTIN_AGENTS.filter((b) => b !== 'general-purpose'), ...Object.keys(agentTypes).sort()]) {
    if (!typeOptions.some((o) => o.value === t)) typeOptions.push({ value: t, label: t + (agentTypes[t] ? ' - ' + clip(agentTypes[t], 50) : '') })
  }
  const used = liveColors()
  const colorOptions = PALETTE.filter((c) => !used.includes(c.hex) || c.hex === d.color).map((c) => ({ value: c.hex, label: c.name }))
  const options = colorOptions.length ? colorOptions : PALETTE.map((c) => ({ value: c.hex, label: c.name }))
  const notes = []
  if (d.mode === 'teammate' && !d.teamsOn) {
    notes.push(Text({ color: '#e5c07b', children: ['Agent teams are off (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1). It will run as a named background agent instead.'] }))
  }
  if (d.mode === 'teammate' && ['auto'].includes(d.approval)) {
    notes.push(Text({ dimColor: true, children: ["Auto for a teammate follows the lead session's own mode."] }))
  }
  if (d.mode === 'session' && BUILTIN_AGENTS.includes(d.agentType) && d.agentType !== 'general-purpose') {
    notes.push(Text({ dimColor: true, children: [d.agentType + ' is built in; a separate session starts as a normal session.'] }))
  }
  const ui = { Box, Text, Button }
  const restartOptions = [{ value: 'off', label: 'Off' }, { value: 'on', label: 'Restart if it crashes or hangs (up to ' + RESTART_MAX + 'x)' }]
  return Box({
    flexDirection: 'column',
    children: [
      Text({ bold: true, children: ['Spawn a swarm agent'] }),
      picker($, ui, { key: 'mode', label: 'Runs as', options: MODES, value: d.mode, next: 'w-agent', set: (v) => { d.mode = v } }),
      picker($, ui, { key: 'agent', label: 'Agent', options: typeOptions, value: d.agentType, next: 'w-model', set: (v) => { d.agentType = v } }),
      picker($, ui, { key: 'model', label: 'Model', options: MODELS, value: d.model, next: 'w-effort', set: (v) => { d.model = v } }),
      picker($, ui, { key: 'effort', label: 'Thinking effort', options: EFFORTS, value: d.effort, next: 'w-name', set: (v) => { d.effort = v } }),
      Input({ key: 'w-name', label: 'Name', placeholder: 'scout', value: d.name, onInput: (v) => { d.name = v }, onSubmit: (v) => { d.name = v; redraw() } }),
      picker($, ui, { key: 'color', label: 'Color', options, value: d.color, next: 'w-approval', set: (v) => { d.color = v }, prefix: [Text({ color: d.color, children: ['●●●'] })] }),
      picker($, ui, { key: 'approval', label: 'Approval mode', options: APPROVALS, value: d.approval, next: 'w-restart', set: (v) => { d.approval = v } }),
      picker($, ui, { key: 'restart', label: 'Auto-restart', options: restartOptions, value: d.autoRestart ? 'on' : 'off', next: 'w-task', set: (v) => { d.autoRestart = v === 'on' } }),
      Input({ key: 'w-task', label: 'Task', placeholder: d.mode === 'session' ? 'first prompt (optional)' : 'what should it work on?', value: d.task, onInput: (v) => { d.task = v }, onSubmit: (v) => { d.task = v; redraw() } }),
      Text({ dimColor: true, wrap: 'truncate-middle', children: ['Workspace: ' + (d.cwd || 'this session’s directory')] }),
      ...notes,
      ...(wizardError ? [Text({ color: '#ff5555', children: [wizardError] })] : []),
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          Button({ key: 'w-spawn', label: 'Spawn ' + (String(d.name || '').trim() || 'agent'), onPress: () => spawnFromDraft($) }),
          Button({ key: 'w-cancel', label: 'Cancel', onPress: async () => { draft = null; await $.ui.close({ id: WIZARD }) } }),
        ],
      }),
    ],
  })
}

async function renderDetail($, e, key) {
  const { Box, Text, Button, Input, Markdown } = $.ui.resolve(e)
  const a = agents[key]
  if (!a) {
    return Box({ flexDirection: 'column', children: [Text({ dimColor: true, children: ['This agent is no longer in the swarm.'] }), Button({ key: 'close', label: 'Close', onPress: () => $.ui.close({ id: e.requestId }) })] })
  }
  const sv = statusView(a)
  const t = a.tokens || emptyTokens()
  const parts = []
  parts.push(
    Box({
      flexDirection: 'row',
      columnGap: 1,
      children: [
        Text({ color: a.color, children: ['●'] }),
        Text({ bold: true, color: a.color, children: [a.name] }),
        Text({ dimColor: true, children: ['· ' + (a.transport === 'session' ? 'separate session' : a.teammateId ? 'teammate ' + a.teammateId : 'teammate')] }),
      ],
    }),
  )
  parts.push(Text({ dimColor: true, wrap: 'truncate-end', children: [a.agentType + ' · ' + labelOf(MODELS, a.model) + (a.resolvedModel ? ' (' + a.resolvedModel + ')' : '') + ' · effort ' + a.effort + ' · ' + labelOf(APPROVALS, a.approval) + ' · ' + colorName(a.color)] }))
  parts.push(Text({ color: sv.color, bold: !!sv.bold, children: [sv.glyph + ' ' + sv.word + (a.activity ? ' · ' + a.activity : '')] }))
  parts.push(Text({ children: ['tokens ' + fmtTokens(totalTokens(t)) + '  (in ' + fmtTokens(t.input) + ' · out ' + fmtTokens(t.output) + ' · cache read ' + fmtTokens(t.cacheRead) + ' · cache write ' + fmtTokens(t.cacheWrite) + ')  ctx ' + fmtTokens(a.ctx) + ' · ' + (a.turns || 0) + ' turns'] }))
  if (a.status === 'failed' && a.error) {
    parts.push(
      Box({
        key: 'error',
        flexDirection: 'column',
        borderStyle: 'round',
        paddingX: 1,
        children: [
          Text({ bold: true, color: '#ff5555', children: ['✕ Error'] }),
          Text({ children: [a.error.length > 4000 ? a.error.slice(0, 4000) + '…' : a.error] }),
          Button({ key: 'copy-error', label: 'Copy error', hotkey: 'o', plain: true, onPress: (press) => copyError($, key, press) }),
        ],
      }),
    )
  }
  for (const c of conflicts.filter((c) => c.keys.includes(key))) {
    parts.push(Text({ color: '#e5c07b', children: ['▲ also edited by ' + c.keys.filter((k) => k !== key).map((k) => (agents[k] ? agents[k].name : k)).join(', ') + ': ' + c.path] }))
  }

  const p = a.pending
  if (p && p.kind === 'approval') {
    parts.push(
      Box({
        key: 'approval',
        flexDirection: 'column',
        borderStyle: 'round',
        paddingX: 1,
        children: [
          Text({ bold: true, color: '#ff5555', children: ['! ' + a.name + ' wants to use ' + p.tool] }),
          ...(p.reason ? [Text({ dimColor: true, children: [p.reason] })] : []),
          Text({ children: [clip(p.detail || p.summary, 1500)] }),
          Box({
            flexDirection: 'row',
            columnGap: 2,
            children: [
              Button({ key: 'ap-allow', label: 'y: Approve', hotkey: 'y', onPress: () => resolvePending($, key, { decision: 'allow' }) }),
              Button({ key: 'ap-deny', label: 'd: Deny', hotkey: 'd', onPress: () => resolvePending($, key, { decision: 'deny' }) }),
              Button({ key: 'ap-native', label: 'l: Use its own prompt', hotkey: 'l', onPress: () => resolvePending($, key, { decision: 'native' }) }),
            ],
          }),
        ],
      }),
    )
  } else if (p && p.kind === 'question') {
    const answers = qDraft[p.reqId] || (qDraft[p.reqId] = {})
    const qs = p.questions || []
    const qBlocks = qs.map((q, qi) =>
      Box({
        key: 'q-' + qi,
        flexDirection: 'column',
        children: [
          Text({ bold: true, children: [(q.header ? '[' + q.header + '] ' : '') + q.question] }),
          ...(q.options || []).map((o, oi) => {
            const chosen = String(answers[q.question] || '').split(', ').includes(o.label)
            return Button({
              key: 'q-' + qi + '-' + oi,
              label: (chosen ? '✓ ' : '  ') + o.label + (o.description ? ' - ' + clip(o.description, 60) : ''),
              plain: true,
              onPress: () => {
                if (q.multiSelect) {
                  const cur = String(answers[q.question] || '').split(', ').filter(Boolean)
                  answers[q.question] = (cur.includes(o.label) ? cur.filter((x) => x !== o.label) : [...cur, o.label]).join(', ')
                } else {
                  answers[q.question] = o.label
                }
                $.ui.invalidate('ui.render')
              },
            })
          }),
          Input({ key: 'q-' + qi + '-other', label: 'Other', placeholder: 'type your own answer', value: '', onSubmit: (v) => { if (String(v).trim()) { answers[q.question] = String(v).trim(); $.ui.invalidate('ui.render') } } }),
        ],
      }),
    )
    const ready = qs.every((q) => answers[q.question])
    parts.push(
      Box({
        key: 'question',
        flexDirection: 'column',
        borderStyle: 'round',
        paddingX: 1,
        children: [
          Text({ bold: true, color: '#ff79c6', children: ['? ' + a.name + ' is asking'] }),
          ...qBlocks,
          Box({
            flexDirection: 'row',
            columnGap: 2,
            children: [
              Button({ key: 'q-send', label: ready ? 'Send answers' : 'Answer every question first', dimColor: !ready, onPress: () => (ready ? resolvePending($, key, { answers: { ...answers } }) : undefined) }),
              Button({ key: 'q-native', label: 'Use its own prompt', plain: true, onPress: () => resolvePending($, key, { decision: 'native' }) }),
            ],
          }),
        ],
      }),
    )
  }

  // Recent activity, and the conversation when this process can read it
  const recent = (a.log || []).slice(expanded[key] ? -20 : -8)
  if (recent.length) {
    parts.push(Text({ bold: true, children: ['Recent'] }))
    for (const [i, l] of recent.entries()) parts.push(Text({ key: 'log-' + i, dimColor: true, wrap: 'truncate-end', children: ['  ' + l.text] }))
  }
  if (a.transport === 'teammate' && a.agentId && expanded[key]) {
    try {
      const msgs = await $.session.messages({ agentId: a.agentId })
      if (Array.isArray(msgs) && msgs.length) {
        parts.push(Text({ bold: true, children: ['Conversation'] }))
        for (const [i, m] of msgs.slice(-8).entries()) {
          const tools = (m.toolUses || []).map((u) => summarizeTool(u.tool, u.input)).join('; ')
          const line = (m.role === 'assistant' ? a.name : 'in') + ': ' + clip(m.text || tools || '(tool results)', 300)
          parts.push(Text({ key: 'msg-' + i, color: m.role === 'assistant' ? a.color : undefined, dimColor: m.role !== 'assistant', children: [line] }))
        }
      }
    } catch {}
  }
  if (a.lastAnswer) {
    parts.push(Text({ bold: true, children: ['Last answer'] }))
    parts.push(Markdown({ key: 'answer', text: clip(a.lastAnswer, expanded[key] ? 6000 : 1200) }))
  }

  parts.push(
    Input({
      key: 'msg',
      label: 'Message',
      placeholder: 'send ' + a.name + ' a message',
      value: '',
      submitLabel: 'send',
      onSubmit: (v) => sendTo($, key, v),
    }),
  )
  const actions = []
  const live = isLive(a) || !!a.restartAt
  if (a.transport === 'session' && isLive(a)) {
    actions.push(Button({ key: 'focus', label: 'w: Open its window', hotkey: 'w', onPress: () => focusWindow($, key) }))
    actions.push(Button({ key: 'interrupt', label: 'i: Interrupt', hotkey: 'i', onPress: () => stopAgent($, key) }))
  }
  if (live) actions.push(Button({ key: 'kill', label: 'k: Kill', hotkey: 'k', onPress: () => killAgent($, key) }))
  else actions.push(Button({ key: 'respawn', label: 'p: Respawn', hotkey: 'p', onPress: () => restartAgent($, key, true) }))
  actions.push(Button({
    key: 'auto-restart',
    label: 'Auto-restart ' +(a.autoRestart ? 'on' : 'off') + (a.restarts ? ' (' + a.restarts + '/' + RESTART_MAX + ' used)' : ''),
    hotkey: 'a',
    plain: true,
    onPress: () => {
      a.autoRestart = !a.autoRestart
      if (!a.autoRestart) a.restartAt = null
      changed($)
    },
  }))
  actions.push(Button({ key: 'expand', label: expanded[key] ? 'e: Compact' : 'e: Expand', hotkey: 'e', onPress: async () => { expanded[key] = !expanded[key]; await openDetail($, key); $.ui.invalidate('ui.render') } }))
  actions.push(Button({ key: 'remove', label: 'Remove', hotkey: 'r', plain: true, onPress: () => removeAgent($, key) }))
  actions.push(Button({ key: 'close', label: 'Close', hotkey: 'c', plain: true, onPress: () => $.ui.close({ id: e.requestId }) }))
  parts.push(Box({ flexDirection: 'row', columnGap: 2, children: actions }))
  if (a.transport === 'teammate') {
    parts.push(Text({ dimColor: true, children: ['Tip: you can also select it in the agent panel under the prompt and press Enter to talk to it there.'] }))
  }
  return Box({ flexDirection: 'column', children: parts })
}

function renderRosters($, e) {
  const { Box, Text, Button, Input } = $.ui.resolve(e)
  const rows = []
  rows.push(Text({ bold: true, children: ['Saved rosters'] }))
  rows.push(Text({ dimColor: true, children: ['A roster keeps each agent\'s name, color, type, model, effort, approval mode, transport, task and auto-restart. Launching one spawns them all in this workspace.'] }))
  rows.push(
    Input({
      key: 'r-name',
      label: 'Save this swarm as',
      placeholder: 'roster name',
      value: rosterNameDraft,
      submitLabel: 'save',
      onInput: (v) => { rosterNameDraft = v },
      onSubmit: (v) => saveRoster($, v),
    }),
  )
  if (rosterError) rows.push(Text({ color: '#ff5555', children: [rosterError] }))
  if (!rosterList.length) rows.push(Text({ dimColor: true, children: ['No saved rosters yet.'] }))
  for (const [i, r] of rosterList.entries()) {
    const when = r.savedAt ? new Date(r.savedAt).toISOString().slice(0, 16).replace('T', ' ') : ''
    rows.push(
      Box({
        key: 'roster-' + i,
        flexDirection: 'column',
        children: [
          Box({
            flexDirection: 'row',
            columnGap: 2,
            children: [
              Text({ bold: true, children: [r.name] }),
              Button({ key: 'rl-' + i, label: 'Launch', onPress: async () => { await $.ui.close({ id: ROSTERS }); await launchRoster($, r.agents, r.name) } }),
              Button({ key: 'rd-' + i, label: 'Delete', plain: true, onPress: () => deleteRoster($, r.name) }),
            ],
          }),
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Text({ dimColor: true, children: ['  '] }),
              ...r.agents.slice(0, 8).map((x, j) => Text({ key: 'dot-' + j, color: x.color, children: ['● ' + x.name] })),
              Text({ dimColor: true, wrap: 'truncate-end', children: [(r.agents.length > 8 ? '+' + (r.agents.length - 8) + ' · ' : '') + when + (r.cwd ? ' · from ' + baseName(String(r.cwd).replace(/[\\/]+$/, '')) : '')] }),
            ],
          }),
        ],
      }),
    )
  }
  rows.push(Button({ key: 'r-close', label: 'Close', hotkey: 'c', plain: true, onPress: () => $.ui.close({ id: ROSTERS }) }))
  return Box({ flexDirection: 'column', children: rows })
}

// ======================= register =======================

export function register(on) {
  on('session.start', async ($, e, next) => {
    await detectPlatform($)
    try {
      homeDir = (platform === 'windows' ? await $.env.get('USERPROFILE') : await $.env.get('HOME')) || ''
    } catch {}
    try {
      leadId = await $.session.id()
    } catch {}
    try {
      const wid = await $.env.get('SWARM_MOD_WORKER')
      if (wid) {
        worker = {
          id: wid,
          lead: (await $.env.get('SWARM_MOD_LEAD')) || '',
          name: (await $.env.get('SWARM_MOD_NAME')) || 'worker',
          approval: (await $.env.get('SWARM_MOD_APPROVAL')) || 'default',
        }
        await workerBoot($)
        const task = String((await $.env.get('SWARM_MOD_TASK')) || '').trim()
        if (task) $.clock.after(1000, () => submitTask($, task))
      }
    } catch (err) {
      $.ui.log('swarm worker setup failed: ' + (err && err.message), { to: 'debug' })
    }
    await restore($)
    try {
      bandOn = (await $.store.get('band')) !== 'off'
    } catch {}
    if (!worker && !order.length) {
      try {
        const last = await $.store.get(lastRosterKey(await $.session.cwd(), platform !== 'linux'))
        if (last && Array.isArray(last.agents) && last.agents.length) lastRoster = last
      } catch {}
    }
    try {
      await $.command.register({ name: 'swarm', description: 'Open the swarm pane', argumentHint: '[spawn | status | rosters | save <name> | load <name> | restore | kill-all | band on|off]', immediate: true })
      await $.command.register({ name: 'swarm-spawn', description: 'Spawn a swarm agent', immediate: true })
    } catch (err) {
      $.ui.log('could not register swarm commands: ' + (err && err.message), { to: 'debug' })
    }
    try {
      await $.tool.register({
        name: STATUS_TOOL,
        description: 'List the agents the user spawned in the swarm pane: name, transport, status, current activity, token use, anything waiting on the user, and the last answer. Use it before coordinating with or messaging swarm agents.',
        inputSchema: { type: 'object', properties: {} },
      })
    } catch (err) {
      $.ui.log('could not register swarm_status: ' + (err && err.message), { to: 'debug' })
    }
    $.clock.every(1500, () => tick($))
    return next(e)
  })

  // /clear, /resume and /branch reset $.state: write the roster back on the next tick
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    snapshotDirty = true
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (worker && w && w.status !== 'killed') {
      w.status = 'exited'
      w.exitReason = e.reason
      w.pending = null
      await workerFlush($)
    }
    return next(e)
  })

  on('command.run', { command: 'swarm' }, async ($, e) => {
    const args = String(e.args || '').trim().toLowerCase()
    if (args === 'spawn') {
      await openWizard($)
      return {}
    }
    if (args === 'status') return { text: statusText() }
    const raw = String(e.args || '').trim()
    if (args === 'kill-all' || args === 'killall') {
      const n = await killAll($)
      return { text: 'Killed ' + n + ' swarm agent' + (n === 1 ? '' : 's') }
    }
    if (args === 'rosters' || args === 'roster') {
      await openRosters($)
      return {}
    }
    if (args.startsWith('save ')) {
      const ok = await saveRoster($, raw.slice(5))
      return { text: ok ? 'Saved the swarm as roster "' + raw.slice(5).trim() + '"' : rosterError }
    }
    if (args.startsWith('load ') || args.startsWith('launch ')) {
      const name = raw.slice(raw.indexOf(' ') + 1).trim()
      const list = await loadRosters($)
      const r = list.find((x) => x.name.toLowerCase() === name.toLowerCase())
      if (!r) return { text: 'No roster named "' + name + '". Saved: ' + (list.map((x) => x.name).join(', ') || 'none') }
      const n = await launchRoster($, r.agents, r.name)
      return { text: 'Spawning ' + n + ' agents from roster "' + r.name + '"' }
    }
    if (args === 'restore') {
      if (!lastRoster) return { text: 'No earlier swarm saved for this workspace' }
      const n = await launchRoster($, lastRoster.agents, 'last swarm')
      return { text: 'Restoring ' + n + ' agents' }
    }
    if (args === 'band off' || args === 'band on') {
      bandOn = args === 'band on'
      try {
        await $.store.set('band', bandOn ? 'on' : 'off')
      } catch {}
      $.ui.invalidate('ui.render')
      return { text: 'Swarm band ' + (bandOn ? 'on' : 'off') }
    }
    await $.ui.open({ id: MAIN, title: 'Swarm', focus: true })
    return {}
  })

  on('command.run', { command: 'swarm-spawn' }, async ($) => {
    await openWizard($)
    return {}
  })

  on('agent.offer', async ($, e, next) => {
    agentTypes[e.agent] = e.description
    return next(e)
  })

  on('tool.call', { tool: 'mcp__swarm-mod__swarm_status' }, async () => ({ result: statusText() }))

  // Activity, files, and questions of swarm teammates (and of this session when it is a worker)
  on('tool.call', async ($, e, next) => {
    const key = await resolveKey($, e.agentId)
    const workerSide = !!(worker && w)
    if (!key && !workerSide) return next(e)
    const now = (await $.clock.now())
    const summary = summarizeTool(e.tool, e)
    if (e.tool_use_id) callInfo[e.tool_use_id] = { key, tool: e.tool, input: e, workerMain: workerSide && !key }
    if (key) {
      const a = agents[key]
      a.activity = summary
      if (!a.pending && isLive(a)) a.status = 'running'
      pushLog(a, summary, now)
      if (EDIT_TOOLS.includes(e.tool)) addFile(a, e.file_path || e.notebook_path)
      changed($)
    }
    if (workerSide && !key) {
      if (!e.agentId) w.activity = summary
      workerLog((e.agentId ? '(sub) ' : '') + summary, now)
      if (EDIT_TOOLS.includes(e.tool)) {
        const f = e.file_path || e.notebook_path
        if (f && !w.files.includes(f)) w.files = [...w.files, f].slice(-200)
      }
    }
    if (e.tool === 'AskUserQuestion' && (key || (workerSide && !e.agentId))) {
      const result = await holdQuestion($, key, e, next.signal)
      if (result) {
        if (e.tool_use_id) delete callInfo[e.tool_use_id]
        return { result }
      }
    }
    try {
      return await next(e)
    } finally {
      if (e.tool_use_id) delete callInfo[e.tool_use_id]
      if (key && agents[key] && agents[key].activity === summary) {
        agents[key].activity = ''
        changed($)
      }
      if (workerSide && !key && !e.agentId && w.activity === summary) {
        w.activity = ''
        wDirty = true
      }
    }
  })

  // Approval modes for teammates; approvals routed to the swarm pane
  on('tool.check', async ($, e, next) => {
    const info = e.tool_use_id ? callInfo[e.tool_use_id] : null
    if (!info) return next(e)
    const key = info.key
    const r = await next(e)
    let decision = r.decision
    if (key) {
      const mode = agents[key] ? agents[key].approval : 'default'
      decision = decide(mode, e.tool, r.decision)
      if (decision === 'allow' && r.decision !== 'allow') return { decision: 'allow', reason: 'Allowed by the swarm approval mode "' + mode + '"' }
      if (decision === 'deny' && r.decision !== 'deny') {
        return {
          decision: 'deny',
          reason: mode === 'plan'
            ? 'This swarm agent runs in plan/read-only mode: it may not edit files or run anything that needs approval. Describe the change for the lead instead.'
            : 'This swarm agent runs in dont-ask mode: anything not pre-approved is denied. Continue without it or ask the lead.',
        }
      }
      if (decision !== 'ask' || mode === 'auto') return r
    } else {
      // worker: only hold when a person would be asked
      if (decision !== 'ask' || !worker || ['auto', 'bypassPermissions', 'dontAsk'].includes(worker.approval)) return r
    }
    const reqId = randomId()
    await setPending($, key, {
      kind: 'approval', reqId, tool: e.tool,
      summary: summarizeTool(e.tool, info.input), detail: describeCall(e.tool, info.input),
      reason: r.reason || '', since: (await $.clock.now()),
    })
    const d = await holdFor($, reqId, key ? TEAMMATE_HOLD_MS : WORKER_HOLD_MS, next.signal)
    await clearPending($, key, reqId)
    if (d && d.decision === 'allow') return { decision: 'allow', reason: 'Approved by the user in the swarm pane' }
    if (d && d.decision === 'deny') return { decision: 'deny', reason: 'The user denied this in the swarm pane. Do not retry it; ask how to proceed.' }
    return r
  })

  // Per-agent effort, and token accounting
  on('turn.step', async function* ($, e, next) {
    const key = await resolveKey($, e.agentId)
    let input = e
    if (key) {
      const a = agents[key]
      if (a.effort && a.effort !== 'default' && e.effort !== undefined) input = { ...e, effort: a.effort }
      if (!a.pending && isLive(a) && a.status !== 'running') {
        a.status = 'running'
        changed($)
      }
    }
    const r = yield* next(input)
    if (r && r.usage) {
      if (key && agents[key]) {
        const ctx = addUsage(agents[key].tokens, r.usage)
        agents[key].ctx = ctx
        agents[key].tokens = { ...agents[key].tokens }
        changed($)
      }
      if (worker && w) {
        const ctx = addUsage(w.tokens, r.usage)
        if (!e.agentId) w.ctx = ctx
        wDirty = true
      }
    }
    return r
  })

  on('turn.start', async ($, e, next) => {
    if (worker && w) {
      w.status = 'working'
      w.turnId = e.turnId
      if (e.text) workerLog('▸ ' + e.text, (await $.clock.now()))
      await workerFlush($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const key = keyOfAgentId(e.agentId)
    if (key) {
      const a = agents[key]
      a.turns = (a.turns || 0) + 1
      a.activity = ''
      if (e.answer) a.lastAnswer = clip(e.answer, 8000)
      pushLog(a, e.reason === 'error' ? '✕ turn failed' : '✓ ' + (e.answer || 'turn done'), (await $.clock.now()))
      if (e.reason === 'error') await toast($, a.name + ': turn failed')
      changed($)
    }
    if (worker && w && !e.agentId) {
      w.turns += 1
      w.status = 'idle'
      w.activity = ''
      w.turnId = ''
      if (e.answer) w.lastAnswer = String(e.answer).slice(0, 8000)
      workerLog(e.isAborted ? '■ interrupted' : '✓ ' + (e.answer || 'turn done'), (await $.clock.now()))
      await workerFlush($)
    }
    return next(e)
  })

  // An open spawn-form list closes once the person moves the focus off it (Tab past its options, a click elsewhere)
  on('ui.focus', { requestId: WIZARD }, async ($, e, next) => {
    if (openPick && e.origin.kind === 'person') {
      const el = String(e.element || '')
      if (el !== 'w-' + openPick && !el.startsWith('w-' + openPick + ':')) {
        openPick = null
        $.ui.invalidate('ui.render')
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId === MAIN) return renderMain($, e)
    if (e.requestId === WIZARD) return renderWizard($, e)
    if (e.requestId === ROSTERS) return renderRosters($, e)
    if (typeof e.requestId === 'string' && e.requestId.startsWith(DETAIL)) return renderDetail($, e, e.requestId.slice(DETAIL.length))
    return next(e)
  })

  // One row above the prompt: who is working, who needs you, and the buttons
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!bandOn || e.props.hasSurvey || (worker && !order.length)) return next(e)
    const theirs = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const { list, working, attention, total } = counts()
    const narrow = (e.props.bodyColumns || 80) < 60
    const dots = list.filter(isLive).slice(0, narrow ? 4 : 10).map((a) => {
      const sv = statusView(a)
      return Text({ key: 'dot-' + a.key, color: a.color, children: ['● ' + (narrow ? '' : a.name + ' ') + sv.glyph] })
    })
    const row = Box({
      flexDirection: 'row',
      columnGap: 1,
      children: [
        Text({ bold: true, color: '#c678dd', children: ['swarm'] }),
        ...(list.length ? [Text({ dimColor: true, children: [working + '/' + list.length + ' working · ' + fmtTokens(total) + ' tok'] })] : []),
        ...dots,
        ...(attention ? [Button({ key: 'band-attn', label: '! ' + attention + ' need you', onPress: () => openDetail($, order.find((k) => agents[k].pending)) })] : []),
        ...(list.length ? [Button({ key: 'band-open', label: 'Swarm', plain: true, onPress: () => $.ui.open({ id: MAIN, title: 'Swarm', focus: true }) })] : []),
        ...(lastRoster && !list.length
          ? [Button({ key: 'band-restore', label: 'Restore last swarm (' + lastRoster.agents.length + ')', onPress: () => launchRoster($, lastRoster.agents, 'last swarm') })]
          : []),
        Button({ key: 'band-spawn', label: '+ Spawn agent', plain: true, onPress: () => openWizard($) }),
      ],
    })
    return Box({ flexDirection: 'column', children: theirs ? [row, theirs] : [row] })
  })
}
