import Foundation
import AVFoundation
import AppKit

// Extracts actual simulator video frames; it does not redraw the app.
let source = URL(fileURLWithPath: CommandLine.arguments[1])
let directory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
let asset = AVURLAsset(url: source)
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = .zero
let frames: [(String, Double)] = [
    ("01-idle", 1), ("02-pressed", 1.8), ("03-preparing", 3.2), ("04-listening", 5),
    ("05-transcribing", 8), ("06-routing", 10), ("07-running", 12), ("08-approval", 15),
    ("09-clarification", 17), ("10-running-again", 19), ("11-preparing-reply", 21),
    ("12-speaking", 24), ("13-paused", 26), ("14-speaking-again", 28),
    ("15-success", 31), ("16-return-idle", 33), ("17-recoverable-error", 35.5), ("18-idle", 38.5)
]
let sheet = NSImage(size: NSSize(width: 840, height: 1_350))
sheet.lockFocus()
NSColor.black.setFill()
NSRect(x: 0, y: 0, width: 840, height: 1_350).fill()
for (index, frame) in frames.enumerated() {
    let cg = try generator.copyCGImage(at: CMTime(seconds: frame.1, preferredTimescale: 600), actualTime: nil)
    let image = NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
    let bitmap = NSBitmapImageRep(cgImage: cg)
    try bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.82])!
        .write(to: directory.appendingPathComponent(frame.0 + ".jpg"))
    let x = CGFloat(index % 4) * 210
    let y = CGFloat(4 - index / 4) * 270
    image.draw(in: NSRect(x: x + 5, y: y + 20, width: 200, height: 238))
    (frame.0 as NSString).draw(at: NSPoint(x: x + 8, y: y + 4), withAttributes: [
        .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .medium), .foregroundColor: NSColor.white
    ])
}
sheet.unlockFocus()
try NSBitmapImageRep(data: sheet.tiffRepresentation!)!.representation(using: .png, properties: [:])!
    .write(to: directory.appendingPathComponent("all-states.png"))
print("Extracted \(frames.count) simulator frames and all-states.png")
