import Foundation
import Security

/// The share queue in the App Group (spec 4.9, 4.10): share/pending/<id>.json, reconciled with the
/// server by the app, and each share's background upload (share/upload/, share/upload-state/).
enum ShareQueue {
  static let pendingPath = "share/pending"
  static let uploadPath = "share/upload"
  static let uploadStatePath = "share/upload-state"
  /// The envelope version this extension writes: it carries `userId` and starts the upload.
  static let envelopeVersion = 2
  /// A photo share's envelope version: `images` and no `url` or `page`.
  static let photoEnvelopeVersion = 3

  /// Mirrors `ShareEnvelopeSchema` in src/shared/schemas/share.ts. Keep in sync by hand.
  struct Envelope: Codable {
    /// Mirrors `RecipeImportPageSchema`: each JSON-LD block ≤ 200 KB, at most 10; text ≤ 50 KB;
    /// `imageUrl` (the page's photo tag, as written) ≤ 2048 characters.
    struct Page: Codable {
      var title: String?
      var jsonLd: [String]?
      var text: String?
      var imageUrl: String?
    }

    /// Mirrors `RecipePhotoSchema` as a share takes it: `image/jpeg` only, `data` standard padded
    /// base64 of at most 2 MB decoded.
    struct Image: Codable {
      let mediaType: String
      let data: String
    }

    /// `envelopeVersion`; left out by older extensions.
    let v: Int?
    let id: String
    /// The snapshot's signed-in user. Left out when the snapshot has none (written by an older app).
    let userId: String?
    /// A link share's URL; nil (left out) for a photo share.
    let url: String?
    /// A photo share's pages in order, 1 to 3; nil (left out) for a link share.
    let images: [Image]?
    /// Null (written explicitly, not omitted): the default list, or no list when `addToList` is false.
    let listId: String?
    /// The household picked in the sheet, where a recipe-only share is saved. Null when unknown.
    let householdId: String?
    /// False: save the recipe only, adding nothing to a list. Nil (left out): true, as before.
    let addToList: Bool?
    var page: Page?
    let createdAt: String
    let appVersion: String
    let source: String

    enum CodingKeys: String, CodingKey {
      case v, id, userId, url, images, listId, householdId, addToList, page, createdAt, appVersion, source
    }

    // JSONEncoder omits nil optionals; the schema wants `listId` and `householdId` as null, and
    // `url`, `images` and `page` left out.
    func encode(to encoder: Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encodeIfPresent(v, forKey: .v)
      try c.encode(id, forKey: .id)
      try c.encodeIfPresent(userId, forKey: .userId)
      try c.encodeIfPresent(url, forKey: .url)
      try c.encodeIfPresent(images, forKey: .images)
      try c.encode(listId, forKey: .listId)
      try c.encode(householdId, forKey: .householdId)
      try c.encodeIfPresent(addToList, forKey: .addToList)
      try c.encodeIfPresent(page, forKey: .page)
      try c.encode(createdAt, forKey: .createdAt)
      try c.encode(appVersion, forKey: .appVersion)
      try c.encode(source, forKey: .source)
    }
  }

  static let maxJsonLdBlocks = 10
  static let maxJsonLdBlockBytes = 200 * 1024
  static let maxTextBytes = 50 * 1024
  static let maxImageUrlLength = 2048

  static func pendingDir() throws -> URL {
    let dir = try SiriQueue.container().appendingPathComponent(pendingPath, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  /// The page within the schema's caps (Preprocess.js applies them too; a file over them would be
  /// unreadable to the app). Empty parts are left out, and no page at all when nothing is left; a
  /// photo alone isn't a page, since the server would then import from it instead of fetching.
  static func page(title: String?, jsonLd: [String], text: String?, imageUrl: String? = nil) -> Envelope.Page? {
    let title = title?.trimmingCharacters(in: .whitespacesAndNewlines)
    let blocks = jsonLd
      .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf8.count <= maxJsonLdBlockBytes }
      .prefix(maxJsonLdBlocks)
    let text = text.map { cut($0, maxBytes: maxTextBytes) }
    let image = imageUrl?.trimmingCharacters(in: .whitespacesAndNewlines)
    let page = Envelope.Page(
      title: title?.isEmpty == false ? title : nil,
      jsonLd: blocks.isEmpty ? nil : Array(blocks),
      text: text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? text : nil,
      imageUrl: image.flatMap { !$0.isEmpty && $0.count <= maxImageUrlLength ? $0 : nil })
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

  /// With `addToList` false the recipe goes to `householdId` alone, and `listId` is dropped.
  static func makeEnvelope(
    url: URL, listId: String?, householdId: String?, addToList: Bool = true, page: Envelope.Page?,
    userId: String?
  ) -> Envelope {
    Envelope(
      v: envelopeVersion, id: SiriQueue.uuidV7(), userId: userId, url: url.absoluteString, images: nil,
      listId: addToList ? listId : nil,
      householdId: householdId, addToList: addToList, page: page,
      createdAt: createdAt(), appVersion: appVersion(), source: "share")
  }

  /// A photo share: `v: 3`, its pages in order, and no `url` or `page`.
  static func makePhotoEnvelope(
    images: [Envelope.Image], listId: String?, householdId: String?, addToList: Bool, userId: String?
  ) -> Envelope {
    Envelope(
      v: photoEnvelopeVersion, id: SiriQueue.uuidV7(), userId: userId, url: nil, images: images,
      listId: addToList ? listId : nil,
      householdId: householdId, addToList: addToList, page: nil,
      createdAt: createdAt(), appVersion: appVersion(), source: "share")
  }

  private static func createdAt() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.timeZone = .current
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
  }

  private static func appVersion() -> String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
  }

  /// Atomic write: `<id>.json.tmp` then rename to `<id>.json`. Returns the bytes written, which are
  /// also the upload's request body.
  @discardableResult
  static func enqueue(_ envelope: Envelope) throws -> Data {
    let data = try JSONEncoder().encode(envelope)
    try writeAtomically(data, in: try pendingDir(), name: "\(envelope.id).json")
    return data
  }

  static func dir(_ path: String) throws -> URL {
    let dir = try SiriQueue.container().appendingPathComponent(path, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  /// `<name>.tmp` then rename, replacing an older file. Readable after first unlock, so a retried
  /// background upload can read its body while the phone is locked.
  static func writeAtomically(_ data: Data, in dir: URL, name: String) throws {
    let tmp = dir.appendingPathComponent("\(name).tmp")
    let final = dir.appendingPathComponent(name)
    try data.write(to: tmp, options: .completeFileProtectionUntilFirstUserAuthentication)
    if FileManager.default.fileExists(atPath: final.path) {
      _ = try FileManager.default.replaceItemAt(final, withItemAt: tmp)
    } else {
      try FileManager.default.moveItem(at: tmp, to: final)
    }
  }
}

/// The device credential the app keeps in the shared Keychain (spec 6.12), read as expo-secure-store
/// writes it. Mirrors src/features/auth/device-credential.ts (`KEYCHAIN_ACCESS_GROUP`,
/// `KEYCHAIN_SERVICE`, `CREDENTIAL_KEY`, `DeviceCredential`); keep in sync by hand.
enum ShareCredential {
  static let accessGroup = "4537GH756L.com.jgp.perfectbite.shared"
  /// expo-secure-store appends ":no-auth" to the service of an item without biometrics.
  static let service = "com.jgp.perfectbite.device-credential:no-auth"
  static let account = "share.credential"

  struct Credential: Codable {
    let token: String
    let userId: String
    let installationId: String
    let expiresAt: String
  }

  /// The stored credential's JSON, or nil if there is none or the Keychain can't be read.
  static func read() -> Data? {
    let key = Data(account.utf8)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrGeneric as String: key,
      kSecAttrAccount as String: key,
      kSecAttrAccessGroup as String: accessGroup,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
    return item as? Data
  }

  /// The credential if it's `userId`'s (compared without case) and hasn't expired at `now`. Nil when
  /// there's none, it's unreadable, it's another user's, there's no user, or its expiry is past or
  /// unreadable.
  static func usable(_ data: Data?, userId: String?, now: Date = Date()) -> Credential? {
    guard let data, let userId,
      let credential = try? JSONDecoder().decode(Credential.self, from: data),
      !credential.token.isEmpty,
      credential.userId.lowercased() == userId.lowercased(),
      let expires = parseDate(credential.expiresAt), expires > now
    else { return nil }
    return credential
  }

  /// ISO 8601, with or without fractional seconds (the server's `expires_at`).
  static func parseDate(_ s: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: s) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: s)
  }
}

/// A share's background upload to `share-ingest` (spec 4.10 step 3): its body in
/// share/upload/<id>.json and its state in share/upload-state/<id>.json. When iOS wakes the app for
/// the session, modules/share-upload finishes it with the same names and completion rule; keep the
/// two in sync by hand. No answer is final: the app's reconciliation deletes the envelope once the
/// server has it.
enum ShareUpload {
  static let sessionIdentifier = "com.jgp.perfectbite.share.upload"
  /// The extension's Info.plist key, set from the app config by expo-target.config.js.
  static let urlInfoKey = "ShareIngestURL"

  /// `share/upload-state/<id>.json`; `accepted` once the upload got a 2xx.
  struct State: Codable {
    var startedAt: String
    var attempts: Int
    var accepted: Bool?
    var acceptedAt: String?
  }

  /// The `share-ingest` URL from the Info.plist, or nil when it's unset or not http(s) (a build
  /// without the Supabase URL leaves `$(SHARE_INGEST_URL)` empty).
  static func endpoint(_ value: Any?) -> URL? {
    guard let string = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
      !string.isEmpty, let url = URL(string: string), ShareQueue.isWebURL(url)
    else { return nil }
    return url
  }

  static func request(to endpoint: URL, token: String, id: String) -> URLRequest {
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue(id, forHTTPHeaderField: "Idempotency-Key")
    return request
  }

  static func configuration() -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.background(withIdentifier: sessionIdentifier)
    configuration.sharedContainerIdentifier = SiriQueue.appGroupId
    configuration.sessionSendsLaunchEvents = true
    return configuration
  }

  static func timestamp(_ date: Date = Date()) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }

  /// Starts the upload of `body` (the envelope as written) when the shared Keychain has a usable
  /// credential for the envelope's user and the Info.plist has the endpoint. Returns whether it
  /// started; when it didn't, the app submits the share later. Never throws.
  @discardableResult
  static func start(_ envelope: ShareQueue.Envelope, body: Data) -> Bool {
    guard let credential = ShareCredential.usable(ShareCredential.read(), userId: envelope.userId) else {
      SiriQueue.log("share upload skipped id=\(envelope.id) no usable credential")
      return false
    }
    guard let endpoint = endpoint(Bundle.main.object(forInfoDictionaryKey: urlInfoKey)) else {
      SiriQueue.log("share upload skipped id=\(envelope.id) no endpoint")
      return false
    }
    do {
      let name = "\(envelope.id).json"
      let uploads = try ShareQueue.dir(ShareQueue.uploadPath)
      try ShareQueue.writeAtomically(body, in: uploads, name: name)
      let state = try JSONEncoder().encode(State(startedAt: timestamp(), attempts: 1))
      try ShareQueue.writeAtomically(state, in: try ShareQueue.dir(ShareQueue.uploadStatePath), name: name)
      let session = URLSession(configuration: configuration(), delegate: Delegate(), delegateQueue: nil)
      let task = session.uploadTask(
        with: request(to: endpoint, token: credential.token, id: envelope.id),
        fromFile: uploads.appendingPathComponent(name))
      task.taskDescription = envelope.id
      task.resume()
      // The system carries on with the task after the extension exits; the app gets its events.
      session.finishTasksAndInvalidate()
      SiriQueue.log("share upload started id=\(envelope.id)")
      return true
    } catch {
      SiriQueue.log("share upload error id=\(envelope.id) \(error)")
      return false
    }
  }

  /// The envelope id of a finished task: its description, else its `Idempotency-Key`.
  static func envelopeId(_ task: URLSessionTask) -> String? {
    if let id = task.taskDescription, !id.isEmpty { return id }
    return task.originalRequest?.value(forHTTPHeaderField: "Idempotency-Key")
  }

  /// A 2xx deletes the body and marks the state accepted; anything else leaves both.
  static func complete(_ task: URLSessionTask, error: Error?) {
    guard let id = envelopeId(task) else { return }
    let status = (task.response as? HTTPURLResponse)?.statusCode
    SiriQueue.log("share upload done id=\(id) status=\(status.map(String.init) ?? "-") error=\(error != nil)")
    guard error == nil, let status, (200..<300).contains(status) else { return }
    markAccepted(id)
  }

  /// A state the app's reconciliation already deleted (with the envelope) isn't written again.
  static func markAccepted(_ id: String, at date: Date = Date()) {
    guard let container = try? SiriQueue.container() else { return }
    let name = "\(id).json"
    try? FileManager.default.removeItem(
      at: container.appendingPathComponent(ShareQueue.uploadPath).appendingPathComponent(name))
    let states = container.appendingPathComponent(ShareQueue.uploadStatePath)
    guard let data = try? Data(contentsOf: states.appendingPathComponent(name)),
      var state = try? JSONDecoder().decode(State.self, from: data)
    else { return }
    state.accepted = true
    state.acceptedAt = timestamp(date)
    if let data = try? JSONEncoder().encode(state) {
      try? ShareQueue.writeAtomically(data, in: states, name: name)
    }
  }

  /// Handles a task that finishes while the extension is still open.
  final class Delegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
      ShareUpload.complete(task, error: error)
    }
  }
}
