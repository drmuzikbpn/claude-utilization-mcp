// Regenerate the app icon: swift scripts/make-icon.swift App/Assets.xcassets/AppIcon.appiconset/icon-1024.png
// (then copy it to Watch/Assets.xcassets/AppIcon.appiconset/).
import AppKit
import CoreGraphics

/// Usage Deck icon: the deck's two rings (5 h outer, 7 d inner) on the dark ground, opaque 1024².
func rgb(_ hex: UInt32) -> CGColor {
    CGColor(
        red: CGFloat((hex >> 16) & 0xFF) / 255,
        green: CGFloat((hex >> 8) & 0xFF) / 255,
        blue: CGFloat(hex & 0xFF) / 255,
        alpha: 1
    )
}

let size = 1024
let space = CGColorSpaceCreateDeviceRGB()
let ctx = CGContext(
    data: nil,
    width: size,
    height: size,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: space,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
)!
ctx.setFillColor(rgb(0x0E1013))
ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))

let center = CGPoint(x: 512, y: 512)
func ring(radius: CGFloat, width: CGFloat, fraction: CGFloat, color: CGColor) {
    ctx.setLineWidth(width)
    ctx.setLineCap(.round)
    ctx.setStrokeColor(rgb(0x262D37))
    ctx.addArc(center: center, radius: radius, startAngle: 0, endAngle: .pi * 2, clockwise: false)
    ctx.strokePath()
    // From twelve o'clock, clockwise (CG's y axis points up, so clockwise == true).
    let start = CGFloat.pi / 2
    ctx.setStrokeColor(color)
    ctx.addArc(center: center, radius: radius, startAngle: start, endAngle: start - .pi * 2 * fraction, clockwise: true)
    ctx.strokePath()
}

ring(radius: 330, width: 96, fraction: 0.72, color: rgb(0x3DBE8B))
ring(radius: 190, width: 72, fraction: 0.45, color: rgb(0xF0B429))

let image = ctx.makeImage()!
let rep = NSBitmapImageRep(cgImage: image)
let png = rep.representation(using: .png, properties: [:])!
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
