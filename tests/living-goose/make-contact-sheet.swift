import Foundation
import AppKit

let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
    .filter { $0.pathExtension == "jpg" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
let rows = Int(ceil(Double(files.count) / 4))
let height = CGFloat(rows * 270)
let sheet = NSImage(size: NSSize(width: 840, height: height))
sheet.lockFocus()
NSColor.black.setFill()
NSRect(x: 0, y: 0, width: 840, height: height).fill()
for (index, file) in files.enumerated() {
    guard let image = NSImage(contentsOf: file) else { continue }
    let x = CGFloat(index % 4) * 210
    let y = CGFloat(rows - 1 - index / 4) * 270
    image.draw(in: NSRect(x: x + 5, y: y + 20, width: 200, height: 238))
    (file.deletingPathExtension().lastPathComponent as NSString).draw(at: NSPoint(x: x + 8, y: y + 4), withAttributes: [
        .font: NSFont.monospacedSystemFont(ofSize: 9, weight: .medium), .foregroundColor: NSColor.white
    ])
}
sheet.unlockFocus()
try NSBitmapImageRep(data: sheet.tiffRepresentation!)!.representation(using: .png, properties: [:])!
    .write(to: directory.appendingPathComponent("layout-matrix.png"))
print("Contact sheet: \(files.count) screenshots")
