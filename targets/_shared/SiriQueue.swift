import Foundation

/// App Group storage shared by the Siri intent and the app (spec 4.9).
/// Layout: siri/pending/<id>.json (queued adds), siri/lists.json (list snapshot), logs/native.log.
enum SiriQueue {
  static let appGroupId = "group.com.jgp.perfectbite"

  /// Mirrors `SiriEnvelopeSchema` in src/shared/schemas/siri.ts. Keep in sync by hand.
  struct Envelope: Codable {
    let id: String
    let source: String
    let text: String
    var listId: String?
    let createdAt: String
    var locale: String?
    let appVersion: String
  }

  /// Mirrors `ListSnapshotSchema` in src/shared/schemas/siri.ts.
  struct ListSnapshot: Codable {
    struct List: Codable {
      let id: String
      let name: String
      /// Optional so a snapshot written by an older app still decodes. Siri doesn't use it.
      var householdId: String?
      let householdName: String
    }
    struct Household: Codable {
      let id: String
      let name: String
    }
    var defaultListId: String?
    /// The list screen last opened in the app, or null. The share sheet's default list.
    var lastOpenedListId: String?
    var lists: [List]
    /// Every household, in order, including any with no lists; the share sheet's Save to (spec 4.10).
    /// Optional so a snapshot written by an older app still decodes. Siri doesn't use it.
    var households: [Household]?
    /// The signed-in user, for the share envelope and the device credential (spec 4.10). Siri doesn't use it.
    var userId: String?
  }

  enum QueueError: Error {
    case noContainer
  }

  static func container() throws -> URL {
    guard let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
      throw QueueError.noContainer
    }
    return url
  }

  static func pendingDir() throws -> URL {
    let dir = try container().appendingPathComponent("siri/pending", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  static func makeEnvelope(text: String, listId: String?) -> Envelope {
    let formatter = ISO8601DateFormatter()
    formatter.timeZone = .current
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    return Envelope(
      id: uuidV7(), source: "siri", text: text, listId: listId,
      createdAt: formatter.string(from: Date()),
      locale: Locale.current.identifier(.bcp47), appVersion: version)
  }

  /// Atomic write: `<id>.json.tmp` then rename to `<id>.json`.
  static func enqueue(_ envelope: Envelope) throws {
    let dir = try pendingDir()
    let tmp = dir.appendingPathComponent("\(envelope.id).json.tmp")
    let final = dir.appendingPathComponent("\(envelope.id).json")
    let data = try JSONEncoder().encode(envelope)
    try data.write(to: tmp, options: .completeFileProtectionUntilFirstUserAuthentication)
    try FileManager.default.moveItem(at: tmp, to: final)
  }

  /// The last snapshot the app wrote, or an empty one.
  static func loadLists() -> ListSnapshot {
    guard
      let url = try? container().appendingPathComponent("siri/lists.json"),
      let data = try? Data(contentsOf: url),
      let snapshot = try? JSONDecoder().decode(ListSnapshot.self, from: data)
    else { return ListSnapshot(defaultListId: nil, lastOpenedListId: nil, lists: [], households: []) }
    return snapshot
  }

  /// Appends one line to logs/native.log. Best effort: never throws.
  static func log(_ message: String) {
    guard let dir = try? container().appendingPathComponent("logs", isDirectory: true) else { return }
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appendingPathComponent("native.log")
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
    if let handle = try? FileHandle(forWritingTo: file) {
      handle.seekToEndOfFile()
      handle.write(Data(line.utf8))
      try? handle.close()
    } else {
      try? Data(line.utf8).write(to: file, options: .completeFileProtectionUntilFirstUserAuthentication)
    }
  }

  /// RFC 9562 UUIDv7: 48-bit Unix ms timestamp, version 7, variant 10, random rest.
  static func uuidV7() -> String {
    var bytes = [UInt8](repeating: 0, count: 16)
    for i in 6..<16 { bytes[i] = UInt8.random(in: 0...255) }
    let ms = UInt64(Date().timeIntervalSince1970 * 1000)
    for i in 0..<6 { bytes[i] = UInt8((ms >> (8 * (5 - UInt64(i)))) & 0xFF) }
    bytes[6] = (bytes[6] & 0x0F) | 0x70
    bytes[8] = (bytes[8] & 0x3F) | 0x80
    let hex = bytes.map { String(format: "%02x", $0) }.joined()
    let p = Array(hex)
    return "\(String(p[0..<8]))-\(String(p[8..<12]))-\(String(p[12..<16]))-\(String(p[16..<20]))-\(String(p[20..<32]))"
  }
}
