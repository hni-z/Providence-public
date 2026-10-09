// Reproduce Providence's original geometric icon without fonts or external assets.
// Run from the repository root: swift scripts/generate-app-icon.swift
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let output = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    .appendingPathComponent("WatchStarter/Assets.xcassets/AppIcon.appiconset/AppIcon.png")
let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                        bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(red: 0.035, green: 0.07, blue: 0.12, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: size, height: size))

// A broad, open P remains readable under the circular watchOS icon mask.
context.setStrokeColor(CGColor(red: 0.94, green: 0.97, blue: 1, alpha: 1))
context.setLineWidth(96)
context.setLineCap(.round)
context.setLineJoin(.round)
let mark = CGMutablePath()
mark.move(to: CGPoint(x: 350, y: 270))
mark.addLine(to: CGPoint(x: 350, y: 750))
mark.addLine(to: CGPoint(x: 535, y: 750))
mark.addCurve(to: CGPoint(x: 535, y: 450), control1: CGPoint(x: 745, y: 750),
              control2: CGPoint(x: 745, y: 450))
mark.addLine(to: CGPoint(x: 350, y: 450))
context.addPath(mark)
context.strokePath()

// Three small voice bars distinguish the mark from a plain letter.
context.setStrokeColor(CGColor(red: 0.30, green: 0.85, blue: 0.94, alpha: 1))
context.setLineWidth(32)
for (x, height) in [(550.0, 48.0), (618.0, 106.0), (686.0, 66.0)] {
    context.move(to: CGPoint(x: x, y: 286 - height / 2))
    context.addLine(to: CGPoint(x: x, y: 286 + height / 2))
    context.strokePath()
}
try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("Could not write app icon") }
print(output.path)
