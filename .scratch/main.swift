import Foundation

let enc = JSONEncoder()
enc.outputFormatting = [.withoutEscapingSlashes]
let full = ShareQueue.Envelope(
  id: "019a5e21-4b7c-7a10-9c3e-5d2f8a6b1e04",
  url: "https://www.halfbakedharvest.com/20-minute-thai-peanut-chicken-ramen/",
  listId: "019a4c10-0000-7000-8000-00000000c057",
  page: .init(
    title: "20 Minute Thai Peanut Chicken Ramen",
    jsonLd: ["{\"@type\":\"Recipe\",\"name\":\"Thai Peanut Chicken Ramen\"}"],
    text: "Thai Peanut Chicken Ramen\nIngredients\n2 tablespoons peanut butter"),
  createdAt: "2026-10-11T09:12:40.512-05:00", appVersion: "1.0.0", source: "share")
let bare = ShareQueue.Envelope(
  id: "019a5e22-03d1-7b55-8e19-a4c07f3b9d61",
  url: "https://www.allrecipes.com/recipe/230103/buttery-garlic-green-beans/",
  listId: nil, page: nil, createdAt: "2026-10-11T09:14:02.090-05:00", appVersion: "1.0.0", source: "share")
print(String(data: try enc.encode(full), encoding: .utf8)!)
print(String(data: try enc.encode(bare), encoding: .utf8)!)

let snapPath = CommandLine.arguments[1]
let s = try JSONDecoder().decode(SiriQueue.ListSnapshot.self, from: Data(contentsOf: URL(fileURLWithPath: snapPath)))
print("snapshot lastOpened:", s.lastOpenedListId ?? "nil", "lists:", s.lists.count)
let old = try JSONDecoder().decode(SiriQueue.ListSnapshot.self, from: Data("{\"lists\":[]}".utf8))
print("old snapshot lastOpened:", old.lastOpenedListId ?? "nil")
let back = try JSONDecoder().decode(ShareQueue.Envelope.self, from: try enc.encode(bare))
print("roundtrip:", back.listId ?? "nil", back.page == nil)
