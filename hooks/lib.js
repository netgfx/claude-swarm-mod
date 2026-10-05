// Pure helpers for swarm-mod: no mods API calls here, so they can be imported
// and unit tested freely.

// Distinct, readable on dark and light themes. Hex works on both surfaces.
export const PALETTE = [
  { hex: '#e06c75', name: 'coral' },
  { hex: '#98c379', name: 'green' },
  { hex: '#e5c07b', name: 'gold' },
  { hex: '#61afef', name: 'blue' },
  { hex: '#c678dd', name: 'violet' },
  { hex: '#56b6c2', name: 'teal' },
  { hex: '#d19a66', name: 'orange' },
  { hex: '#ff79c6', name: 'pink' },
  { hex: '#8be9fd', name: 'sky' },
  { hex: '#50fa7b', name: 'mint' },
  { hex: '#bd93f9', name: 'lavender' },
  { hex: '#f1fa8c', name: 'lemon' },
]

export function colorName(hex) {
  const hit = PALETTE.find((c) => c.hex === hex)
  return hit ? hit.name : hex
}

// A random palette color no live agent uses; any color once all are taken
export function pickColor(used, rand = Math.random) {
  const free = PALETTE.filter((c) => !used.includes(c.hex))
  const pool = free.length ? free : PALETTE
  return pool[Math.floor(rand() * pool.length) % pool.length].hex
}

export const MODES = [
  { value: 'teammate', label: 'Teammate (agent team, in this session)' },
  { value: 'session', label: 'Separate Claude Code session (own window)' },
]

export const MODELS = [
  { value: 'inherit', label: "Inherit (lead's model)" },
  { value: 'claude-opus-5-5', label: 'Opus 5.5' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1' },
]

// $.agent.spawn only takes family aliases; `claude --model` takes full ids.
// Maps a stored model value to its alias, or '' when it has none.
export function modelAlias(model) {
  const m = String(model || '').toLowerCase()
  return ['opus', 'sonnet', 'haiku', 'fable'].find((f) => m === f || m.includes('-' + f + '-') || m.startsWith(f + '-')) || ''
}

export const EFFORTS = [
  { value: 'default', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
]

export const APPROVALS = [
  { value: 'default', label: 'Ask me (default)' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'auto', label: 'Auto' },
  { value: 'plan', label: 'Plan / read-only' },
  { value: 'dontAsk', label: "Don't ask (deny unless pre-approved)" },
  { value: 'bypassPermissions', label: 'Bypass all checks (dangerous)' },
]

export const BUILTIN_AGENTS = ['general-purpose', 'Explore', 'Plan']

export const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']

export const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/

export function labelOf(list, value) {
  const hit = list.find((o) => o.value === value)
  return hit ? hit.label : String(value)
}

// "scout", "scout-2", ... the first one nobody has
export function suggestName(base, taken) {
  const clean = String(base || 'agent').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'agent'
  const lower = taken.map((t) => t.toLowerCase())
  if (!lower.includes(clean.toLowerCase())) return clean
  for (let i = 2; i < 1000; i++) {
    const n = clean + '-' + i
    if (!lower.includes(n.toLowerCase())) return n
  }
  return clean + '-' + Date.now()
}

export function validateName(name, taken) {
  if (!NAME_RE.test(name)) return 'Name: 1-40 letters, digits, - or _'
  if (taken.map((t) => t.toLowerCase()).includes(name.toLowerCase())) return 'Name "' + name + '" is taken in this swarm'
  return null
}

export function fmtTokens(n) {
  const v = Number(n) || 0
  if (v < 1000) return String(v)
  if (v < 1e6) return (v / 1000).toFixed(v < 1e4 ? 1 : 0) + 'k'
  return (v / 1e6).toFixed(2) + 'M'
}

export function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

// Adds one API response's usage; returns that response's context size
export function addUsage(tokens, usage) {
  if (!usage) return 0
  tokens.input += usage.input_tokens || 0
  tokens.output += usage.output_tokens || 0
  tokens.cacheRead += usage.cache_read_input_tokens || 0
  tokens.cacheWrite += usage.cache_creation_input_tokens || 0
  return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
}

export function totalTokens(t) {
  if (!t) return 0
  return (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0)
}

function clip(s, n) {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}
export { clip }

// One line saying what a tool call does, for the activity column
export function summarizeTool(tool, input) {
  const i = input || {}
  if (tool === 'Bash' || tool === 'PowerShell') return tool + ': ' + clip(i.command, 60)
  if (i.file_path) return tool + ': ' + baseName(i.file_path)
  if (i.notebook_path) return tool + ': ' + baseName(i.notebook_path)
  if (tool === 'Grep' || tool === 'Glob') return tool + ': ' + clip(i.pattern, 40)
  if (tool === 'WebFetch') return 'WebFetch: ' + clip(i.url, 50)
  if (tool === 'WebSearch') return 'WebSearch: ' + clip(i.query, 50)
  if (tool === 'Agent') return 'Agent: ' + clip(i.description || i.name, 40)
  if (tool === 'SendMessage') return 'SendMessage → ' + clip(i.to, 30)
  if (tool === 'AskUserQuestion') return 'Asking a question'
  return tool
}

// The detail of a held tool call, as shown in the approval box
export function describeCall(tool, input) {
  const i = input || {}
  if (i.command) return String(i.command)
  if (i.file_path && i.old_string !== undefined) return i.file_path + '\n- ' + clip(i.old_string, 300) + '\n+ ' + clip(i.new_string, 300)
  if (i.file_path && i.content !== undefined) return i.file_path + '\n' + clip(i.content, 400)
  try {
    return clip(JSON.stringify(i), 600)
  } catch {
    return tool
  }
}

export function baseName(p) {
  const parts = String(p).split(/[\\/]/)
  return parts[parts.length - 1] || String(p)
}

export function normPath(p, isWindows) {
  const s = String(p || '').replace(/\\/g, '/')
  return isWindows ? s.toLowerCase() : s
}

// The decision a teammate's approval mode gives, from the engine's own
export function decide(mode, tool, engine) {
  if (engine === 'deny') return 'deny'
  const isEdit = EDIT_TOOLS.includes(tool)
  switch (mode) {
    case 'bypassPermissions':
      return 'allow'
    case 'acceptEdits':
      return isEdit ? 'allow' : engine
    case 'plan':
      if (isEdit) return 'deny'
      return engine === 'ask' ? 'deny' : engine
    case 'dontAsk':
      return engine === 'ask' ? 'deny' : engine
    default:
      return engine
  }
}

// Status → glyph, word and color. Single-width glyphs only.
export function statusView(a) {
  if (a.pending && a.pending.kind === 'approval') return { glyph: '!', word: 'needs approval', color: '#ff5555', bold: true }
  if (a.pending && a.pending.kind === 'question') return { glyph: '?', word: 'has a question', color: '#ff79c6', bold: true }
  switch (a.status) {
    case 'launching':
    case 'pending':
    case 'starting':
      return { glyph: '○', word: 'starting', color: 'gray' }
    case 'running':
    case 'working':
      return { glyph: '↯', word: 'working', color: '#50fa7b' }
    case 'waiting':
      return { glyph: '…', word: 'waiting', color: '#e5c07b' }
    case 'idle':
      return { glyph: '○', word: 'idle', color: '#61afef' }
    case 'completed':
      return { glyph: '✓', word: 'done', color: '#98c379' }
    case 'failed':
      return { glyph: '✕', word: 'failed', color: '#ff5555' }
    case 'killed':
      return { glyph: '✕', word: 'stopped', color: 'gray' }
    case 'exited':
      return { glyph: '✕', word: 'exited', color: 'gray' }
    case 'unresponsive':
      return { glyph: '▲', word: 'no heartbeat', color: '#e5c07b' }
    default:
      return { glyph: '·', word: String(a.status || 'unknown'), color: 'gray' }
  }
}

export function isLive(a) {
  return !['completed', 'failed', 'killed', 'exited'].includes(a.status)
}

// ---------- launching a separate Claude Code session ----------

export function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

export function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// The claude CLI arguments for a worker session
export function claudeArgs(spec) {
  const args = ['--name', spec.name, '--plugin-dir', spec.pluginRoot]
  if (spec.agentType && spec.agentType !== 'default' && !BUILTIN_AGENTS.includes(spec.agentType)) args.push('--agent', spec.agentType)
  if (spec.model && spec.model !== 'inherit') args.push('--model', spec.model)
  if (spec.effort && spec.effort !== 'default') args.push('--effort', spec.effort)
  if (spec.approval === 'bypassPermissions') args.push('--dangerously-skip-permissions')
  else if (spec.approval && spec.approval !== 'default') args.push('--permission-mode', spec.approval)
  // Let the lead's messages through whatever the worker's permission mode. A file, not
  // inline JSON: Windows PowerShell 5.1 mangles quotes inside native arguments.
  if (spec.settingsPath) args.push('--settings', spec.settingsPath)
  // The first task is not an argument either: it travels in SWARM_MOD_TASK and the
  // worker submits it, so no quoting of free text reaches a command line.
  return args
}

export function windowTitle(name) {
  return 'swarm: ' + name
}

// The script a new terminal runs: identity in env, cd to the lead's workspace, start claude
export function launchScript(os, spec) {
  const args = claudeArgs(spec)
  if (os === 'windows') {
    return [
      '# swarm-mod worker launcher (generated)',
      '$env:SWARM_MOD_WORKER = ' + psQuote(spec.id),
      '$env:SWARM_MOD_LEAD = ' + psQuote(spec.lead),
      '$env:SWARM_MOD_NAME = ' + psQuote(spec.name),
      '$env:SWARM_MOD_APPROVAL = ' + psQuote(spec.approval || 'default'),
      '$env:SWARM_MOD_TASK = ' + psQuote((spec.task || '').trim()),
      'Set-Location -LiteralPath ' + psQuote(spec.cwd),
      'try { $Host.UI.RawUI.WindowTitle = ' + psQuote(windowTitle(spec.name)) + ' } catch {}',
      '& claude ' + args.map(psQuote).join(' '),
      '',
    ].join('\r\n')
  }
  return [
    '#!/bin/sh',
    '# swarm-mod worker launcher (generated)',
    'export SWARM_MOD_WORKER=' + shQuote(spec.id),
    'export SWARM_MOD_LEAD=' + shQuote(spec.lead),
    'export SWARM_MOD_NAME=' + shQuote(spec.name),
    'export SWARM_MOD_APPROVAL=' + shQuote(spec.approval || 'default'),
    'export SWARM_MOD_TASK=' + shQuote((spec.task || '').trim()),
    'cd ' + shQuote(spec.cwd) + ' || exit 1',
    // which terminal tab this is, so the lead can bring it forward later
    ...(spec.ttyPath ? ['tty > ' + shQuote(spec.ttyPath) + ' 2>/dev/null || :'] : []),
    "printf '\\033]0;%s\\007' " + shQuote(windowTitle(spec.name)),
    // through the login shell, so PATH (claude, node) is what the user's own shell has,
    // whichever app started this script; fish and other non-POSIX shells fall back to zsh/bash
    'case "${SHELL##*/}" in bash|zsh|ksh|sh|dash) LSH="$SHELL" ;; *) LSH=/bin/zsh; [ -x "$LSH" ] || LSH=/bin/bash ;; esac',
    `exec "$LSH" -lic 'exec claude "$@"' claude ` + args.map(shQuote).join(' '),
    '',
  ].join('\n')
}

// AppleScript string literal
function asQuote(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

// Ways to open a terminal running the script, best first: [{ argv, app }]
export function launchCandidates(os, scriptPath, spec, prefs = {}) {
  if (os === 'windows') {
    const ps = ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', scriptPath]
    return [
      // one Windows Terminal window named "swarm", one tab per agent
      { app: 'wt', argv: ['wt.exe', '-w', 'swarm', 'new-tab', '--title', windowTitle(spec.name), '-d', spec.cwd, ...ps] },
      // plain console window; start's first quoted argument is the title
      { app: 'console', argv: ['cmd', '/d', '/c', 'start', windowTitle(spec.name) + ' ', '/D', spec.cwd, ...ps] },
    ]
  }
  if (os === 'mac') {
    const list = []
    if (prefs.iterm) {
      // the lead runs in iTerm2: a new iTerm2 window (asks once for Automation permission)
      list.push({
        app: 'iTerm',
        argv: ['osascript', '-e', 'tell application "iTerm"', '-e', 'activate', '-e',
          'create window with default profile command ' + asQuote('/bin/sh ' + shQuote(scriptPath)), '-e', 'end tell'],
      })
    }
    // Terminal.app runs a .command file in a new window; needs no Automation permission
    list.push({ app: 'Terminal', argv: ['open', '-a', 'Terminal', scriptPath] })
    return list
  }
  return [
    { app: 'x-terminal-emulator', argv: ['x-terminal-emulator', '-e', '/bin/sh', scriptPath] },
    { app: 'gnome-terminal', argv: ['gnome-terminal', '--', '/bin/sh', scriptPath] },
    { app: 'konsole', argv: ['konsole', '-e', '/bin/sh', scriptPath] },
    { app: 'xterm', argv: ['xterm', '-e', '/bin/sh', scriptPath] },
  ]
}

// Bring a worker's window to the front (best effort). Claude Code retitles its
// terminal, so on macOS the tab is found by the tty the launch script recorded.
export function focusArgv(os, name, where = {}) {
  const title = windowTitle(name)
  if (os === 'windows') {
    return ['powershell', '-NoProfile', '-NonInteractive', '-Command',
      '$s = New-Object -ComObject WScript.Shell; if (-not $s.AppActivate(' + psQuote(title) + ')) { [void]$s.AppActivate(' + psQuote(name) + ') }']
  }
  if (os === 'mac') {
    const tty = where.tty ? asQuote(where.tty) : null
    if (where.app === 'iTerm') {
      return ['osascript',
        '-e', 'tell application "iTerm"',
        '-e', 'activate',
        ...(tty ? [
          '-e', 'repeat with w in windows',
          '-e', 'repeat with t in tabs of w',
          '-e', 'repeat with s in sessions of t',
          '-e', 'if tty of s is ' + tty + ' then',
          '-e', 'select w',
          '-e', 'select t',
          '-e', 'select s',
          '-e', 'return "ok"',
          '-e', 'end if',
          '-e', 'end repeat',
          '-e', 'end repeat',
          '-e', 'end repeat',
        ] : []),
        '-e', 'end tell']
    }
    return ['osascript',
      '-e', 'tell application "Terminal"',
      '-e', 'activate',
      ...(tty ? [
        '-e', 'repeat with w in windows',
        '-e', 'repeat with t in tabs of w',
        '-e', 'if tty of t is ' + tty + ' then',
        '-e', 'set selected tab of w to t',
        '-e', 'set index of w to 1',
        '-e', 'return "ok"',
        '-e', 'end if',
        '-e', 'end repeat',
        '-e', 'end repeat',
      ] : []),
      '-e', 'try',
      '-e', 'set index of (first window whose name contains ' + asQuote(name) + ') to 1',
      '-e', 'end try',
      '-e', 'end tell']
  }
  return ['wmctrl', '-a', title]
}

// Parses `name:` and `description:` from an agent file's frontmatter
export function parseAgentFile(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(String(text))
  if (!m) return null
  const field = (k) => {
    const r = new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(m[1])
    return r ? r[1].trim().replace(/^["']|["']$/g, '') : ''
  }
  const name = field('name')
  return name ? { name, description: field('description') } : null
}

// Files two or more agents have edited: [{ path, keys }]
// caseInsensitive: Windows, and macOS (APFS is case-insensitive by default)
export function findConflicts(agents, caseInsensitive) {
  const byPath = new Map()
  for (const a of agents) {
    for (const f of a.files || []) {
      const k = normPath(f, caseInsensitive)
      if (!byPath.has(k)) byPath.set(k, { path: f, keys: [] })
      const entry = byPath.get(k)
      if (!entry.keys.includes(a.key)) entry.keys.push(a.key)
    }
  }
  return [...byPath.values()].filter((e) => e.keys.length > 1)
}

export function randomId(rand = Math.random) {
  let s = ''
  for (let i = 0; i < 10; i++) s += Math.floor(rand() * 36).toString(36)
  return s
}

// The settings file a worker starts with
export const WORKER_SETTINGS = JSON.stringify({ crossSessionInbound: 'accept' }, null, 2) + '\n'

// ---------- process ids (kill a separate session) ----------

// Run from inside a session: prints "<claude pid> <process name>" (the caller's parent)
export function selfPidArgv(os) {
  if (os === 'windows') {
    return ['powershell', '-NoProfile', '-NonInteractive', '-Command',
      "$p = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)).ParentProcessId; Write-Output ('' + $p + ' ' + (Get-Process -Id $p).ProcessName)"]
  }
  return ['/bin/sh', '-c', 'echo "$PPID $(ps -o comm= -p $PPID)"']
}

export function parsePidLine(text) {
  const m = /^\s*(\d+)\s+(.+?)\s*$/m.exec(String(text || ''))
  if (!m) return null
  return { pid: Number(m[1]), name: baseName(m[2]) }
}

// Prints the name of a process now, to check a pid was not reused before killing it
export function pidNameArgv(os, pid) {
  if (os === 'windows') {
    return ['powershell', '-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id ' + Number(pid) + ' -ErrorAction SilentlyContinue).ProcessName']
  }
  return ['ps', '-o', 'comm=', '-p', String(Number(pid))]
}

export function killArgv(os, pid) {
  if (os === 'windows') return ['taskkill', '/PID', String(Number(pid)), '/T', '/F']
  return ['kill', '-TERM', String(Number(pid))]
}

// ---------- auto-restart ----------

export const RESTART_MAX = 3
export const UNRESPONSIVE_RESTART_MS = 60000

// Seconds to wait before restart n (0-based): 5, 15, 45
export function restartDelayMs(n) {
  return 5000 * Math.pow(3, Math.max(0, n))
}

// Session-end reasons that mean the person ended the worker on purpose
export const DELIBERATE_EXITS = ['prompt_input_exit', 'logout']

// Whether an agent ended in a way auto-restart should undo. Stopping it yourself
// (Kill, /exit, or the agent panel's stop) never counts. `now` is the lead's clock:
// a worker counts as hung once the lead has seen it silent for a full minute, so a
// laptop waking from sleep does not restart everything.
export function needsRestart(a, now) {
  if (!a.autoRestart || a.killedByUser || (a.restarts || 0) >= RESTART_MAX) return false
  if (a.transport === 'teammate') return a.status === 'failed'
  if (a.status === 'exited') return !DELIBERATE_EXITS.includes(a.exitReason)
  if (a.status === 'failed') return true
  return a.status === 'unresponsive' && !!a.unresponsiveSince && now - a.unresponsiveSince > UNRESPONSIVE_RESTART_MS
}

export function restartTask(task) {
  const note = '(You were restarted after your previous run ended unexpectedly. Check the current state of the workspace before continuing.)'
  return String(task || '').trim() ? note + '\n\n' + String(task).trim() : note
}

// ---------- saved rosters ----------

export const ROSTER_FIELDS = ['name', 'color', 'agentType', 'model', 'effort', 'approval', 'transport', 'task', 'autoRestart']

export function rosterEntry(a) {
  const e = {}
  for (const f of ROSTER_FIELDS) if (a[f] !== undefined) e[f] = a[f]
  return e
}

export function rosterKey(name) {
  return 'roster:' + String(name).trim()
}

export function lastRosterKey(cwd, caseInsensitive) {
  return 'last:' + normPath(cwd, caseInsensitive).replace(/\/+$/, '')
}

// A roster's entries made to fit beside the agents already here: free names and colors
export function planRoster(entries, takenNames, usedColors, rand = Math.random) {
  const names = [...takenNames]
  const colors = [...usedColors]
  return entries.map((e) => {
    const name = suggestName(e.name, names)
    names.push(name)
    const color = e.color && !colors.includes(e.color) ? e.color : pickColor(colors, rand)
    colors.push(color)
    return { ...e, name, color }
  })
}

export function validRosterName(name) {
  return /^[A-Za-z0-9 _.-]{1,40}$/.test(String(name || '').trim())
}
