declare module 'claude-code' {
  interface PluginState {
    'powermods-swarm': {
      snapshot: { agents: Record<string, unknown>; order: string[]; dismissed?: string[] }
    }
  }
}
