import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Mic, Said } from '../types'

// hey-claude: runs only inside Claude. The plugin starts the listener with the
// session and stops it with the session; spoken requests go in as prompts, and
// each answer's summary is spoken back. macOS only.


const SYSTEM =
  'Summarize the assistant answer for text-to-speech in one or two short sentences. ' +
  'Plain spoken text only: no markdown, no code, no lists, no file paths. ' +
  'Use the same language as the answer.'

const plain = (s: string) =>
  s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const OFF: Mic = { mode: 'off', heard: '' }
const READY: Mic = { mode: 'ready', heard: '' }
const mic = atom({ plugin: 'hey-claude', key: 'mic' } as const, OFF)
const NOTHING_SAID: Said = { text: '', speaking: false }
const said = atom({ plugin: 'hey-claude', key: 'said' } as const, NOTHING_SAID)

export const register: Register = (on, options) => {
  // The voice picked in the plugin's settings; a voice that is not installed falls back
  // to the system default.
  const picked = typeof options.voice === 'string' ? options.voice.trim() : 'Ava (Premium)'
  const VOICE = picked && picked.toLowerCase() !== 'system default' ? picked : undefined
  let speaking: AbortController | undefined
  // Writes this chat's id to the owner file: the mic moves to this chat within a second.
  let claim: () => Promise<void> = async () => {}
  // Tells the listener to drop the request being spoken.
  let cancel: () => Promise<void> = async () => {}
  const hush = () => {
    speaking?.abort()
    speaking = undefined
  }

  on('session.start', async ($, e, next) => {
    const out = await next(e)
    const bin = `${$.plugin.root}/bin/hey-claude`
    const owner = `${$.plugin.root}/mic.owner`
    const id = await $.session.id()
    claim = () =>
      $.process.run(['sh', '-c', 'printf %s "$1" > "$2"', 'hey-claude', id, owner]).then(() => {}, () => {})
    cancel = async () => {
      await $.process.run(['touch', `${$.plugin.root}/cancel`]).catch(() => {})
      await update($, mic, m => (m.mode === 'awake' ? READY : m))
    }

    // Runs for the life of the session; the module unloading kills the child.
    const listen = async (): Promise<void> => {
      for (let failures = 0; failures < 3; ) {
        let code: number | null = null
        const started = await $.clock.now()
        try {
          const child = $.process.spawn({ argv: [bin, '--log', `${$.plugin.root}/listener.log`, '--speaking', `${$.plugin.root}/speaking`, '--owner', owner, '--id', id, '--cancel', `${$.plugin.root}/cancel`] })
          let buf = ''
          for await (const { stream, text } of child) {
            if (stream === 'stderr') {
              for (const line of text.split('\n').filter(Boolean)) {
                $.ui.log(`hey-claude: ${line}`, { to: line.startsWith('error:') ? 'transcript' : 'debug' })
              }
              continue
            }
            buf += text
            let i: number
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i)
              buf = buf.slice(i + 1)
              if (line === 'wake' || line === 'stop') {
                hush()
                await update($, said, () => NOTHING_SAID)
              }
              if (line === 'ready' || line === 'idle') await update($, mic, m => (m.mode === 'sending' || m.mode === 'sent' ? m : READY))
              else if (line === 'wake') await update($, mic, () => ({ mode: 'awake', heard: '' }))
              else if (line === 'cancelled') await update($, mic, () => READY)
              else if (line === 'busy') await update($, mic, () => ({ mode: 'busy', heard: '' }))
              else if (line.startsWith('heard\t')) await update($, mic, () => ({ mode: 'awake', heard: line.slice(6) }))
              else if (line.startsWith('miss\t')) await update($, mic, (m): Mic => (m.mode === 'ready' ? { ...READY, heard: line.slice(5) } : m))
              else if (line.startsWith('prompt\t')) {
                const text = line.slice(7)
                await update($, mic, () => ({ mode: 'sending', heard: text }))
                // The bar clears when Claude's reply starts streaming (turn.step below).
                void $.prompt
                  .submit({ text, asUser: true }) // your own words, shown as a typed prompt is
                  .then(() => $.clock.sleep(15_000)) // safety net if the row never shows
                  .catch(() => {})
                  .finally(() => update($, mic, m => ((m.mode === 'sending' || m.mode === 'sent') && m.heard === text ? READY : m)))
              }
            }
          }
          code = (await child.result).code
        } catch (err) {
          $.ui.log(`hey-claude: listener did not start: ${String(err)}`)
          return
        }
        await update($, mic, () => OFF)
        if (code === 2) return // permission or setup error, already shown
        // A crash within a minute counts as a failure; three in a row stop it.
        failures = (await $.clock.now()) - started < 60_000 ? failures + 1 : 0
        await $.clock.sleep(5000)
      }
      $.ui.log('hey-claude: the listener keeps stopping; restart the session to try again.')
    }
    void listen()
    return out
  })

  // The mic bar above the prompt box: dim while waiting, bright while listening.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, mic)
    if (state.mode === 'off' || e.props.hasSurvey) return next(e)
    const last = await read($, said)
    const { Box, Text } = $.ui.resolve(e)
    // Status on its own row, the words under it, so long text wraps instead of squeezing the label.
    const bar = (label: ReturnType<typeof Text>, words?: string, note?: string) => (
      <Box flexDirection="column">
        <Box>
          {label}
          {note ? <Text dimColor>{note}</Text> : null}
        </Box>
        {words ? <Text maxLines={10}>{words}</Text> : null}
      </Box>
    )
    // While listening, the newest words matter: keep the end of a long request.
    const tail = (t: string) => (t.length > 1200 ? '…' + t.slice(-1200) : t)
    switch (state.mode) {
      case 'sent':
        return bar(<Text color="claude" bold>{'✓ Sent'}</Text>, state.heard, '  · Claude is replying…')
      case 'sending':
        return bar(<Text color="claude" bold>{'↑ Sending to Claude…'}</Text>, state.heard)
      case 'busy': {
        const { Button } = $.ui.resolve(e)
        return (
          <Box>
            <Text dimColor>{'○ Mic is in another chat  '}</Text>
            <Button key="claim" label="Use mic here" onPress={() => claim()} />
          </Box>
        )
      }
      case 'awake': {
        const { Button } = $.ui.resolve(e)
        return (
          <Box flexDirection="column">
            <Box>
              <Text color="error" bold>{'● Listening…  '}</Text>
              <Button key="cancel" label="Cancel" onPress={() => cancel()} />
              <Text dimColor>{state.heard ? '  or say "cancel"' : '  speak now'}</Text>
            </Box>
            {state.heard ? <Text maxLines={10}>{tail(state.heard)}</Text> : null}
          </Box>
        )
      }
      default:
        if (last.text)
          return bar(
            <Text color="claude" bold>{last.speaking ? '▶ Claude is saying' : 'Claude said'}</Text>,
            last.text,
            '  · say "Hey Claude" to reply',
          )
        return bar(<Text dimColor>{'○ Mic on: say "Hey Claude"'}</Text>, undefined, state.heard ? `  · last heard "${tail(state.heard)}"` : undefined)
    }
  })

  // The prompt's row is stored: sent. The desktop app shows it only once the reply
  // starts streaming, so the bar holds the sent words until then.
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    if (e.agentId === undefined && e.origin.kind === 'plugin')
      await update($, mic, (m): Mic => (m.mode === 'sending' ? { ...m, mode: 'sent' } : m))
    return next(e)
  })

  // The reply's first streamed piece: the chat now shows the prompt and the reply.
  on('turn.step', async function* ($, e, next) {
    let first = e.agentId === undefined
    for await (const chunk of next(e)) {
      if (first) {
        first = false
        await update($, mic, m => (m.mode === 'sending' || m.mode === 'sent' ? READY : m))
      }
      yield chunk
    }
  })

  // A typed prompt stops whatever is still being spoken.
  on('prompt.submit', async ($, e, next) => {
    // Typing in a chat brings the mic to that chat.
    if (e.origin.kind !== 'plugin') void claim()
    hush()
    await update($, said, () => NOTHING_SAID)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return out
    const answer = plain(e.answer)
    if (!answer) return out

    let summary = answer
    if (answer.length > 240) {
      const r = await $.model.complete({
        model: 'haiku',
        system: SYSTEM,
        prompt: e.answer.slice(0, 20000),
        maxTokens: 150,
        effort: 'low',
        timeoutMs: 10000,
      })
      // Fallback: the answer's first sentence.
      summary = r.isAnswered && r.text.trim() ? plain(r.text) : (answer.split(/(?<=[.!?])\s/)[0] ?? answer).slice(0, 240)
    }

    // Ava saying "Hey Claude" would wake the mic and send her own words back.
    summary = summary.replace(/\b(hey|hi|okay|ok|hello)\W+claude\b/gi, 'the wake phrase')

    // You are speaking a new request: talking over it would put the summary's words into
    // your request. Show the summary in the bar instead of reading it out.
    if ((await update($, mic, m => m)).mode === 'awake') {
      await update($, said, () => ({ text: summary, speaking: false }))
      return out
    }

    hush()
    const ctl = new AbortController()
    speaking = ctl
    $.ui.log(`hey-claude: speaking ${summary.length} chars`, { to: 'debug' })
    await update($, said, () => ({ text: summary, speaking: true }))
    // The listener reads this flag so Ava saying "Claude" never wakes it.
    const flag = (v: string) =>
      $.process.run(['sh', '-c', 'printf %s "$1" > "$2"', 'hey-claude', v, `${$.plugin.root}/speaking`]).catch(() => {})
    await flag('1')
    // Ava (Premium) when installed, else the Mac's default voice, else macOS `say`.
    const speak = async () => {
      try {
        await $.audio.speak(summary, { voice: VOICE, signal: ctl.signal })
      } catch {
        if (ctl.signal.aborted) return
        try {
          await $.audio.speak(summary, { signal: ctl.signal })
        } catch (err) {
          if (ctl.signal.aborted) return
          $.ui.log(`hey-claude: built-in speech failed (${String(err)}), using say`)
          await $.process
            .run(['sh', '-c', 'say -- "$1" >/dev/null 2>&1', 'hey-claude', summary])
            .catch(e2 => $.ui.log(`hey-claude: say failed: ${String(e2)}`))
        }
      }
    }
    void speak().finally(async () => {
      await flag('0')
      await update($, said, s => (s.text === summary ? { ...s, speaking: false } : s))
    })
    return out
  })
}
