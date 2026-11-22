import { atom, read, update } from 'claude-code'
import type { Register, RenderChildren } from 'claude-code'

import type { Mic, Said } from '../types'

// hey-claude: runs only inside Claude. The plugin starts the listener with the
// session and stops it with the session; spoken requests go in as prompts, and
// each answer's summary is spoken back. macOS and Windows.


// The spoken summary: result, the detail that matters, then what happens next.
const SYSTEM = [
  "You turn an assistant's answer into a short spoken update for the person who asked. They are listening, not reading.",
  'Write at most three short sentences, about 50 words, in this order:',
  '1. The result, first: what happened, or the answer itself.',
  '2. The one detail that matters most: a catch, a cause, a number, or what is not done or not checked yet.',
  '3. What happens next. If the answer asks the person a question or needs their decision, say that question word for word. ' +
    'Otherwise, if they must do something, say what. Otherwise leave this part out.',
  'Talk like a colleague: "I" is the assistant, "you" is the person. Plain spoken text: no markdown, lists, code, file paths, URLs or symbols.',
  "Use the answer's language. Say nothing the answer does not say.",
].join('\n')

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
  const setting = typeof options.voice === 'string' ? options.voice.trim() || DEFAULT : DEFAULT
  const voiceName = (stored: unknown) => (typeof stored === 'string' ? stored : setting)
  const asVoice = (name: string) => (name.toLowerCase() === DEFAULT ? undefined : name)
  let voices: Promise<string[]> | undefined
  // The request the current answer replies to, so the summary knows what mattered.
  let ask = ''
  let isWindows = false
  // Windows PowerShell 5.1, on every Windows 10 and 11, with System.Speech loaded.
  const ps = (script: string) => ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]
  const SYNTH = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; '
  let speaking: AbortController | undefined
  // Writes this chat's id to the owner file: the mic moves to this chat within a second.
  let claim: () => Promise<void> = async () => {}
  // Tells the listener to drop the request being spoken.
  let cancel: () => Promise<void> = async () => {}
  // The on/off switch: off closes the mic in every chat until it is turned on again.
  let switchOff: (off: boolean) => Promise<void> = async () => {}
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
    const files = ['--log', `${root}/listener.log`, '--speaking', `${root}/speaking`, '--owner', owner, '--id', id, '--cancel', `${root}/cancel`, '--paused', `${root}/paused`]
    // Same protocol on both: the Swift binary on macOS, a PowerShell script on Windows.
    const argv = isWindows
      ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${root}/listener/windows.ps1`,
         ...files.map(a => a.replace(/^--(\w)/, (_, c: string) => '-' + c.toUpperCase()))]
      : [`${root}/bin/hey-claude`, ...files]
    claim = () => $.fs.write(owner, id).catch(() => {})
    switchOff = async off => {
      await $.fs.write(`${root}/paused`, off ? '1' : '0').catch(() => {})
      // The listener answers within a second; show "off" at once.
      if (off) await update($, mic, () => ({ mode: 'paused', heard: '' }))
    }
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
              else if (line === 'paused') await update($, mic, () => ({ mode: 'paused', heard: '' }))
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
    // Right end of the idle bar only: the settings icon opens the settings pane.
    const gear = (
      <Button key="voice" onPress={() => void $.ui.open({ id: VOICES, title: 'hey-claude: voice', focus: true, closeOnEscape: true, rows: 16 })}>
        {/* The emoji form of the gear: the text glyph draws tiny, and a Button ignores its Text's size. */}
        <Text size="title">{'⚙\uFE0F'}</Text>
      </Button>
    )
    // The status and its controls on the left, the settings icon (idle bar only) at the
    // right end; spacing comes from the Boxes' gaps, not from spaces in the text.
    const row = (items: RenderChildren[], end?: RenderChildren) => (
      <Box justifyContent="space-between" alignItems="center" columnGap="lg">
        <Box alignItems="center" columnGap="md" flexShrink={1} flexWrap="wrap">
          {items}
        </Box>
        {end}
      </Box>
    )
    // Status on its own row, the words under it, so long text wraps instead of squeezing the label.
    const bar = (head: RenderChildren, words?: string) => (
      <Box flexDirection="column" rowGap="sm" paddingY="xs">
        {head}
        {words ? <Text maxLines={10}>{words}</Text> : null}
      </Box>
    )
    const status = (label: ReturnType<typeof Text>, note?: string, end?: RenderChildren) =>
      row([label, note ? <Text dimColor key="note">{note}</Text> : null], end)
    // While listening, the newest words matter: keep the end of a long request.
    const tail = (t: string) => (t.length > 1200 ? '…' + t.slice(-1200) : t)
    switch (state.mode) {
      case 'sent':
        return bar(status(<Text color="claude" bold key="label">{'✓ Sent'}</Text>, 'Claude is replying…'), state.heard)
      case 'sending':
        return bar(status(<Text color="claude" bold key="label">{'↑ Sending to Claude…'}</Text>), state.heard)
      case 'paused':
        return bar(
          row([
            <Text dimColor key="label">{'○ Mic off'}</Text>,
            <Button key="resume" label="Turn on" onPress={() => switchOff(false)} />,
          ]),
        )
      case 'busy':
        return bar(
          row([
            <Text dimColor key="label">{'○ Mic is in another chat'}</Text>,
            <Button key="claim" label="Use mic here" onPress={() => claim()} />,
          ]),
        )
      case 'awake':
        return bar(
          row([
            <Text color="error" bold key="label">{'● Listening…'}</Text>,
            <Button key="cancel" label="Cancel" onPress={() => cancel()} />,
            <Text dimColor key="hint">{state.heard ? 'or say "cancel"' : 'speak now'}</Text>,
          ]),
          state.heard ? tail(state.heard) : undefined,
        )
      default:
        if (last.text)
          return bar(
            // The settings icon only once Claude is done speaking: the bar is idle again.
            status(
              <Text color="claude" bold key="label">{last.speaking ? '▶ Claude is saying' : 'Claude said'}</Text>,
              'say "Hey Claude" to reply',
              last.speaking ? undefined : gear,
            ),
            last.text,
          )
        return bar(status(<Text dimColor key="label">{'○ Mic on: say "Hey Claude"'}</Text>, state.heard ? `last heard "${tail(state.heard)}"` : undefined, gear))
    }
  })

  // The voice picker: every English voice on this Mac. A pick is saved for every chat
  // and plays a short sample.
  on('ui.render', { component: 'Pane', requestId: VOICES }, async ($, e) => {
    const { Box, Text, Select, Button } = $.ui.resolve(e)
    const isOff = (await read($, mic)).mode === 'paused'
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
    const more = isWindows
      ? 'More voices: Settings > Time & language > Speech > Manage voices.'
      : 'More voices: System Settings > Accessibility > Spoken Content > System Voice > Manage Voices.'
    return (
      <Box flexDirection="column" padding="md" rowGap="lg">
        <Box justifyContent="space-between" alignItems="center" columnGap="lg">
          <Box flexDirection="column" rowGap="xs" flexShrink={1}>
            <Text bold>{'Listen for "Hey Claude"'}</Text>
            <Text dimColor>{isOff ? 'Off: the mic is closed in every chat.' : 'On: the mic listens in the chat you use.'}</Text>
          </Box>
          <Button
            key="listen"
            label={isOff ? 'Turn on' : 'Turn off'}
            variant={isOff ? 'primary' : 'secondary'}
            onPress={() => switchOff(!isOff)}
          />
        </Box>
        <Box flexDirection="column" rowGap="xs">
          <Text bold>{'Voice for spoken answers'}</Text>
          <Text dimColor>{'Pick a voice to hear it. The choice is saved for every chat.'}</Text>
        </Box>
        <Select
          key="pick"
          label="Voice"
          options={options}
          value={current}
          autoFocus
          onSelect={async name => {
            await $.store.set('voice', name)
            const who = name === DEFAULT ? 'the default voice' : name.replace(/\s*\(.*\)/, '')
            await $.audio.speak(`Hi, I'm ${who}.`, { voice: asVoice(name) }).catch(() => {})
          }}
        />
        <Text dimColor>{more}</Text>
        <Box justifyContent="flex-end">
          <Button key="done" label="Done" onPress={() => void $.ui.close({ id: VOICES })} />
        </Box>
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

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text.trim()) ask = e.text.trim()
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return out
    const answer = plain(e.answer)
    if (!answer) return out

    // A one-line answer ("It's 3 PM.") is read as it is.
    let summary = answer
    if (answer.length > 120) {
      const r = await $.model.complete({
        model: 'haiku',
        system: SYSTEM,
        prompt: `The request:\n${ask.slice(0, 2000) || '(not known)'}\n\nThe answer:\n${e.answer.slice(0, 20000)}`,
        maxTokens: 220,
        effort: 'low',
        timeoutMs: 12000,
      })
      // Fallback: the first sentence for the result and the last for what comes next.
      const sentences = answer.split(/(?<=[.!?])\s/)
      const ends = sentences.length > 1 ? `${sentences[0]} ${sentences[sentences.length - 1]}` : answer
      summary = r.isAnswered && r.text.trim() ? plain(r.text) : ends.slice(0, 400)
    }

    // The voice saying "Hey Claude" would wake the mic and send her own words back.
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
    // The listener reads this flag so the voice saying "Claude" never wakes it.
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
