import AppIntents

@main
struct PerfectBiteIntentsExtension: AppIntentsExtension {}

/// A list Siri can add to, from the snapshot the app writes (spec 4.9).
struct ListEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "List"
  static let defaultQuery = ListQuery()

  let id: String
  let name: String

  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct ListQuery: EntityStringQuery {
  private func all() -> [ListEntity] {
    SiriQueue.loadLists().lists.map { ListEntity(id: $0.id, name: $0.name) }
  }

  func entities(for identifiers: [String]) async throws -> [ListEntity] {
    all().filter { identifiers.contains($0.id) }
  }

  func entities(matching string: String) async throws -> [ListEntity] {
    all().filter { $0.name.localizedCaseInsensitiveContains(string) }
  }

  func suggestedEntities() async throws -> [ListEntity] {
    all()
  }
}

/// Spec 4.9: two-turn Siri add. Runs in this extension; the app UI never opens.
struct AddToPerfectBiteIntent: AppIntent {
  static let title: LocalizedStringResource = "Add to The Perfect Bite"
  static let description = IntentDescription("Add an item to a shopping list.")
  static let openAppWhenRun = false

  @Parameter(title: "Item", requestValueDialog: IntentDialog("What do you want to add?"))
  var text: String

  @Parameter(title: "List")
  var list: ListEntity?

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let snapshot = SiriQueue.loadLists()
    let listId = list?.id
    let listName = list?.name
      ?? snapshot.lists.first(where: { $0.id == snapshot.defaultListId })?.name
      ?? "your list"

    let envelope = SiriQueue.makeEnvelope(text: text, listId: listId)
    do {
      try SiriQueue.enqueue(envelope)
      SiriQueue.log("siri ok id=\(envelope.id) list=\(listId ?? "default")")
    } catch {
      SiriQueue.log("siri error id=\(envelope.id) \(error)")
      throw error
    }
    // TODO(M8): best-effort upload to the siri-add Edge Function (spec 4.9), pending the token spike.
    return .result(dialog: "Added \(text) to \(listName).")
  }
}

/// Phrase variants for the M0 recognition spike (docs/spikes.md). Every phrase must include the app name.
struct PerfectBiteShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AddToPerfectBiteIntent(),
      phrases: [
        "Add to \(.applicationName)",
        "Add something to \(.applicationName)",
        "Add an item to \(.applicationName)",
        "Add to my \(.applicationName) list",
        "Add to \(\.$list) in \(.applicationName)",
      ],
      shortTitle: "Add an item",
      systemImageName: "cart.badge.plus")
  }
}
