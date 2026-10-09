import AppKit

// Static rendition of the reviewed ProvidenceOrigamiArtwork facets.
// The app icon is opaque; watchOS applies its own mask.
let size = 1024
let surface = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
    bytesPerRow: size * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
let context = NSGraphicsContext(cgContext: surface, flipped: false)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.shouldAntialias = true
NSColor.black.setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: size, height: size)).fill()
let paper = NSColor(srgbRed: 0.99, green: 0.99, blue: 0.99, alpha: 1)
let shade = NSColor(srgbRed: 0.92, green: 0.93, blue: 0.93, alpha: 1)
let deep = NSColor(srgbRed: 0.81, green: 0.83, blue: 0.84, alpha: 1)
let seam = NSColor(srgbRed: 0.045, green: 0.05, blue: 0.055, alpha: 1)
func facet(_ vertices: [(Double, Double)], _ start: NSColor, _ end: NSColor? = nil, angle: CGFloat = -90) {
    let path = NSBezierPath()
    for (index, point) in vertices.enumerated() {
        let p = NSPoint(x: 160 + point.0 * 6.8, y: 864 - point.1 * 6.8)
        if index == 0 { path.move(to: p) } else { path.line(to: p) }
    }
    path.close()
    if let end { NSGradient(starting: start, ending: end)!.draw(in: path, angle: angle) }
    else { start.setFill(); path.fill() }
    seam.setStroke(); path.lineWidth = 6.12; path.stroke()
}
facet([(0,16),(10,5),(11,16)], shade)
facet([(11,5),(28,10),(14,32)], paper)
facet([(30,7),(14,32),(47,31)], paper, shade)
facet([(16,33),(47,31),(67,60)], paper, deep)
facet([(31,6),(50,0),(48,31)], shade)
facet([(52,0),(100,10),(49,31)], paper, shade, angle: -45)
facet([(33,44),(67,63),(33,100)], paper, shade)
NSGraphicsContext.restoreGraphicsState()
let bitmap = NSBitmapImageRep(cgImage: surface.makeImage()!)
precondition(!bitmap.hasAlpha)
guard CommandLine.arguments.count == 2,
      let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("Supply an output PNG path") }
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]), options: .atomic)
