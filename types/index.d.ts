/** The flow as JSON, with the session start it belongs to: a reload keeps it, /clear starts over. */
export type SavedFlow = string | null

declare module 'claude-code' {
  interface PluginState {
    'agent-flow': { saved: SavedFlow }
  }
}
