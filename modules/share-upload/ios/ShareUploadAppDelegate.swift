import ExpoModulesCore
import Foundation

/// Spec 4.10 step 3: when the share extension's background upload finishes after the extension has
/// exited, iOS wakes the app with the session's identifier. This recreates the session, takes its
/// delegate events and calls the completion handler once they're delivered. Other identifiers are
/// someone else's: their handler is called at once, since Expo waits for every subscriber's.
public class ShareUploadAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    guard identifier == ShareUploadFiles.sessionIdentifier else {
      completionHandler()
      return
    }
    ShareUploadSession.shared.attach(completionHandler)
  }
}

/// The app's side of the background session. One instance for the app's life: a background session
/// can't be created twice with the same identifier. Everything runs on the main queue.
final class ShareUploadSession: NSObject, URLSessionTaskDelegate {
  static let shared = ShareUploadSession()

  private var session: URLSession?
  private var completionHandler: (() -> Void)?

  func attach(_ handler: @escaping () -> Void) {
    DispatchQueue.main.async {
      // A newer wake replaces an older handler that was never called; call that one now.
      self.completionHandler?()
      self.completionHandler = handler
      if self.session == nil {
        let configuration = URLSessionConfiguration.background(withIdentifier: ShareUploadFiles.sessionIdentifier)
        configuration.sharedContainerIdentifier = ShareUploadFiles.appGroupId
        configuration.sessionSendsLaunchEvents = true
        self.session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
      }
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    ShareUploadFiles.complete(task, error: error)
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    DispatchQueue.main.async {
      let handler = self.completionHandler
      self.completionHandler = nil
      handler?()
    }
  }
}

/// The upload's files in the App Group, as targets/_shared/ShareQueue.swift (`ShareUpload`) writes
/// them; keep the names and the completion rule in sync by hand. A 2xx deletes
/// `share/upload/<id>.json` and marks `share/upload-state/<id>.json` accepted; anything else leaves
/// both for the app's reconciliation, which alone deletes the envelope (once the server has it).
enum ShareUploadFiles {
  static let sessionIdentifier = "com.jgp.perfectbite.share.upload"
  static let appGroupId = "group.com.jgp.perfectbite"
  static let uploadPath = "share/upload"
  static let uploadStatePath = "share/upload-state"

  /// The envelope id of a finished task: its description, else its `Idempotency-Key`.
  static func envelopeId(_ task: URLSessionTask) -> String? {
    if let id = task.taskDescription, !id.isEmpty { return id }
    return task.originalRequest?.value(forHTTPHeaderField: "Idempotency-Key")
  }

  static func complete(_ task: URLSessionTask, error: Error?) {
    guard let id = envelopeId(task) else { return }
    let status = (task.response as? HTTPURLResponse)?.statusCode
    log("share upload finished in app id=\(id) status=\(status.map(String.init) ?? "-") error=\(error != nil)")
    guard error == nil, let status, (200..<300).contains(status) else { return }
    markAccepted(id)
  }

  /// A state the app's reconciliation already deleted (with the envelope) isn't written again.
  static func markAccepted(_ id: String) {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)
    else { return }
    let name = "\(id).json"
    try? FileManager.default.removeItem(at: container.appendingPathComponent(uploadPath).appendingPathComponent(name))
    let file = container.appendingPathComponent(uploadStatePath).appendingPathComponent(name)
    guard let data = try? Data(contentsOf: file),
      var state = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else { return }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    state["accepted"] = true
    state["acceptedAt"] = formatter.string(from: Date())
    guard let updated = try? JSONSerialization.data(withJSONObject: state) else { return }
    try? updated.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  /// Appends to logs/native.log like the extensions do. Best effort.
  static func log(_ message: String) {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)
    else { return }
    let dir = container.appendingPathComponent("logs", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appendingPathComponent("native.log")
    let line = Data("\(ISO8601DateFormatter().string(from: Date())) \(message)\n".utf8)
    if let handle = try? FileHandle(forWritingTo: file) {
      handle.seekToEndOfFile()
      handle.write(line)
      try? handle.close()
    } else {
      try? line.write(to: file, options: .completeFileProtectionUntilFirstUserAuthentication)
    }
  }
}
