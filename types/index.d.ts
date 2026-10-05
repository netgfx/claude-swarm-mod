declare module 'claude-code' {
  interface PluginState {
    'swarm-mod': {
      snapshot: { agents: Record<string, unknown>; order: string[] }
    }
  }
}
