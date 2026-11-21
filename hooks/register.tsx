import { atom, read, update } from 'claude-code'
import type { Register, RenderChildren } from 'claude-code'

import type { Mic, Said } from '../types'

// hey-claude: runs only inside Claude. The plugin starts the listener with the
// session and stops it with the session; spoken requests go in as prompts, and
// each answer's summary is spoken back. macOS and Windows.


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
const VOICES = 'hey-claude-voices'
const DEFAULT = 'system default'

// English voices installed: macOS `say -v '?'` lines, or Windows "name<TAB>en-US" lines.
// Premium and Enhanced first.
const parseVoices = (out: string) => {
  const names = new Set<string>()
  for (const line of out.split(/\r?\n/)) {
    const m = /^(.+?)\s+en_[A-Z]+\s+#/.exec(line) ?? /^(.+?)\ten-[A-Z]+$/.exec(line)
    if (m?.[1]) names.add(m[1].trim())
  }
  const good = (n: string) => (/\((Premium|Enhanced)\)/.test(n) ? 0 : 1)
  return [...names].sort((a, b) => good(a) - good(b) || a.localeCompare(b))
}

export const register: Register = (on, options) => {
  // The voice picked in the plugin's settings; a voice that is not installed falls back
  // to the system default.
  // A pick from the bar's Voice picker, kept in $.store, wins over the setting.
  const setting = typeof options.voice === 'string' ? options.voice.trim() || DEFAULT : 'Ava (Premium)'
  const voiceName = (stored: unknown) => (typeof stored === 'string' ? stored : setting)
  const asVoice = (name: string) => (name.toLowerCase() === DEFAULT ? undefined : name)
  let voices: Promise<string[]> | undefined
  let isWindows = false
  // Windows PowerShell 5.1, on every Windows 10 and 11, with System.Speech loaded.
  const ps = (script: string) => ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]
  const SYNTH = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; '
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
    const { platform } = await $.session.info()
    isWindows = platform === 'windows'
    if (platform !== 'macos' && !isWindows) {
      $.ui.log(`hey-claude: works on macOS and Windows only, not ${platform ?? 'this system'}.`)
      return out
    }
    const root = $.plugin.root
    const owner = `${root}/mic.owner`
    const id = await $.session.id()
    const files = ['--log', `${root}/listener.log`, '--speaking', `${root}/speaking`, '--owner', owner, '--id', id, '--cancel', `${root}/cancel`]
    // Same protocol on both: the Swift binary on macOS, a PowerShell script on Windows.
    const argv = isWindows
      ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${root}/listener/windows.ps1`,
         ...files.map(a => a.replace(/^--(\w)/, (_, c: string) => '-' + c.toUpperCase()))]
      : [`${root}/bin/hey-claude`, ...files]
    claim = () => $.fs.write(owner, id).catch(() => {})
    cancel = async () => {
      await $.fs.write(`${root}/cancel`, String(Date.now())).catch(() => {})
      await update($, mic, m => (m.mode === 'awake' ? READY : m))
    }

    // Runs for the life of the session; the module unloading kills the child.
    const listen = async (): Promise<void> => {
      for (let failures = 0; failures < 3; ) {
        let code: number | null = null
        const started = await $.clock.now()
        try {
          const child = $.process.spawn({ argv })
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
    const { Box, Text, Button } = $.ui.resolve(e)
    // Right end of the status row: opens the voice picker.
    const gear = (
      <Button
        key="voice"
        label="⚙ Voice"
        onPress={() => void $.ui.open({ id: VOICES, title: 'hey-claude: voice', focus: true, closeOnEscape: true, rows: 8 })}
      />
    )
    const row = (...items: RenderChildren[]) => (
      <Box justifyContent="space-between">
        <Box>{items}</Box>
        {gear}
      </Box>
    )
    // Status on its own row, the words under it, so long text wraps instead of squeezing the label.
    const bar = (label: ReturnType<typeof Text>, words?: string, note?: string) => (
      <Box flexDirection="column">
        {row(label, note ? <Text dimColor>{note}</Text> : null)}
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
      case 'busy':
        return row(
          <Text dimColor>{'○ Mic is in another chat  '}</Text>,
          <Button key="claim" label="Use mic here" onPress={() => claim()} />,
        )
      case 'awake': {
        return (
          <Box flexDirection="column">
            {row(
              <Text color="error" bold>{'● Listening…  '}</Text>,
              <Button key="cancel" label="Cancel" onPress={() => cancel()} />,
              <Text dimColor>{state.heard ? '  or say "cancel"' : '  speak now'}</Text>,
            )}
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

  // The voice picker: every English voice on this Mac. A pick is saved for every chat
  // and plays a short sample.
  on('ui.render', { component: 'Pane', requestId: VOICES }, async ($, e) => {
    const { Box, Text, Select, Button } = $.ui.resolve(e)
    voices ??= $.process
      .run(isWindows ? ps(SYNTH + '$s.GetInstalledVoices() | % { $_.VoiceInfo.Name + "`t" + $_.VoiceInfo.Culture.Name }') : ['say', '-v', '?'])
      .then(r => parseVoices(r.stdout), () => [])
    const current = voiceName(await $.store.get('voice'))
    const list = await voices
    const names = [DEFAULT, ...list.filter(n => n !== current), ...(current === DEFAULT ? [] : [current])]
    const options = [...new Set(names)].sort((a, b) => (a === current ? -1 : b === current ? 1 : 0)).map(n => ({
      value: n,
      label: n === DEFAULT ? 'System default' : n,
    }))
    return (
      <Box flexDirection="column">
        <Select
          key="pick"
          label="Voice: "
          options={options}
          value={current}
          autoFocus
          onSelect={async name => {
            await $.store.set('voice', name)
            await $.audio.speak(`Hi, I'm ${name === DEFAULT ? 'your Mac' : name.replace(/\s*\(.*\)/, '')}.`, { voice: asVoice(name) }).catch(() => {})
          }}
        />
        <Text dimColor>{'More voices: System Settings > Accessibility > Spoken Content > Manage Voices.'}</Text>
        <Button key="done" label="Done" onPress={() => void $.ui.close({ id: VOICES })} />
      </Box>
    )
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

    const VOICE = asVoice(voiceName(await $.store.get('voice')))
    hush()
    const ctl = new AbortController()
    speaking = ctl
    $.ui.log(`hey-claude: speaking ${summary.length} chars`, { to: 'debug' })
    await update($, said, () => ({ text: summary, speaking: true }))
    // The listener reads this flag so Ava saying "Claude" never wakes it.
    const flag = (v: string) => $.fs.write(`${$.plugin.root}/speaking`, v).catch(() => {})
    await flag('1')
    // The picked voice when installed, else the default voice, else `say` or Windows' synthesizer.
    const speak = async () => {
      try {
        await $.audio.speak(summary, { voice: VOICE, signal: ctl.signal })
      } catch {
        if (ctl.signal.aborted) return
        try {
          await $.audio.speak(summary, { signal: ctl.signal })
        } catch (err) {
          if (ctl.signal.aborted) return
          $.ui.log(`hey-claude: built-in speech failed (${String(err)}), using the system's`, { to: 'debug' })
          await $.process
            .run(isWindows ? ps(SYNTH + 'if ($env:HC_VOICE) { try { $s.SelectVoice($env:HC_VOICE) } catch {} }; $s.Speak([Console]::In.ReadToEnd())') : ['say', '-f', '-'], {
              stdin: summary,
              env: { HC_VOICE: VOICE ?? '' },
              timeoutMs: 120_000,
            })
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
