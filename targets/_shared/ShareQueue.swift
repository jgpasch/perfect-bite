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
}
