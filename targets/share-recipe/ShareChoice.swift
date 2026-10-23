import Foundation

/// Where a share is saved (spec 4.10): a household, and optionally one of its lists. Mirrors
/// src/features/recipes/save-choice.ts, which has the tests; keep the two in sync by hand.
/// src/features/recipes/__tests__/share-extension.test.ts checks the copy matches.
enum ShareChoice {
  typealias Snapshot = SiriQueue.ListSnapshot

  struct Household: Identifiable, Equatable {
    let id: String
    let name: String
  }

  static let noListsMessage = "This household has no lists"

  /// Every household, in order. A snapshot from an older app has none, so they come from its lists.
  static func households(_ snapshot: Snapshot) -> [Household] {
    if let households = snapshot.households {
      return households.map { Household(id: $0.id, name: $0.name) }
    }
    var seen = Set<String>()
    return snapshot.lists.compactMap { list in
      guard let id = list.householdId, seen.insert(id).inserted else { return nil }
      return Household(id: id, name: list.householdName)
    }
  }

  /// Last opened, then default, then first, among `lists` (`launchListId` in list-view.ts).
  static func pickListId(_ snapshot: Snapshot, among lists: [Snapshot.List]) -> String? {
    let ids = Set(lists.map(\.id))
    if let id = snapshot.lastOpenedListId, ids.contains(id) { return id }
    if let id = snapshot.defaultListId, ids.contains(id) { return id }
    return lists.first?.id
  }

  /// The household of the list the picker would pick, else the first household.
  static func defaultHouseholdId(_ snapshot: Snapshot) -> String? {
    let all = households(snapshot)
    let listId = pickListId(snapshot, among: snapshot.lists)
    if let householdId = snapshot.lists.first(where: { $0.id == listId })?.householdId,
      all.contains(where: { $0.id == householdId })
    {
      return householdId
    }
    return all.first?.id
  }

  static func lists(_ snapshot: Snapshot, in householdId: String?) -> [Snapshot.List] {
    snapshot.lists.filter { $0.householdId == householdId }
  }

  /// The default list within a household, by the same rule.
  static func defaultListId(_ snapshot: Snapshot, in householdId: String?) -> String? {
    pickListId(snapshot, among: lists(snapshot, in: householdId))
  }

  static func buttonTitle(addToList: Bool, listName: String?) -> String {
    addToList ? "Save & add to \(listName ?? "list")" : "Save recipe"
  }

  /// The same with the list on or off: the server imports the share (spec 4.10).
  static let savedMessage = "Saved. We'll prepare it in the background."

  /// The envelope's target: `listId` only when adding to a list; on with no list saves the recipe only.
  static func envelopeTarget(householdId: String?, addToList: Bool, listId: String?)
    -> (householdId: String?, addToList: Bool, listId: String?)
  {
    let on = addToList && listId != nil
    return (householdId, on, on ? listId : nil)
  }
}

/// The share sheet's remembered choices on this device: `share/prefs.json` in the App Group. Only the
/// switch is kept; the household follows the default rule each time.
enum SharePrefs {
  struct Prefs: Codable {
    var addToList: Bool
  }

  static let path = "share/prefs.json"

  /// The switch's last state; off the first time.
  static func loadAddToList() -> Bool {
    guard
      let url = try? SiriQueue.container().appendingPathComponent(path),
      let data = try? Data(contentsOf: url),
      let prefs = try? JSONDecoder().decode(Prefs.self, from: data)
    else { return false }
    return prefs.addToList
  }

  /// Best effort: a failed write just means the switch starts off next time.
  static func saveAddToList(_ addToList: Bool) {
    guard let url = try? SiriQueue.container().appendingPathComponent(path) else { return }
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard let data = try? JSONEncoder().encode(Prefs(addToList: addToList)) else { return }
    try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }
}
