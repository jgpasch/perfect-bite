import Foundation

/// The share queue in the App Group (spec 4.9, 4.10): share/pending/<id>.json, drained by the app.
enum ShareQueue {
  static let pendingPath = "share/pending"

  /// Mirrors `ShareEnvelopeSchema` in src/shared/schemas/share.ts. Keep in sync by hand.
  struct Envelope: Codable {
    /// Mirrors `RecipeImportPageSchema`: each JSON-LD block ≤ 200 KB, at most 10; text ≤ 50 KB.
    struct Page: Codable {
      var title: String?
      var jsonLd: [String]?
      var text: String?
    }

    let id: String
    let url: String
    /// Null (written explicitly, not omitted): the default list.
    let listId: String?
    var page: Page?
    let createdAt: String
    let appVersion: String
    let source: String

    enum CodingKeys: String, CodingKey {
      case id, url, listId, page, createdAt, appVersion, source
    }

    // JSONEncoder omits nil optionals; the schema wants `listId: null`, and `page` left out.
    func encode(to encoder: Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(id, forKey: .id)
      try c.encode(url, forKey: .url)
      try c.encode(listId, forKey: .listId)
      try c.encodeIfPresent(page, forKey: .page)
      try c.encode(createdAt, forKey: .createdAt)
      try c.encode(appVersion, forKey: .appVersion)
      try c.encode(source, forKey: .source)
    }
  }

  static let maxJsonLdBlocks = 10
  static let maxJsonLdBlockBytes = 200 * 1024
  static let maxTextBytes = 50 * 1024

  static func pendingDir() throws -> URL {
    let dir = try SiriQueue.container().appendingPathComponent(pendingPath, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  /// The page within the schema's caps (Preprocess.js applies them too; a file over them would be
  /// unreadable to the app). Empty parts are left out, and no page at all when nothing is left.
  static func page(title: String?, jsonLd: [String], text: String?) -> Envelope.Page? {
    let title = title?.trimmingCharacters(in: .whitespacesAndNewlines)
    let blocks = jsonLd
      .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf8.count <= maxJsonLdBlockBytes }
      .prefix(maxJsonLdBlocks)
    let text = text.map { cut($0, maxBytes: maxTextBytes) }
    let page = Envelope.Page(
      title: title?.isEmpty == false ? title : nil,
      jsonLd: blocks.isEmpty ? nil : Array(blocks),
      text: text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? text : nil)
    return page.title == nil && page.jsonLd == nil && page.text == nil ? nil : page
  }

  /// `s` cut to at most `maxBytes` UTF-8 bytes without splitting a character.
  static func cut(_ s: String, maxBytes: Int) -> String {
    if s.utf8.count <= maxBytes { return s }
    var out = ""
    var used = 0
    for ch in s {
      let n = String(ch).utf8.count
      if used + n > maxBytes { break }
      out.append(ch)
      used += n
    }
    return out
  }

  /// The first http(s) URL in shared text (Instagram and Messages share a URL inside text).
  static func firstWebURL(in text: String) -> URL? {
    guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
      return nil
    }
    let range = NSRange(text.startIndex..., in: text)
    for match in detector.matches(in: text, range: range) {
      if let url = match.url, isWebURL(url) { return url }
    }
    return nil
  }

  static func isWebURL(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased(), url.host?.isEmpty == false else { return false }
    return scheme == "http" || scheme == "https"
  }

  static func makeEnvelope(url: URL, listId: String?, page: Envelope.Page?) -> Envelope {
    let formatter = ISO8601DateFormatter()
    formatter.timeZone = .current
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    return Envelope(
      id: SiriQueue.uuidV7(), url: url.absoluteString, listId: listId, page: page,
      createdAt: formatter.string(from: Date()), appVersion: version, source: "share")
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
}
