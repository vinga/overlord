// overlord-speech: on-device macOS speech recognition for Overlord voice input.
//
// Protocol: JSON lines.
//   stdin:  {"cmd":"start","lang":"pl-PL"} | {"cmd":"stop"} | {"cmd":"reset"}
//   stdout: {"type":"ready"}
//           {"type":"result","transcript":"…","isFinal":false}
//           {"type":"error","message":"…"}
//
// `transcript` is always the COMPLETE text of the current utterance, never a
// delta — the same contract as the browser WebSpeechProvider. Apple ends a
// recognition task on its own (time limit, long silence); while running we
// restart it and carry the finalized text forward, so the consumer sees one
// continuous stream. The process exits when stdin closes.
//
// `--selftest [lang]` prints authorization + on-device support and exits.

import AVFoundation
import Foundation
import Speech

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

func emitError(_ message: String) { emit(["type": "error", "message": message]) }

final class Recognizer {
    private let engine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var lang = "en-US"
    private var running = false
    private var tapInstalled = false
    /// Finalized text of earlier tasks in the same utterance.
    private var carry = ""
    /// Latest text of the current task.
    private var current = ""
    /// Bumped on every task start; callbacks from older tasks are ignored.
    private var generation = 0
    private var consecutiveFailures = 0
    /// The last result closed a pause-delimited chunk (it had real word timings).
    private var lastSettled = false
    /// Soft reset: words at the start of the current chunk that belong to the
    /// discarded utterance. Restarting the task instead would lose the first
    /// syllables of the next phrase — often the start word itself.
    private var skipWords = 0
    private var taskStartedAt = Date()
    private var lastResultAt = Date()
    private var watchdog: Timer?
    private let bufferLock = NSLock()
    private var lastBufferAtStore = Date()
    private var lastBufferAt: Date {
        get { bufferLock.lock(); defer { bufferLock.unlock() }; return lastBufferAtStore }
        set { bufferLock.lock(); lastBufferAtStore = newValue; bufferLock.unlock() }
    }
    private var configObserver: NSObjectProtocol?

    /// A recognition task older than this is replaced at the next quiet moment:
    /// long-lived on-device tasks go silent without reporting an error.
    private let taskMaxAge: TimeInterval = 45
    /// Cap on the text carried while idle (wake mode never resets otherwise).
    private let carryMaxWords = 1000

    func start(lang: String) {
        if running && lang == self.lang { return }
        if running { stop() }
        self.lang = lang
        authorize { [weak self] ok in
            guard let self else { return }
            guard ok else { return }
            guard let rec = SFSpeechRecognizer(locale: Locale(identifier: lang)) else {
                emitError("Speech recognition does not support language \(lang)")
                return
            }
            guard rec.supportsOnDeviceRecognition else {
                emitError("No on-device speech model for \(lang). Download it in System Settings → Keyboard → Dictation, or use the Chrome engine.")
                return
            }
            self.recognizer = rec
            self.running = true
            self.carry = ""
            self.current = ""; lastSettled = false
            do {
                try self.startAudio()
            } catch {
                self.running = false
                emitError("Microphone could not start: \(error.localizedDescription)")
                return
            }
            self.startTask()
            self.startWatchdog()
        }
    }

    func stop() {
        running = false
        generation += 1
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        engine.stop()
        watchdog?.invalidate()
        watchdog = nil
        if let obs = configObserver {
            NotificationCenter.default.removeObserver(obs)
            configObserver = nil
        }
        carry = ""
        current = ""; lastSettled = false
        skipWords = 0
    }

    /// Drops the utterance so far WITHOUT restarting the task: the words already
    /// in the current chunk are skipped from now on.
    func reset() {
        skipWords += words(current).count
        carry = ""
        current = ""
    }

    private func startAudio() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        if !tapInstalled {
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                guard let self else { return }
                self.lastBufferAt = Date()
                self.request?.append(buffer)
            }
            tapInstalled = true
        }
        engine.prepare()
        try engine.start()
        lastBufferAt = Date()
        if configObserver == nil {
            // Input device changed (AirPods, sleep/wake): the engine stops and
            // the tap's format is stale. Rebuild both.
            configObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
            ) { [weak self] _ in self?.restartAudio() }
        }
    }

    private func restartAudio() {
        guard running else { return }
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        engine.stop()
        do {
            try startAudio()
        } catch {
            emitError("Microphone could not restart: \(error.localizedDescription)")
            return
        }
        refreshTask()
    }

    /// Replaces a stale task at a quiet moment, and revives a dead microphone.
    private func startWatchdog() {
        watchdog?.invalidate()
        watchdog = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            guard let self, self.running else { return }
            let now = Date()
            if now.timeIntervalSince(self.lastBufferAt) > 5 {
                self.restartAudio()
                return
            }
            let quiet = now.timeIntervalSince(self.lastResultAt) > 1.5
            if quiet && now.timeIntervalSince(self.taskStartedAt) > self.taskMaxAge {
                self.refreshTask()
            }
        }
    }

    /// Starts a fresh task, keeping the text heard so far.
    private func refreshTask() {
        generation += 1
        task?.cancel()
        rollover()
    }

    private func startTask() {
        guard running, let rec = recognizer else { return }
        generation += 1
        let gen = generation
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
        if #available(macOS 13, *) { req.addsPunctuation = false }
        request = req
        current = ""; lastSettled = false
        skipWords = 0
        taskStartedAt = Date()
        task = rec.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, gen == self.generation else { return }
                if let result {
                    self.consecutiveFailures = 0
                    // On-device recognition splits speech at pauses WITHOUT ending
                    // the task: a chunk closes with one result carrying real word
                    // timestamps, then the next chunk restarts from empty with
                    // placeholder timestamps (0.00+0.01). Without carrying the closed
                    // chunk forward, "overlord <pause> say hi" would become just
                    // "say hi" and the voice agent would lose its start word.
                    let settled = result.bestTranscription.segments.contains {
                        $0.timestamp > 0.05 || $0.duration > 0.05
                    }
                    if self.lastSettled && !settled {
                        // A new chunk: the closed one is kept, nothing in the new one is stale.
                        if !self.current.isEmpty { self.carry = self.joined() }
                        self.skipWords = 0
                    }
                    self.lastSettled = settled
                    self.lastResultAt = Date()
                    let chunk = self.words(result.bestTranscription.formattedString)
                    self.current = chunk.dropFirst(min(self.skipWords, chunk.count)).joined(separator: " ")
                    let text = self.joined()
                    if !text.isEmpty {
                        emit(["type": "result", "transcript": text, "isFinal": result.isFinal])
                    }
                    if result.isFinal { self.rollover() }
                    return
                }
                if let error {
                    let ns = error as NSError
                    // 1110 = no speech detected, 216/301 = cancelled: routine, just restart.
                    let routine = (ns.domain == "kAFAssistantErrorDomain" && [1110, 216, 301].contains(ns.code))
                    if !routine {
                        self.consecutiveFailures += 1
                        // Apple's recognizer refuses to run while Dictation is off.
                        let dictationOff = error.localizedDescription.contains("Dictation are disabled")
                        if dictationOff {
                            emitError("macOS Dictation is off. Turn it on in System Settings → Keyboard → Dictation, then try again.")
                            self.stop()
                            return
                        }
                        emitError(error.localizedDescription)
                    }
                    if self.consecutiveFailures >= 5 {
                        emitError("Speech recognition keeps failing; stopped.")
                        self.stop()
                        return
                    }
                    self.rollover()
                }
            }
        }
    }

    /// The current task ended: keep its text, start a fresh task.
    private func rollover() {
        let all = words(joined())
        carry = all.suffix(carryMaxWords).joined(separator: " ")
        current = ""; lastSettled = false
        task = nil
        request?.endAudio()
        request = nil
        if running { startTask() }
    }

    private func words(_ s: String) -> [String] {
        return s.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    }

    private func joined() -> String {
        return "\(carry) \(current)"
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
    }

    private func authorize(_ done: @escaping (Bool) -> Void) {
        AVCaptureDevice.requestAccess(for: .audio) { micOk in
            DispatchQueue.main.async {
                guard micOk else {
                    emitError("not-allowed: microphone access denied. Allow it in System Settings → Privacy & Security → Microphone for the app that started the Overlord server.")
                    done(false)
                    return
                }
                SFSpeechRecognizer.requestAuthorization { status in
                    DispatchQueue.main.async {
                        if status == .authorized { done(true); return }
                        emitError("not-allowed: speech recognition access denied. Allow it in System Settings → Privacy & Security → Speech Recognition.")
                        done(false)
                    }
                }
            }
        }
    }
}

func selftest(lang: String) {
    let mic = AVCaptureDevice.authorizationStatus(for: .audio)
    let speech = SFSpeechRecognizer.authorizationStatus()
    let rec = SFSpeechRecognizer(locale: Locale(identifier: lang))
    let micName = ["notDetermined", "restricted", "denied", "authorized"][Int(mic.rawValue)]
    let speechName = ["notDetermined", "denied", "restricted", "authorized"][Int(speech.rawValue)]
    emit([
        "type": "selftest",
        "lang": lang,
        "microphone": micName,
        "speechRecognition": speechName,
        "supported": rec != nil,
        "onDevice": rec?.supportsOnDeviceRecognition ?? false,
    ])
}

let args = CommandLine.arguments
if args.count > 1 && args[1] == "--selftest" {
    selftest(lang: args.count > 2 ? args[2] : "en-US")
    exit(0)
}

setvbuf(stdout, nil, _IONBF, 0)
let recognizer = Recognizer()

// stdin on a background thread; every command runs on the main queue.
Thread.detachNewThread {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cmd = obj["cmd"] as? String else { continue }
        DispatchQueue.main.async {
            switch cmd {
            case "start": recognizer.start(lang: (obj["lang"] as? String) ?? "en-US")
            case "stop": recognizer.stop()
            case "reset": recognizer.reset()
            default: break
            }
        }
    }
    DispatchQueue.main.async {
        recognizer.stop()
        exit(0)
    }
}

emit(["type": "ready"])
dispatchMain()
