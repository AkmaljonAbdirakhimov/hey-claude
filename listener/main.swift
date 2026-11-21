// hey-claude listener, started by the hey-claude plugin inside Claude.
// Say "Hey Claude, <request>", then stay quiet for 4 seconds to send it. It writes one line per event to stdout:
//   ready           listening for the wake phrase
//   wake            the wake phrase was heard
//   heard<TAB>text  the request so far, while it is spoken
//   idle            back to waiting for the wake phrase
//   miss<TAB>text   last words heard that had no wake phrase in them
//   stop            "Hey Claude, stop"
//   prompt<TAB>text a request to send to Claude
// Logs go to stderr; lines starting "error:" are shown to the person.
// On-device Apple speech recognition; no network, no extra dependencies.
import AVFoundation
import Foundation
import Speech

let args = CommandLine.arguments

// macOS attributes privacy prompts to the "responsible" ancestor app. Under
// Claude that is Claude Code's helper, which has no speech-recognition usage
// string, so macOS kills us on first use. Re-spawn ourselves disclaimed: the
// child is responsible for itself and macOS reads our embedded Info.plist.
@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

if ProcessInfo.processInfo.environment["HEY_CLAUDE_CHILD"] == nil && !args.contains("--selftest") {
    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    _ = responsibility_spawnattrs_setdisclaim(&attr, 1)
    setenv("HEY_CLAUDE_CHILD", String(getpid()), 1)
    var pid: pid_t = 0
    let path = Bundle.main.executablePath ?? args[0]
    let cargs = args.map { strdup($0) } + [nil]
    guard posix_spawn(&pid, path, nil, &attr, cargs, environ) == 0 else {
        FileHandle.standardError.write(Data("error: could not start listener\n".utf8)); exit(2)
    }
    // Pass a kill on to the child, then exit with its status.
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        signal(sig, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: sig)
        src.setEventHandler { kill(pid, sig) }
        src.resume()
        _ = Unmanaged.passRetained(src as AnyObject)
    }
    DispatchQueue.global().async {
        var status: Int32 = 0
        waitpid(pid, &status, 0)
        let code = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
        exit(code)
    }
    dispatchMain()
}

// The child exits if its parent goes away (plugin unloaded, session ended).
if let parent = ProcessInfo.processInfo.environment["HEY_CLAUDE_CHILD"].flatMap({ pid_t($0) }) {
    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
        if getppid() != parent { exit(0) }
    }
}
func arg(_ name: String, _ fallback: String) -> String {
    if let i = args.firstIndex(of: name), i + 1 < args.count { return args[i + 1] }
    return fallback
}

let localeID = arg("--locale", "en-US")
// Seconds of quiet that end a request, and the wait for its first word after "Hey Claude".
let silence = Double(arg("--silence", "4")) ?? 4
let firstWord = Double(arg("--first-word", "8")) ?? 8
// The recognizer often mishears "Hey Claude": accept the common variants.
// "a" and "they" stay out: "a cloud" and "they claude" are ordinary speech.
let greetings = arg("--greetings", "hey,hi,hay,he,okay,ok,hello")
// Said alone at the start of what you say, these names also wake it ("Claude, what time is it").
let bareNames = arg("--bare-names", "claude,claud,clawd,klaud,clyde,clawed,claudia,clout,clouted,icloud")
// A file the plugin writes "1" to while it speaks: Ava saying "Claude" must not wake it.
let speakingFlag = arg("--speaking", "")
let names = arg("--names", "claude,claud,clod,cloud,clyde,clawed,clode,klaud,claudia,clout,caught,cod,claw,claws,clawd,clot")
func alternation(_ list: String) -> String {
    list.split(separator: ",").map { NSRegularExpression.escapedPattern(for: $0.trimmingCharacters(in: .whitespaces)) }
        .filter { !$0.isEmpty }.joined(separator: "|")
}
// `--log <file>`: a local trace of what the recognizer heard, for tuning the wake phrase.
let logFile: FileHandle? = {
    let path = arg("--log", "")
    guard !path.isEmpty, ProcessInfo.processInfo.environment["HEY_CLAUDE_CHILD"] != nil else { return nil }
    if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
    return FileHandle(forWritingAtPath: path)
}()
// Every open chat runs a listener; only the one with the mic writes the log, which it
// starts afresh when it takes the mic.
var traceOn = false
let started = Date()
func trace(_ s: String) {
    guard traceOn else { return }
    logFile?.seekToEndOfFile()
    logFile?.write(Data(String(format: "%7.2f %@\n", Date().timeIntervalSince(started), s).utf8))
}
func log(_ s: String) { trace(s); FileHandle.standardError.write(Data("\(s)\n".utf8)) }
func fail(_ s: String) -> Never { log("error: \(s)"); exit(2) }
func emit(_ s: String) { trace("> " + s); FileHandle.standardOutput.write(Data("\(s)\n".utf8)) }

/// True when `next` is not a revision of `prev` but a fresh start: after a pause the
/// recognizer drops what it heard before and transcribes only the new words.
func isNewSegment(_ prev: String, _ next: String) -> Bool {
    func firstWord(_ t: String) -> String {
        String(t.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber && $0 != "'" }).first ?? "")
    }
    let a = firstWord(prev), b = firstWord(next)
    if a.isEmpty || b.isEmpty { return false }
    return !(a.hasPrefix(b) || b.hasPrefix(a)) || next.count * 2 + 3 < prev.count
}

func run(_ path: String, _ arguments: [String], wait: Bool = true) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = arguments
    do { try p.run(); if wait { p.waitUntilExit() } } catch { log("cannot run \(path): \(error)") }
}

let wakeRegex = try! NSRegularExpression(
    pattern: "\\b(?:\(alternation(greetings)))[^\\p{L}]+(?:\(alternation(names)))\\b", options: .caseInsensitive)
let bareRegex = try! NSRegularExpression(pattern: "\\b(?:\(alternation(bareNames)))\\b", options: .caseInsensitive)

/// True while the plugin speaks, and for a second and a half after (the echo).
func isSpeaking() -> Bool {
    guard !speakingFlag.isEmpty, let text = try? String(contentsOfFile: speakingFlag, encoding: .utf8) else { return false }
    if text.hasPrefix("1") { return true }
    let changed = (try? FileManager.default.attributesOfItem(atPath: speakingFlag)[.modificationDate] as? Date) ?? .distantPast
    return Date().timeIntervalSince(changed) < 1.5
}

/// A recognized word: where it sits in the transcript and when it was spoken (seconds).
struct Word { let location: Int; let start: Double; let end: Double }

/// Seconds of quiet before "Hey Claude" that make it a fresh call, not words in a sentence.
let pauseBeforeWake = 0.6

/// True when the wake phrase at `loc` opens what was said: first in the transcript, or
/// after a pause. "...and I said hey Claude to him" in one breath is not a call.
func wakeStartsUtterance(at loc: Int, in ns: NSString, _ words: [Word]) -> Bool {
    if ns.substring(to: loc).trimmingCharacters(in: CharacterSet.punctuationCharacters.union(.whitespacesAndNewlines)).isEmpty {
        return true
    }
    // Word timings, when the recognizer gives them (partial results often carry zeros).
    guard let i = words.firstIndex(where: { $0.location >= loc }), i > 0, words[i].start > 0 else { return false }
    return words[i].start - words[i - 1].end >= pauseBeforeWake
}

/// Text after the last wake phrase that opens an utterance, or nil when there is none.
/// `bare` also takes a name said alone ("Claude, ...").
func commandAfterWake(_ text: String, _ words: [Word] = [], bare: Bool = false) -> String? {
    let ns = text as NSString
    let all = NSRange(location: 0, length: ns.length)
    let found = (wakeRegex.matches(in: text, range: all) + (bare ? bareRegex.matches(in: text, range: all) : []))
        .sorted { $0.range.location < $1.range.location }
    for m in found.reversed()
    where wakeStartsUtterance(at: m.range.location, in: ns, words) {
        return ns.substring(from: m.range.location + m.range.length)
            .trimmingCharacters(in: CharacterSet.punctuationCharacters.union(.whitespacesAndNewlines))
    }
    return nil
}

final class Listener {
    let recognizer: SFSpeechRecognizer
    let engine = AVAudioEngine()
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var generation = 0
    var isAwake = false
    var wakeInTask = false // the wake phrase was heard in the current task
    var committed = ""     // request text from earlier tasks of this request
    var current = ""       // request text from the current task
    var lastText = ""      // the current task's transcript, shown when no wake phrase was in it
    var emitted = ""
    var silenceTimer: Timer?
    var restartTimer: Timer?
    var kickTimer: Timer?
    var command: String { [committed, current].filter { !$0.isEmpty }.joined(separator: " ") }

    init() {
        guard let r = SFSpeechRecognizer(locale: Locale(identifier: localeID)), r.isAvailable else {
            fail("no speech recognizer for locale \(localeID)")
        }
        recognizer = r
    }

    var isRunning = false

    func start() throws {
        if isRunning { return }
        isRunning = true
        traceOn = true
        logFile?.truncateFile(atOffset: 0)
        let input = engine.inputNode
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { [weak self] buf, _ in
            self?.request?.append(buf)
        }
        engine.prepare()
        try engine.start()
        newTask()
        log("listening (\(localeID)) for: \(wakeRegex.pattern)")
        emit("ready")
    }

    /// Lets go of the mic (another chat has it).
    func stop() {
        if !isRunning { return }
        isRunning = false
        generation += 1
        [silenceTimer, restartTimer, kickTimer].forEach { $0?.invalidate() }
        task?.cancel()
        request?.endAudio()
        request = nil
        isAwake = false
        committed = ""
        lastText = ""
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        emit("busy")
        traceOn = false
    }

    /// A fresh recognition task. Tasks end on their own at a pause or after about a
    /// minute; while awake the request carries on into the next task.
    func newTask() {
        if !isAwake, let miss = lastWords(lastText) { emit("miss\t" + miss) }
        generation += 1
        let g = generation
        restartTimer?.invalidate()
        task?.cancel()
        request?.endAudio()
        wakeInTask = false
        current = ""
        lastText = ""
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        // Bias the recognizer toward the wake phrase; without this it often hears "cloud".
        req.contextualStrings = ["Hey Claude", "Claude"]
        request = req
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, g == self.generation else { return }
                self.handle(result, error)
            }
        }
        restartTimer = Timer.scheduledTimer(withTimeInterval: 50, repeats: false) { [weak self] _ in
            if self?.isAwake == false { self?.newTask() }
        }
    }

    func handle(_ result: SFSpeechRecognitionResult?, _ error: Error?) {
        let text = (result?.bestTranscription.formattedString ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text != lastText && !text.isEmpty { trace("  heard: " + text) }
        if let error { trace("  task ended: \(error.localizedDescription)") } else if result?.isFinal == true { trace("  task final") }
        let prevText = lastText
        if !text.isEmpty { lastText = text }
        var heard: String?
        let words = (result?.bestTranscription.segments ?? []).map {
            Word(location: $0.substringRange.location, start: $0.timestamp, end: $0.timestamp + $0.duration)
        }
        let call = commandAfterWake(text, words, bare: !isSpeaking())
        if call == nil && !isAwake && text != prevText
            && wakeRegex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) != nil {
            trace("  wake phrase inside a sentence, ignored")
        }
        if let c = call {
            if !wakeInTask && isAwake { committed = "" } // "Hey Claude" again: start over
            wakeInTask = true
            heard = c
        } else if isAwake && !text.isEmpty {
            // No wake phrase in it: words after a pause, which the recognizer transcribes
            // afresh. Keep what came before and add these.
            if wakeInTask || isNewSegment(current, text) {
                committed = command
                current = ""
                wakeInTask = false
            }
            heard = text
        }
        if let h = heard {
            if !isAwake {
                isAwake = true
                committed = ""
                emitted = ""
                emit("wake")
                run("/usr/bin/afplay", ["/System/Library/Sounds/Tink.aiff"], wait: false)
                armSilence()
            }
            current = h
            if command != emitted {
                emitted = command
                emit("heard\t" + command.replacingOccurrences(of: "\n", with: " "))
                armSilence()
            }
        }
        if error != nil || result?.isFinal == true {
            // The recognizer stopped at a pause. Awake, keep the words and go on listening;
            // only the silence timer ends a request.
            if isAwake { committed = command }
            newTask()
        }
    }

    /// Waits `firstWord` seconds for the request to begin, then `silence` after each word.
    /// Right after the wake the recognizer sometimes goes quiet: if no word comes in
    /// 3 seconds, a fresh task takes over (still awake).
    func armSilence() {
        silenceTimer?.invalidate()
        kickTimer?.invalidate()
        if command.isEmpty {
            kickTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
                guard let self, self.isAwake, self.command.isEmpty else { return }
                trace("  no words after the wake, fresh task")
                self.newTask()
            }
        }
        silenceTimer = Timer.scheduledTimer(withTimeInterval: command.isEmpty ? firstWord : silence, repeats: false) { [weak self] _ in
            self?.finish()
        }
    }

    func finish() {
        kickTimer?.invalidate()
        let cmd = command.trimmingCharacters(in: CharacterSet.punctuationCharacters.union(.whitespacesAndNewlines))
        silenceTimer?.invalidate()
        isAwake = false
        committed = ""
        lastText = ""
        newTask()
        if cmd.isEmpty { log("heard the wake phrase but no request") }
        else if cmd.lowercased() == "stop" { emit("stop") }
        else { emit("prompt\t" + cmd.replacingOccurrences(of: "\n", with: " ")) }
        emit("idle")
    }
}

/// The last few words of `text`, or nil when there are none.
func lastWords(_ text: String, _ n: Int = 6) -> String? {
    let words = text.split(whereSeparator: \.isWhitespace)
    return words.isEmpty ? nil : words.suffix(n).joined(separator: " ")
}

if args.contains("--selftest") {
    precondition(commandAfterWake("Hey Claude, what time is it?") == "what time is it")
    precondition(commandAfterWake("hey cloud open the plan") == "open the plan")
    precondition(commandAfterWake("hey Claude") == "")
    precondition(commandAfterWake("Hey Claude stop") == "stop")
    precondition(commandAfterWake("so I told my friend about the cloud") == nil)
    precondition(commandAfterWake("they claude nothing") == nil)
    precondition(commandAfterWake("a cloud passed") == nil)
    precondition(commandAfterWake("He caught what time is it") == "what time is it")
    precondition(commandAfterWake("Okay, Clyde. Open the file.") == "Open the file")
    precondition(commandAfterWake("Hey clawed what's new") == "what's new")
    // In the middle of a sentence it is not a call, unless a pause comes before it.
    precondition(commandAfterWake("I told him hey Claude is great") == nil)
    precondition(commandAfterWake("Claude what time is it") == nil)
    precondition(commandAfterWake("Claude what time is it", bare: true) == "what time is it")
    precondition(commandAfterWake("I like Claude a lot", bare: true) == nil)
    precondition(commandAfterWake("Cloud storage is cheap", bare: true) == nil)
    let said = "I told him hey Claude what time is it" as NSString
    func at(_ w: String) -> Int { said.range(of: w).location }
    let flowing = [Word(location: 0, start: 1.0, end: 1.2), Word(location: at("him"), start: 1.6, end: 1.8),
                   Word(location: at("hey"), start: 1.9, end: 2.1)]
    precondition(commandAfterWake(said as String, flowing) == nil)
    let paused = [Word(location: 0, start: 1.0, end: 1.2), Word(location: at("him"), start: 1.6, end: 1.8),
                  Word(location: at("hey"), start: 3.0, end: 3.2)]
    precondition(commandAfterWake(said as String, paused) == "what time is it")
    precondition(lastWords("one two three four five six seven") == "two three four five six seven")
    precondition(lastWords("  ") == nil)
    precondition(isNewSegment("what time is it", "and the date") == true)
    precondition(isNewSegment("what", "What's the time") == false)
    precondition(isNewSegment("what time", "What time is it") == false)
    precondition(isNewSegment("what time is it in Tashkent today", "what") == true)
    precondition(isNewSegment("", "hello") == false)
    print("selftest ok"); exit(0)
}

let listener = Listener()
AVCaptureDevice.requestAccess(for: .audio) { micOK in
    guard micOK else { fail("microphone access denied (System Settings > Privacy & Security > Microphone, allow Claude)") }
    SFSpeechRecognizer.requestAuthorization { status in
        DispatchQueue.main.async {
            guard status == .authorized else {
                fail("speech recognition not allowed (System Settings > Privacy & Security > Speech Recognition, allow Claude)")
            }
            followOwner()
        }
    }
}
// One mic for all chats. Each chat's listener has an id; the owner file names the chat
// that listens, and that chat's listener touches it every second. The plugin writes its
// chat's id there when you type in that chat or press "Use mic here". A file left
// untouched for 5 seconds (its chat closed) goes to whichever listener sees it first.
let ownerPath = arg("--owner", URL(fileURLWithPath: Bundle.main.executablePath ?? args[0])
    .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("mic.owner").path)
let myID = arg("--id", "\(getpid())")
func followOwner() {
    let check = {
        var mine = true
        if !ownerPath.isEmpty {
            let owner = (try? String(contentsOfFile: ownerPath, encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let touched = (try? FileManager.default.attributesOfItem(atPath: ownerPath)[.modificationDate] as? Date) ?? .distantPast
            if owner != myID && (owner.isEmpty || Date().timeIntervalSince(touched) > 5) {
                trace("taking the mic (owner \(owner.isEmpty ? "none" : owner) gone)")
                try? myID.write(toFile: ownerPath, atomically: true, encoding: .utf8)
                return // listen from the next check, after any other claim has landed
            }
            mine = owner == myID
            if mine { try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: ownerPath) }
        }
        if mine {
            do { try listener.start() } catch { fail("audio input failed: \(error)") }
        } else if listener.isRunning {
            listener.stop()
        } else if !sentBusy {
            sentBusy = true
            emit("busy")
        }
    }
    check()
    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in check() }
}
var sentBusy = false

RunLoop.main.run()
