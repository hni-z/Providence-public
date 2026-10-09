// Render the shared Providence black tile as opaque iPhone and Watch app icons.
// Source: coordinator/web/public/favicon.svg. Run from the repository root.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
    bytesPerRow: size * 4, space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(colorSpace: colorSpace, components: [0, 0, 0, 1])!)
context.fill(CGRect(x: 0, y: 0, width: size, height: size))
context.setFillColor(CGColor(colorSpace: colorSpace, components: [1, 1, 1, 1])!)
let triangles: [[(Double, Double)]] = [
    [(3,12),(8.5,6.4),(9,12)], [(9.7,6.1),(18.9,8.5),(11.1,20.5)],
    [(12.2,21),(20.8,7),(30.2,20.8)], [(22,6.7),(33.1,3.2),(31.3,20.3)],
    [(34.3,3),(61,8.4),(32.5,20.4)], [(12.4,22.3),(31,22.1),(41.7,38.1)],
    [(21.9,28.9),(42.3,39.4),(21.9,61)]
]
for triangle in triangles {
    context.beginPath()
    for (index, point) in triangle.enumerated() {
        let point = CGPoint(x: (8 + point.0) * 12.8, y: 1024 - (8 + point.1) * 12.8)
        if index == 0 { context.move(to: point) } else { context.addLine(to: point) }
    }
    context.closePath(); context.fillPath()
}
let image = context.makeImage()!
for path in ["iPhone/Providence/Assets.xcassets/AppIcon.appiconset/AppIcon.png", "WatchStarter/Assets.xcassets/AppIcon.appiconset/AppIcon.png"] {
    let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("Icon export failed") }
}
