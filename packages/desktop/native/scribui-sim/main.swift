// scribui-sim: the iOS Simulator's live screen and input for the desktop app.
//
// One long-lived process per shown simulator, so a touch costs milliseconds
// instead of a process launch. Built on idb's FBSimulatorControl (MIT), as
// shipped with AXe (scripts/build-sim-helper.mjs links against it).
//
//   scribui-sim serve --udid <udid> [--scale 0.5] [--fps 60]
//   scribui-sim describe --udid <udid> [--remote-step 25]
//
// `describe` prints the frontmost app's accessibility tree (nested JSON) and
// exits. Web views run in another process and are found by hit-testing a grid
// of points; idb remembers what it found for the rest of the process and skips
// it the next time, so the tree for a capture always comes from a fresh one.
//
// stdin: one JSON command per line (all coordinates in portrait points, the
// way the Simulator's HID takes them):
//   {"op":"stream","on":true}                     start/stop the H.264 stream
//   {"op":"keyframe"}                             restart it (SPS, PPS, IDR come first)
//   {"op":"touch","down":true,"x":10,"y":20}      down / move (another down) / up
//   {"op":"button","name":"home"|"lock"}
//   {"op":"key","code":40}                        a HID usage (keyboard page)
//   {"op":"press","code":4,"shift":false,"alt":false}  a key with modifiers; the simulator's layout makes it a character
//   {"op":"paste"}                                Cmd+V (after `simctl pbcopy`)
//   {"op":"orientation","value":"portrait"|"landscapeLeft"|"landscapeRight"|"portraitUpsideDown"}
//   {"id":1,"op":"describe"}                      the frontmost app's accessibility tree
//   {"id":2,"op":"ping"}
//
// stdout: frames of [kind: u8][length: u32 BE][payload]
//   kind 1: one H.264 NAL unit, Annex B (start code included)
//   kind 2: JSON: {"event":"ready"}, {"event":"error","message"}, or {"id":n,"ok":true,"data"?:…} / {"id":n,"ok":false,"message"}

import Foundation
import FBControlCore
import FBSimulatorControl

let out = FileHandle.standardOutput
let outLock = NSLock()

func emit(_ kind: UInt8, _ payload: Data) {
  var header = Data([kind])
  var len = UInt32(payload.count).bigEndian
  header.append(Data(bytes: &len, count: 4))
  outLock.lock()
  defer { outLock.unlock() }
  out.write(header + payload)
}

func emitJSON(_ obj: [String: Any]) {
  if let d = try? JSONSerialization.data(withJSONObject: obj) { emit(2, d) }
}

func log(_ s: String) {
  FileHandle.standardError.write(Data((s + "\n").utf8))
}

final class Logger: NSObject, FBControlCoreLogger {
  let verbose = ProcessInfo.processInfo.environment["SCRIBUI_SIM_VERBOSE"] == "1"
  var name: String? { nil }
  var level: FBControlCoreLogLevel { .multiple }
  func log(_ string: String) -> FBControlCoreLogger {
    if verbose { FileHandle.standardError.write(Data(("fb: " + string + "\n").utf8)) }
    return self
  }
  func info() -> FBControlCoreLogger { self }
  func debug() -> FBControlCoreLogger { self }
  func error() -> FBControlCoreLogger { self }
  func withName(_ name: String) -> FBControlCoreLogger { self }
  func withDateFormatEnabled(_ enabled: Bool) -> FBControlCoreLogger { self }
}

/// The encoder writes one NAL unit per call; each goes out as its own frame.
final class VideoSink: NSObject, FBDataConsumer, FBDataConsumerSync {
  func consumeData(_ data: Data) { emit(1, data) }
  func consumeEndOfFile() {}
}

let shiftKey: UInt32 = 225
let optionKey: UInt32 = 226
let commandKey: UInt32 = 227

@main
struct Main {
  static func main() async {
    let args = CommandLine.arguments
    func arg(_ name: String) -> String? {
      guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
      return args[i + 1]
    }
    guard args.count > 1, args[1] == "serve" || args[1] == "describe", let udid = arg("--udid") else {
      log("usage: scribui-sim serve --udid <udid> [--scale 0.5] [--fps 60] | describe --udid <udid> [--remote-step 25]")
      exit(2)
    }
    if args[1] == "describe" {
      do {
        // --region x,y,w,h: where to hit-test, in the HID's portrait points (idb takes the
        // app's frame otherwise, which is turned in landscape and misses most of the screen)
        let r = (arg("--region") ?? "").split(separator: ",").compactMap { Double($0) }
        let region = r.count == 4 ? CGRect(x: r[0], y: r[1], width: r[2], height: r[3]) : CGRect.null
        let tree = try await describeOnce(udid: udid, remoteStep: Double(arg("--remote-step") ?? "") ?? 25, region: region)
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: tree))
        exit(0)
      } catch {
        log("\(error)")
        exit(1)
      }
    }
    let scale = Double(arg("--scale") ?? "") ?? 0.5
    let fps = Int(arg("--fps") ?? "")
    do {
      try await Server(udid: udid, scale: scale, fps: fps).run()
    } catch {
      emitJSON(["event": "error", "message": "\(error)"])
      exit(1)
    }
    exit(0)
  }
}

@MainActor
func bootedSimulator(_ udid: String, logger: Logger) throws -> FBSimulator {
  try FBSimulatorControlFrameworkLoader.essentialFrameworks.loadPrivateFrameworks(logger)
  try FBSimulatorControlFrameworkLoader.xcodeFrameworks.loadPrivateFrameworks(logger)
  let set = try FBSimulatorControl.withConfiguration(
    FBSimulatorControlConfiguration(deviceSetPath: nil, logger: logger, reporter: nil)
  ).set
  guard let sim = set.allSimulators.first(where: { $0.udid == udid }) else {
    throw NSError(domain: "scribui-sim", code: 1, userInfo: [NSLocalizedDescriptionKey: "no simulator \(udid)"])
  }
  guard sim.state == .booted else {
    throw NSError(domain: "scribui-sim", code: 2, userInfo: [NSLocalizedDescriptionKey: "\(sim.name) isn't booted"])
  }
  return sim
}

@MainActor
func describeOnce(udid: String, remoteStep: Double, region: CGRect) async throws -> Any {
  let sim = try bootedSimulator(udid, logger: Logger())
  let el = try await sim.accessibilityElementForFrontmostApplication()
  defer { el.close() }
  let r = try el.serialize(
    with: FBAccessibilityRequestOptions(
      nestedFormat: true,
      remoteContentOptions: remoteStep > 0 ? FBAccessibilityRemoteContentOptions(gridStepSize: CGFloat(remoteStep), region: region) : nil
    ))
  return r.elements
}

@MainActor
final class Server {
  let udid: String
  let scale: Double
  let fps: Int?
  let logger = Logger()
  var sim: FBSimulator!
  var hid: FBSimulatorHID!
  var stream: (any FBVideoStream)?

  init(udid: String, scale: Double, fps: Int?) {
    self.udid = udid
    self.scale = scale
    self.fps = fps
  }

  func run() async throws {
    let sim = try bootedSimulator(udid, logger: logger)
    self.sim = sim
    self.hid = try await sim.connectToHID()
    emitJSON(["event": "ready", "name": sim.name])

    // commands, one per line, handled in order
    let lines = AsyncStream<String> { cont in
      Thread.detachNewThread {
        while let line = readLine(strippingNewline: true) { cont.yield(line) }
        cont.finish()
      }
    }
    for await line in lines {
      guard let data = line.data(using: .utf8),
        let cmd = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
        let op = cmd["op"] as? String
      else { continue }
      let id = cmd["id"]
      do {
        let result = try await handle(op, cmd)
        if let id {
          var reply: [String: Any] = ["id": id, "ok": true]
          if let result { reply["data"] = result }
          emitJSON(reply)
        }
      } catch {
        if let id { emitJSON(["id": id, "ok": false, "message": "\(error)"]) }
        else { emitJSON(["event": "warning", "message": "\(op): \(error)"]) }
      }
    }
    // stdin closed: the app is gone
    if let s = stream { try? await s.stopStreamingAsync() }
    hid.disconnect()
  }

  func send(_ e: FBSimulatorHIDEvent) async throws {
    try await hid.send(event: e, logger: logger)
  }

  func handle(_ op: String, _ cmd: [String: Any]) async throws -> Any? {
    switch op {
    case "ping":
      return "pong"
    case "stream":
      if cmd["on"] as? Bool == false { try await stopStream() } else { try await startStream() }
    case "keyframe":
      if stream != nil {
        try await stopStream()
        try await startStream()
      }
    case "touch":
      guard let x = cmd["x"] as? Double, let y = cmd["y"] as? Double else { return nil }
      try await send(.touch(direction: (cmd["down"] as? Bool ?? false) ? .down : .up, x: x, y: y))
    case "button":
      let b: FBSimulatorHIDButton = (cmd["name"] as? String) == "lock" ? .lock : .homeButton
      try await send(.shortButtonPress(b))
    case "key":
      guard let code = cmd["code"] as? Int else { return nil }
      try await send(.shortKeyPress(UInt32(code)))
    case "press":
      guard let code = cmd["code"] as? Int else { return nil }
      let mods = [(cmd["shift"] as? Bool ?? false, shiftKey), (cmd["alt"] as? Bool ?? false, optionKey)].filter { $0.0 }.map { $0.1 }
      var events: [FBSimulatorHIDEvent] = mods.map { .keyboard(direction: .down, keyCode: $0) }
      events.append(.keyboard(direction: .down, keyCode: UInt32(code)))
      events.append(.keyboard(direction: .up, keyCode: UInt32(code)))
      events += mods.reversed().map { .keyboard(direction: .up, keyCode: $0) }
      try await send(.composite(events))
    case "paste":
      try await send(
        .composite([
          .keyboard(direction: .down, keyCode: commandKey),
          .keyboard(direction: .down, keyCode: 25),
          .keyboard(direction: .up, keyCode: 25),
          .keyboard(direction: .up, keyCode: commandKey),
        ]))
    case "orientation":
      let o: FBSimulatorHIDDeviceOrientation
      switch cmd["value"] as? String {
      case "landscapeLeft": o = .landscapeLeft
      case "landscapeRight": o = .landscapeRight
      case "portraitUpsideDown": o = .portraitUpsideDown
      default: o = .portrait
      }
      try await send(.deviceOrientation(o))
    case "describe":
      let el = try await sim.accessibilityElementForFrontmostApplication()
      defer { el.close() }
      // the app's own elements only: web views need `scribui-sim describe` (see the top)
      let r = try el.serialize(with: FBAccessibilityRequestOptions(nestedFormat: true))
      return r.elements
    case "screen":
      // the frontmost app's frame in points: landscape when the UI is turned
      let el = try await sim.accessibilityElementForFrontmostApplication()
      defer { el.close() }
      let r = try el.serialize(with: FBAccessibilityRequestOptions(nestedFormat: false, keys: [.frameDict, .label]))
      let first = (r.elements as? [[String: Any]])?.first ?? (r.elements as? [String: Any])
      return first
    default:
      throw NSError(domain: "scribui-sim", code: 3, userInfo: [NSLocalizedDescriptionKey: "unknown op \(op)"])
    }
    return nil
  }

  func startStream() async throws {
    if stream != nil { return }
    let config = FBVideoStreamConfiguration(
      format: .compressedVideo(withCodec: .h264, transport: .annexB),
      framesPerSecond: fps.map { NSNumber(value: $0) },
      rateControl: nil,
      scaleFactor: NSNumber(value: scale),
      keyFrameRate: nil
    )
    let s = try await sim.createStream(configuration: config)
    try await s.startStreamingAsync(VideoSink())
    stream = s
  }

  func stopStream() async throws {
    guard let s = stream else { return }
    stream = nil
    try await s.stopStreamingAsync()
  }
}
