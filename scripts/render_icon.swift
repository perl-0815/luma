#!/usr/bin/env swift
import AppKit
import Foundation

// Native counterpart of web/mark.svg. Coordinates use the same 48 × 48 grid.
// Usage: xcrun swift scripts/render_icon.swift /path/to/Luma.iconset
guard CommandLine.arguments.count == 2 else {
    fputs("Usage: render_icon.swift OUTPUT.iconset\n", stderr)
    exit(1)
}

let outputURL = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let fileManager = FileManager.default

func color(_ red: Int, _ green: Int, _ blue: Int) -> NSColor {
    NSColor(srgbRed: CGFloat(red) / 255, green: CGFloat(green) / 255,
            blue: CGFloat(blue) / 255, alpha: 1)
}

func drawMark() {
    let letter = NSBezierPath()
    letter.move(to: NSPoint(x: 8, y: 12))
    letter.line(to: NSPoint(x: 15, y: 5))
    letter.line(to: NSPoint(x: 15, y: 28))
    letter.curve(to: NSPoint(x: 22, y: 35),
                 controlPoint1: NSPoint(x: 15, y: 31.865993),
                 controlPoint2: NSPoint(x: 18.134007, y: 35))
    letter.line(to: NSPoint(x: 41, y: 35))
    letter.line(to: NSPoint(x: 34, y: 42))
    letter.line(to: NSPoint(x: 22, y: 42))
    letter.curve(to: NSPoint(x: 8, y: 28),
                 controlPoint1: NSPoint(x: 14.268014, y: 42),
                 controlPoint2: NSPoint(x: 8, y: 35.731986))
    letter.close()
    color(241, 239, 231).setFill()
    letter.fill()

    let branch = NSBezierPath()
    branch.move(to: NSPoint(x: 15, y: 25))
    branch.line(to: NSPoint(x: 24, y: 25))
    branch.curve(to: NSPoint(x: 31, y: 18),
                 controlPoint1: NSPoint(x: 27.865993, y: 25),
                 controlPoint2: NSPoint(x: 31, y: 21.865993))
    branch.lineWidth = 4
    branch.lineCapStyle = .butt
    color(121, 216, 208).setStroke()
    branch.stroke()

    let core = NSBezierPath(roundedRect: NSRect(x: 25, y: 9, width: 12, height: 12),
                            xRadius: 3, yRadius: 3)
    let rotation = AffineTransform(translationByX: 31, byY: 15)
    var transform = rotation
    transform.rotate(byDegrees: 45)
    transform.translate(x: -31, y: -15)
    core.transform(using: transform)
    color(121, 216, 208).setFill()
    core.fill()
}

func renderIcon(pixels: Int) throws -> Data {
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil,
                                       pixelsWide: pixels, pixelsHigh: pixels,
                                       bitsPerSample: 8, samplesPerPixel: 4,
                                       hasAlpha: true, isPlanar: false,
                                       colorSpaceName: .deviceRGB,
                                       bytesPerRow: 0, bitsPerPixel: 0),
          let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw NSError(domain: "LumaIcon", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Unable to create bitmap"])
    }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    context.shouldAntialias = true

    // Flip once so the web and native asset share identical coordinates.
    let canvasTransform = NSAffineTransform()
    canvasTransform.scale(by: CGFloat(pixels) / 64)
    canvasTransform.translateX(by: 0, yBy: 64)
    canvasTransform.scaleX(by: 1, yBy: -1)
    canvasTransform.concat()

    // Leave a small transparent inset, as with native macOS app icons.
    let tile = NSBezierPath(roundedRect: NSRect(x: 3, y: 3, width: 58, height: 58),
                            xRadius: 13, yRadius: 13)
    color(16, 20, 22).setFill()
    tile.fill()

    // A quiet edge keeps the dark tile visible against a dark desktop.
    tile.lineWidth = 0.5
    color(38, 43, 45).setStroke()
    tile.stroke()

    let inset = NSAffineTransform()
    inset.translateX(by: 8, yBy: 8)
    inset.concat()
    drawMark()
    NSGraphicsContext.restoreGraphicsState()

    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "LumaIcon", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "Unable to encode PNG"])
    }
    return data
}

do {
    try fileManager.createDirectory(at: outputURL, withIntermediateDirectories: true)
    for size in [16, 32, 128, 256, 512] {
        for scale in [1, 2] {
            let suffix = scale == 1 ? "" : "@2x"
            let filename = "icon_\(size)x\(size)\(suffix).png"
            let data = try renderIcon(pixels: size * scale)
            try data.write(to: outputURL.appendingPathComponent(filename))
        }
    }
    print("Rendered 10 Luma icon PNGs in \(outputURL.path)")
} catch {
    fputs("Icon rendering failed: \(error.localizedDescription)\n", stderr)
    exit(1)
}
