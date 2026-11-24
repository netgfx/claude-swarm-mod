# Privacy statement: Swarm (powermods-swarm)

Swarm is a Claude Code mod that spawns and manages Claude Code agents on your own computer. It is published by Michael Dobekidis ([github.com/netgfx](https://github.com/netgfx)).

## What it collects

Nothing is collected by the publisher. The mod has no server, no analytics and no telemetry, and makes no network requests of its own (`network.hosts` in its manifest is empty).

To run the swarm it keeps, on your computer only:

- Each agent's settings (name, color, type, model, effort, approval mode, transport, task, auto-restart), status, recent activity log (including the start of each prompt a worker receives and short tool summaries), edited file paths, last answer and token counts.
- Saved rosters and each workspace's last swarm, which include the tasks you typed.
- Launch scripts for separate-session workers, which include the agent's name, workspace path and first task.

## Where it is stored

- Claude Code's plugin store for this mod (`$.store`, under `~/.claude/plugins/store/`), which every Claude Code session on this computer can read: worker reports (`w:<id>`), the lead's replies (`r:<id>`), saved rosters (`roster:<name>`), each workspace's last swarm (`last:<workspace>`) and the band setting.
- The mod's in-memory state for the session (`powermods-swarm.snapshot`), which other mods you run can read.
- `~/.claude/swarm-mod/launch/`: launch scripts, `.tty` files, and `worker-settings.json` (only with the `workersAcceptMessages` option on).

## What leaves your computer

Nothing is sent by the mod. The agents it starts are ordinary Claude Code sessions and subagents: their model requests go to Anthropic, or to the provider you configured, on your own plan or API key, exactly as any Claude Code session's do. Messages between the lead and its workers on this computer travel over Claude Code's local cross-session messaging, not through any server of the publisher.

## Retention

- Worker reports and the lead's replies: deleted when you remove an agent, clear finished agents or respawn one, and otherwise after the worker has been silent for 7 days.
- Saved rosters: until you delete them in the rosters pane.
- A workspace's last swarm: replaced as the swarm changes; kept until you remove the store entry.
- In-memory state: until the session ends.
- Launch scripts: until you delete `~/.claude/swarm-mod/launch/`.

## How to delete it

- Delete rosters in the rosters pane (`/swarm rosters`), and remove agents with **Remove** or **Clear finished**.
- Delete the folder `~/.claude/swarm-mod/launch/`.
- Uninstalling the plugin with `claude plugin uninstall powermods-swarm@claude-swarm-mod` removes its plugin data. To clear its store as well, delete the file whose name starts with `powermods-swarm_` in `~/.claude/plugins/store/` (and `swarm-mod_` for the version before 0.5.0).

## Sharing and sale

The publisher receives none of this data, and nothing is sold or shared with anyone.

## Children

The mod is a developer tool and is not directed at anyone under 18.

## Contact

Questions or requests: [github.com/netgfx/claude-swarm-mod/issues](https://github.com/netgfx/claude-swarm-mod/issues).
