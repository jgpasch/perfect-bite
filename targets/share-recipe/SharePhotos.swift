import Foundation
import ImageIO
import UniformTypeIdentifiers

/// A photo share's pages (spec 4.10 step 3, **Saving a photo share**). Each image is downscaled with
/// ImageIO straight from its file, never decoded at full size (the extension's memory limit), which
/// also handles HEIC, PNG screenshots and orientation. One image at a time; each bitmap is released
/// before the next.
enum SharePhotos {
  /// `MAX_PHOTO_IMPORT_IMAGES` in src/shared/schemas/recipe-photo-import.ts, and the Info.plist's
  /// `NSExtensionActivationSupportsImageWithMaxCount`.
  static let maxImages = 3
  /// `MAX_PHOTO_IMPORT_IMAGE_BYTES`: each page, decoded.
  static let maxImageBytes = 2 * 1024 * 1024
  static let maxPixelSize = 2000
  /// Tried in order while the JPEG is over `maxImageBytes`.
  static let qualities: [CGFloat] = [0.8, 0.6, 0.4]
  static let thumbPixelSize = 400
  static let thumbQuality: CGFloat = 0.7
  /// `share/thumbs/<id>/<n>.jpg`, n from 1, for the app's imports card.
  static let thumbsPath = "share/thumbs"
  static let mediaType = "image/jpeg"

  /// A page as uploaded (`jpeg`) and as the sheet and the imports card show it (`thumb`).
  struct Page: Sendable {
    let jpeg: Data
    let thumb: Data
  }

  /// The first `maxImages` providers that carry an image, in the order shared.
  static func imageProviders(_ providers: [NSItemProvider]) -> [NSItemProvider] {
    Array(providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }.prefix(maxImages))
  }

  /// Reads one provider's image: from its file when it has one (the file only lasts as long as the
  /// handler, so the page is made in there), else from its data. Nil when it can't be read.
  static func load(_ provider: NSItemProvider) async -> Page? {
    let fromFile: Page? = await withCheckedContinuation { continuation in
      provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, _ in
        continuation.resume(
          returning: url.flatMap { SharePhotos.page(CGImageSourceCreateWithURL($0 as CFURL, SharePhotos.sourceOptions)) })
      }
    }
    if let fromFile { return fromFile }
    return await withCheckedContinuation { continuation in
      provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
        continuation.resume(
          returning: data.flatMap { SharePhotos.page(CGImageSourceCreateWithData($0 as CFData, SharePhotos.sourceOptions)) })
      }
    }
  }

  private static var sourceOptions: CFDictionary { [kCGImageSourceShouldCache: false] as CFDictionary }

  /// The page from an image source, or nil when it can't be decoded or stays over `maxImageBytes`
  /// even at the lowest quality.
  static func page(_ source: CGImageSource?) -> Page? {
    guard let source else { return nil }
    let jpeg: Data? = autoreleasepool {
      guard let image = downscale(source, maxPixelSize: maxPixelSize) else { return nil }
      for quality in qualities {
        guard let data = encode(image, quality: quality) else { return nil }
        if data.count <= maxImageBytes { return data }
      }
      return nil
    }
    guard let jpeg else { return nil }
    let thumb: Data? = autoreleasepool {
      downscale(source, maxPixelSize: thumbPixelSize).flatMap { encode($0, quality: thumbQuality) }
    }
    guard let thumb else { return nil }
    return Page(jpeg: jpeg, thumb: thumb)
  }

  /// The image with its long edge at most `maxPixelSize` (never scaled up), upright.
  static func downscale(_ source: CGImageSource, maxPixelSize: Int) -> CGImage? {
    let options =
      [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceShouldCacheImmediately: true,
        kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
      ] as CFDictionary
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options)
  }

  static func encode(_ image: CGImage, quality: CGFloat) -> Data? {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(
      destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return data as Data
  }

  /// The envelope's `images`, in page order.
  static func envelopeImages(_ pages: [Page]) -> [ShareQueue.Envelope.Image] {
    pages.map { ShareQueue.Envelope.Image(mediaType: mediaType, data: $0.jpeg.base64EncodedString()) }
  }

  /// Writes each page's thumbnail to `share/thumbs/<id>/<n>.jpg`. Called before the envelope is.
  static func writeThumbs(_ pages: [Page], id: String) throws {
    let dir = try ShareQueue.dir("\(thumbsPath)/\(id)")
    for (index, page) in pages.enumerated() {
      try ShareQueue.writeAtomically(page.thumb, in: dir, name: "\(index + 1).jpg")
    }
  }

  /// "From a photo" for one page, else "2 pages".
  static func title(pageCount: Int) -> String {
    pageCount <= 1 ? "From a photo" : "\(pageCount) pages"
  }

  static let unreadableMessage = "Couldn't read that image"
}
