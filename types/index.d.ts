export type Mic = {
  /** off: listener not running; busy: another chat has the mic; ready: waiting for "Hey Claude"; awake: taking a request;
   *  sending: request handed to Claude, not stored yet; sent: stored, reply not streaming yet. */
  mode: 'off' | 'paused' | 'busy' | 'ready' | 'awake' | 'sending' | 'sent'
  /** The request heard so far (awake), being sent (sending), or the last words
   *  heard without the wake phrase (ready), so a miss shows what was heard. */
  heard: string
}

/** The last spoken summary, shown in the bar while it is spoken and until the next request. */
export type Said = {
  text: string
  speaking: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'hey-claude': { mic: Mic; said: Said }
  }
}
