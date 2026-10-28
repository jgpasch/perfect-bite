import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Spec 4.10: Share → The Perfect Bite. Picks a household, and optionally a list, queues a share
/// envelope and starts its background upload to `share-ingest`; the server imports it.
/// No React Native in here (extension memory limits), and no request the sheet waits on.
@objc(ShareViewController)
final class ShareViewController: UIViewController {
  private let model = ShareModel()

  override func viewDidLoad() {
    super.viewDidLoad()
    model.onDone = { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) }
    model.onCancel = { [weak self] in
      self?.extensionContext?.cancelRequest(withError: NSError(domain: "PerfectBite", code: 0))
    }
    let host = UIHostingController(rootView: ShareView(model: model))
    addChild(host)
    host.view.frame = view.bounds
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(host.view)
    host.didMove(toParent: self)

    let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
      .flatMap { $0.attachments ?? [] }
    Task { await model.load(providers) }
  }
}

@MainActor
final class ShareModel: ObservableObject {
  @Published var url: URL?
  @Published var page: ShareQueue.Envelope.Page?
  /// A photo share's pages, in the order shared; only when there's no web URL.
  @Published var photos: [SharePhotos.Page] = []
  /// Their thumbnails as the sheet shows them.
  @Published var thumbnails: [UIImage] = []
  /// An image in the share couldn't be read: Save stays off.
  @Published var unreadableImage = false
  /// The household the recipe is saved to (spec 4.10). Changing it resets the list to that
  /// household's default.
  @Published var householdId: String? {
    didSet {
      if householdId != oldValue { selectedListId = ShareChoice.defaultListId(snapshot, in: householdId) }
    }
  }
  /// Also add ingredients to a list. Remembered on this device; off the first time.
  @Published var addToList: Bool {
    didSet { if addToList != oldValue { SharePrefs.saveAddToList(addToList) } }
  }
  @Published var selectedListId: String?
  @Published var loading = true
  /// Set once saved.
  @Published var saved = false
  @Published var error: String?
  let snapshot: SiriQueue.ListSnapshot
  let households: [ShareChoice.Household]
  var onDone: () -> Void = {}
  var onCancel: () -> Void = {}

  init() {
    let snapshot = SiriQueue.loadLists()
    let householdId = ShareChoice.defaultHouseholdId(snapshot)
    self.snapshot = snapshot
    households = ShareChoice.households(snapshot)
    addToList = SharePrefs.loadAddToList()
    self.householdId = householdId
    selectedListId = ShareChoice.defaultListId(snapshot, in: householdId)
  }

  /// The chosen household's lists, in snapshot order.
  var lists: [SiriQueue.ListSnapshot.List] { ShareChoice.lists(snapshot, in: householdId) }

  var hasLists: Bool { !lists.isEmpty }

  /// The switch as shown: off, and disabled, when the household has no lists.
  var addsToList: Bool { addToList && hasLists }

  var selectedList: SiriQueue.ListSnapshot.List? {
    lists.first { $0.id == selectedListId }
  }

  var buttonTitle: String {
    ShareChoice.buttonTitle(addToList: addsToList, listName: selectedList?.name)
  }

  /// The host without `www.`.
  var host: String? {
    guard let host = url?.host?.lowercased() else { return nil }
    return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
  }

  var displayTitle: String { page?.title ?? host ?? "" }

  /// No web URL, and images: a photo share, even when one of them couldn't be read.
  var isPhotoShare: Bool { url == nil && (!photos.isEmpty || unreadableImage) }

  var canSave: Bool {
    !loading && !saved && (url != nil || (!photos.isEmpty && !unreadableImage)) && householdId != nil
      && (!addsToList || selectedList != nil)
  }

  /// Safari's web page first (it carries the page), then a web URL, then the first URL in text; only
  /// with none of those, up to 3 images in order.
  func load(_ providers: [NSItemProvider]) async {
    await loadLink(providers)
    if url == nil { await loadPhotos(SharePhotos.imageProviders(providers)) }
    SiriQueue.log(
      "share open url=\(url != nil) page=\(page != nil) images=\(photos.count) "
        + "imageBytes=\(photos.map { String($0.jpeg.count) }.joined(separator: ",")) unreadable=\(unreadableImage) "
        + "households=\(households.count) lists=\(snapshot.lists.count)")
    loading = false
  }

  /// One image at a time, so only one is ever being decoded; stops at the first that can't be read.
  private func loadPhotos(_ providers: [NSItemProvider]) async {
    for provider in providers {
      guard let photo = await SharePhotos.load(provider) else {
        unreadableImage = true
        return
      }
      photos.append(photo)
      if let thumbnail = UIImage(data: photo.thumb) { thumbnails.append(thumbnail) }
    }
  }

  private func loadLink(_ providers: [NSItemProvider]) async {
    for provider in providers.prefix(10)
    where provider.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier) {
      await loadWebPage(provider)
    }
    for provider in providers.prefix(10) where url == nil {
      if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
        let item = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier)
        if let shared = item as? URL, ShareQueue.isWebURL(shared) { url = shared }
      } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
        let item = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier)
        if let text = item as? String { url = ShareQueue.firstWebURL(in: text) }
      }
    }
  }

  /// The results of Preprocess.js: the page's URL, title, JSON-LD blocks, readable text and photo tag.
  private func loadWebPage(_ provider: NSItemProvider) async {
    let item = try? await provider.loadItem(forTypeIdentifier: UTType.propertyList.identifier)
    guard let dict = item as? NSDictionary,
      let results = dict[NSExtensionJavaScriptPreprocessingResultsKey] as? [String: Any]
    else { return }
    if let string = results["url"] as? String, let pageURL = URL(string: string), ShareQueue.isWebURL(pageURL) {
      url = pageURL
    }
    page = ShareQueue.page(
      title: results["title"] as? String,
      jsonLd: results["jsonLd"] as? [String] ?? [],
      text: results["text"] as? String,
      imageUrl: results["imageUrl"] as? String)
  }

  func save() {
    guard canSave else { return }
    let target = ShareChoice.envelopeTarget(
      householdId: householdId, addToList: addsToList, listId: selectedList?.id)
    let envelope: ShareQueue.Envelope
    if let url {
      envelope = ShareQueue.makeEnvelope(
        url: url, listId: target.listId, householdId: target.householdId, addToList: target.addToList,
        page: page, userId: snapshot.userId)
    } else {
      envelope = ShareQueue.makePhotoEnvelope(
        images: SharePhotos.envelopeImages(photos), listId: target.listId, householdId: target.householdId,
        addToList: target.addToList, userId: snapshot.userId)
    }
    do {
      // The thumbnails first, so the imports card has them once the envelope is there.
      if url == nil { try SharePhotos.writeThumbs(photos, id: envelope.id) }
      let body = try ShareQueue.enqueue(envelope)
      SiriQueue.log(
        "share ok id=\(envelope.id) household=\(target.householdId ?? "-") list=\(target.listId ?? "-") "
          + "jsonLd=\(page?.jsonLd?.count ?? 0) text=\(page?.text?.utf8.count ?? 0) "
          + "images=\(photos.count) body=\(body.count)")
      // Only once the envelope is written; with no upload, the app submits it later.
      ShareUpload.start(envelope, body: body)
      saved = true
      Task {
        try? await Task.sleep(for: .seconds(1.2))
        onDone()
      }
    } catch {
      SiriQueue.log("share error id=\(envelope.id) \(error)")
      self.error = "Couldn't save the recipe. Try again."
    }
  }
}

/// DESIGN.md's Pantry colours, mirroring `Palette` in src/constants/theme.ts (light, dark).
/// src/features/recipes/__tests__/share-extension.test.ts checks they match.
enum Pantry {
  static let background = dynamic(light: 0xEEF3EC, dark: 0x111915)
  static let surface = dynamic(light: 0xFFFFFF, dark: 0x1B241F)
  static let border = dynamic(light: 0xEEF1EC, dark: 0x26302A)
  static let controlBorder = dynamic(light: 0xB9C4BC, dark: 0x56635A)
  static let ink = dynamic(light: 0x1D2A22, dark: 0xE7EEE8)
  static let inkSecondary = dynamic(light: 0x55635A, dark: 0xA6B3AA)
  static let primary = dynamic(light: 0x2E6B45, dark: 0x7CC395)
  static let onPrimary = dynamic(light: 0xFFFFFF, dark: 0x0E1F14)
  static let primarySoft = dynamic(light: 0xDDEFE2, dark: 0x1E3A28)
  static let onPrimarySoft = dynamic(light: 0x1F5233, dark: 0xB7E4C5)
  static let danger = dynamic(light: 0xA33D53, dark: 0xF08B9F)

  static let cardRadius: CGFloat = 22
  static let cardRowMin: CGFloat = 50
  static let cta: CGFloat = 54
  static let check: CGFloat = 24

  private static func dynamic(light: UInt32, dark: UInt32) -> Color {
    Color(UIColor { $0.userInterfaceStyle == .dark ? uiColor(dark) : uiColor(light) })
  }

  private static func uiColor(_ hex: UInt32) -> UIColor {
    UIColor(
      red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
  }
}

struct ShareView: View {
  @ObservedObject var model: ShareModel

  var body: some View {
    NavigationStack {
      ZStack {
        Pantry.background.ignoresSafeArea()
        if model.saved {
          SavedView(text: ShareChoice.savedMessage)
        } else {
          content
        }
      }
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: model.onCancel).foregroundStyle(Pantry.ink).disabled(model.saved)
        }
      }
    }
    .tint(Pantry.primary)
  }

  @ViewBuilder private var content: some View {
    if model.loading {
      ProgressView()
    } else if model.households.isEmpty {
      Message(text: "Open The Perfect Bite once to set up")
    } else if model.url == nil && !model.isPhotoShare {
      Message(text: "There's no link here to import.")
    } else {
      VStack(spacing: 0) {
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            if model.isPhotoShare {
              PhotoHeader(
                thumbnails: model.thumbnails, pageCount: model.photos.count, unreadable: model.unreadableImage)
            } else {
              PageHeader(title: model.displayTitle, host: model.host ?? "")
            }
            if model.households.count > 1 {
              SectionLabel(text: "Save to")
              Card {
                ForEach(Array(model.households.enumerated()), id: \.element.id) { index, household in
                  if index > 0 { Pantry.border.frame(height: 1) }
                  ChoiceRow(name: household.name, selected: household.id == model.householdId) {
                    model.householdId = household.id
                  }
                }
              }
            }
            AddToListRow(model: model)
            if model.addsToList {
              Card {
                ForEach(Array(model.lists.enumerated()), id: \.element.id) { index, list in
                  if index > 0 { Pantry.border.frame(height: 1) }
                  ChoiceRow(name: list.name, selected: list.id == model.selectedListId) {
                    model.selectedListId = list.id
                  }
                }
              }
              .padding(.top, 12)
            }
          }
          .padding(.bottom, 16)
        }
        if let error = model.error {
          Text(error).font(.footnote).foregroundStyle(Pantry.danger).padding(.horizontal, 16)
        }
        Button(action: model.save) {
          Text(model.buttonTitle)
            .font(.headline)
            .lineLimit(1)
            .frame(maxWidth: .infinity, minHeight: Pantry.cta)
            .foregroundStyle(Pantry.onPrimary)
            .background(Pantry.primary, in: Capsule())
        }
        .disabled(!model.canSave)
        .padding(16)
      }
    }
  }
}

private struct PageHeader: View {
  let title: String
  let host: String

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.system(.title, design: .rounded, weight: .heavy))
        .foregroundStyle(Pantry.ink)
        .lineLimit(3)
      Text(host).font(.subheadline.weight(.semibold)).foregroundStyle(Pantry.inkSecondary).lineLimit(1)
    }
    .padding(.horizontal, 20)
    .padding(.top, 8)
  }
}

/// A photo share's pages as 3:4 thumbnails, with "From a photo" or "2 pages" in place of the title
/// and host, and "Couldn't read that image" when one couldn't be read.
private struct PhotoHeader: View {
  let thumbnails: [UIImage]
  let pageCount: Int
  let unreadable: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if !thumbnails.isEmpty {
        HStack(spacing: 8) {
          ForEach(Array(thumbnails.enumerated()), id: \.offset) { _, thumbnail in
            Image(uiImage: thumbnail)
              .resizable()
              .scaledToFill()
              .frame(width: 72, height: 96)
              .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
              .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Pantry.border, lineWidth: 1))
          }
        }
        .accessibilityHidden(true)
      }
      Text(SharePhotos.title(pageCount: pageCount))
        .font(.system(.title, design: .rounded, weight: .heavy))
        .foregroundStyle(Pantry.ink)
      if unreadable {
        Text(SharePhotos.unreadableMessage).font(.subheadline.weight(.semibold)).foregroundStyle(Pantry.danger)
      }
    }
    .padding(.horizontal, 20)
    .padding(.top, 8)
  }
}

private struct SectionLabel: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.footnote.weight(.bold))
      .foregroundStyle(Pantry.inkSecondary)
      .padding(.horizontal, 32)
      .padding(.top, 16)
      .padding(.bottom, 8)
  }
}

private struct Card<Content: View>: View {
  @ViewBuilder let content: Content

  var body: some View {
    VStack(spacing: 0) { content }
      .background(Pantry.surface)
      .clipShape(RoundedRectangle(cornerRadius: Pantry.cardRadius, style: .continuous))
      .padding(.horizontal, 16)
  }
}

/// "Also add ingredients to a list" with its switch; disabled, with why under it, when the household
/// has no lists.
private struct AddToListRow: View {
  @ObservedObject var model: ShareModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Card {
        Toggle(isOn: Binding(get: { model.addsToList }, set: { model.addToList = $0 })) {
          Text("Also add ingredients to a list").font(.body.weight(.medium)).foregroundStyle(Pantry.ink)
        }
        .tint(Pantry.primary)
        .disabled(!model.hasLists)
        .padding(.horizontal, 16)
        .frame(minHeight: Pantry.cardRowMin)
        .accessibilityHint(
          model.hasLists
            ? "Adds the recipe's ingredients to the chosen list" : ShareChoice.noListsMessage)
      }
      if !model.hasLists {
        Text(ShareChoice.noListsMessage)
          .font(.footnote)
          .foregroundStyle(Pantry.inkSecondary)
          .padding(.horizontal, 32)
          .padding(.top, 8)
          .accessibilityHidden(true)
      }
    }
    .padding(.top, 16)
  }
}

/// A household or list with a round check, filled when it's the one the recipe goes to.
private struct ChoiceRow: View {
  let name: String
  let selected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        ZStack {
          if selected {
            Circle().fill(Pantry.primary)
            Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(Pantry.onPrimary)
          } else {
            Circle().strokeBorder(Pantry.controlBorder, lineWidth: 2)
          }
        }
        .frame(width: Pantry.check, height: Pantry.check)
        Text(name).font(.body.weight(.medium)).foregroundStyle(Pantry.ink)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 16)
      .frame(minHeight: Pantry.cardRowMin)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

private struct Message: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.body.weight(.medium))
      .foregroundStyle(Pantry.ink)
      .multilineTextAlignment(.center)
      .padding(32)
  }
}

private struct SavedView: View {
  let text: String

  var body: some View {
    VStack(spacing: 16) {
      Image(systemName: "checkmark")
        .font(.title2.weight(.bold))
        .foregroundStyle(Pantry.onPrimarySoft)
        .frame(width: 56, height: 56)
        .background(Pantry.primarySoft, in: Circle())
      Text(text)
        .font(.body.weight(.medium))
        .foregroundStyle(Pantry.ink)
        .multilineTextAlignment(.center)
    }
    .padding(32)
    .accessibilityElement(children: .combine)
  }
}
