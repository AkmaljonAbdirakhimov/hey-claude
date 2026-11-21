# hey-claude

Talk to Claude hands-free in the Claude desktop app on macOS. Say **"Hey Claude"**,
ask your question, and Claude answers. A short spoken summary of the answer is read
aloud and shown above the prompt box.

It runs inside Claude only: the plugin starts a small listener when a Claude Code
session starts and stops it when the session ends. Speech recognition is Apple's,
on your Mac: your voice never leaves the computer.

![The hey-claude bar above the prompt box: waiting, listening, sending, sent, speaking](docs/bars.svg)

## Install

![Install: plus button, Plugins, Add marketplace, Add plugin](docs/install.svg)

In the Claude desktop app: click **+** next to the prompt box, then **Plugins**,
**Add marketplace**, type `AkmaljonAbdirakhimov/hey-claude`, then **Add plugin**.

Or, in a Claude Code terminal session:

```
/plugin install hey-claude --marketplace AkmaljonAbdirakhimov/hey-claude
```

Answer `y` to add the marketplace, then pick a scope (user scope puts it in every chat).

The first time it runs, macOS asks for **Microphone** and **Speech Recognition**
access. Click **Allow** for both. Nothing needs to be built or configured.

## Use

- Say **"Hey Claude"** (or just **"Claude"** at the start of a sentence), then your request.
  You can pause while you think; 4 seconds of quiet sends it.
- The bar above the prompt box shows what is happening: `○ Mic on`, `● Listening…`
  with your words, `↑ Sending…`, `✓ Sent`, then `▶ Claude is saying` with the summary.
  **⚙ Voice** at its right end picks the voice.
- Changed your mind? Press **Cancel** in the bar, or end with **"cancel"** or
  **"never mind"**, and nothing is sent.
- Say **"Hey Claude, stop"**, or type a prompt, to stop the speech.
- With several chats open, one has the mic: the last chat you typed in. Other chats
  show **Use mic here** to take it.

## Requirements and limits

- macOS 13 or later, Apple Silicon or Intel.
- The Claude desktop app, or Claude Code in a terminal, recent enough for plugin
  hooks modules (tested with Claude Code 2.1.326).
- English only by default. Apple's on-device recognizer must support the language;
  Uzbek, for one, is not supported.
- The wake phrase works best said on its own, at the start of what you say. "Hey Claude"
  in the middle of a sentence is ignored on purpose.
- The summary is spoken in the voice you pick (below); one that is not installed
  falls back to your Mac's default voice.
- Summaries of long answers are written by Claude Haiku, which uses your Claude plan.

## Choose the voice

Click **⚙ Voice** at the right end of the bar. A list of the English voices on your Mac
opens; pick one and it says hello in that voice. The choice is saved for every chat.
Press **Done** or Esc to close the list.

The default is **Ava (Premium)**, from the plugin's **Voice** setting (`/config` in a
terminal session). A voice picked in the bar wins over that setting.

Premium and Enhanced voices sound much better than the built-in ones and are listed
first. Download them in System Settings > Accessibility > Spoken Content > System Voice >
**Manage Voices**, then open the list again.

## Advanced settings

Edit `listener/main.swift`, then run `./build.sh`:

- Language: the listener takes `--locale ru-RU` (default `en-US`).
- Timing: `--silence 4` seconds of quiet send the request; `--first-word 8` seconds to
  start talking after "Hey Claude".
- Wake phrase: a greeting (`--greetings`) followed by a name (`--names`), or a name alone
  at the start (`--bare-names`). The defaults include common mishearings.

## Troubleshooting

- Nothing happens: check System Settings > Privacy & Security > Microphone and Speech
  Recognition, and allow `hey-claude` (or Claude).
- `listener.log` in the plugin folder traces what the recognizer heard in the chat that
  has the mic. It starts empty each time that chat takes the mic and never leaves your
  computer. Delete the `--log` argument in `hooks/register.tsx` to turn it off.

## Build

```bash
./build.sh
```

Compiles `listener/main.swift` into a universal `bin/hey-claude` (Apple Silicon and Intel)
and runs its self-test. Needs the Xcode command line tools.
