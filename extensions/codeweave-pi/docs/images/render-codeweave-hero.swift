// Rebuild the codeweave-pi README GIF on macOS:
// swift extensions/codeweave-pi/docs/images/render-codeweave-hero.swift extensions/codeweave-pi/docs/images/codeweave-context.gif
// Labels remain visible when paused; the selected evidence view changes with the question.
import AppKit
import ImageIO
import UniformTypeIdentifiers

let output = CommandLine.arguments.count > 1 ? CommandLine.arguments[1]
    : "extensions/codeweave-pi/docs/images/codeweave-context.gif"
let width = 1200
let height = 420
let frames = 40
let h = CGFloat(height)

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255,
            green: CGFloat((hex >> 8) & 255) / 255,
            blue: CGFloat(hex & 255) / 255, alpha: alpha)
}
let ink = color(0xEAF4EE)
let muted = color(0xA4B9B0)
let mint = color(0x70E6BF)
let amber = color(0xF3C57D)

func box(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ hh: CGFloat,
         _ fill: NSColor, radius: CGFloat = 0) {
    fill.setFill()
    NSBezierPath(roundedRect: NSRect(x: x, y: h - y - hh, width: w, height: hh),
                 xRadius: radius, yRadius: radius).fill()
}
func circle(_ x: CGFloat, _ y: CGFloat, _ r: CGFloat, _ fill: NSColor) {
    fill.setFill()
    NSBezierPath(ovalIn: NSRect(x: x-r, y: h-y-r, width: r*2, height: r*2)).fill()
}
func line(_ x: CGFloat, _ y: CGFloat, _ xx: CGFloat, _ yy: CGFloat,
          _ stroke: NSColor, width: CGFloat = 1) {
    let path = NSBezierPath()
    path.move(to: NSPoint(x: x, y: h-y))
    path.line(to: NSPoint(x: xx, y: h-yy))
    path.lineWidth = width
    stroke.setStroke()
    path.stroke()
}
func text(_ value: String, _ x: CGFloat, _ y: CGFloat, size: CGFloat,
          weight: NSFont.Weight = .regular, tint: NSColor = ink,
          mono: Bool = false, maxWidth: CGFloat = 700) {
    let font = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: weight)
                    : NSFont.systemFont(ofSize: size, weight: weight)
    let style = NSMutableParagraphStyle()
    style.lineBreakMode = .byTruncatingTail
    (value as NSString).draw(in: NSRect(x: x, y: h-y-size*1.4,
                                       width: maxWidth, height: size*1.55),
                             withAttributes: [.font: font, .foregroundColor: tint,
                                              .paragraphStyle: style])
}

guard let destination = CGImageDestinationCreateWithURL(
    URL(fileURLWithPath: output) as CFURL, UTType.gif.identifier as CFString,
    frames, nil) else { fatalError("Cannot create GIF") }
CGImageDestinationSetProperties(destination,
    [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)

for frame in 0..<frames {
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width,
                                       pixelsHigh: height, bitsPerSample: 8,
                                       samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                       colorSpaceName: .deviceRGB, bytesPerRow: 0,
                                       bitsPerPixel: 0),
          let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        fatalError("Cannot draw GIF frame")
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    box(0, 0, 1200, 420, color(0x111C1C))
    box(0, 0, 430, 420, color(0x172723))
    for x in stride(from: CGFloat(24), through: CGFloat(1190), by: 32) {
        line(x, 0, x, 420, color(0x83B9A2, 0.055))
    }
    for y in stride(from: CGFloat(24), through: CGFloat(420), by: 32) {
        line(0, y, 1200, y, color(0x83B9A2, 0.055))
    }
    box(0, 0, 1200, 5, mint)
    line(430, 28, 430, 392, color(0x40655A))

    text("REPOSITORY CONTEXT  /  ON DEMAND", 48, 35, size: 14,
         weight: .semibold, tint: mint, mono: true, maxWidth: 360)
    text("codeweave-pi", 43, 101, size: 51, weight: .bold, maxWidth: 382)
    box(48, 214, 68, 5, mint, radius: 2)
    text("Build the next view.", 48, 244, size: 27,
         weight: .semibold, maxWidth: 360)
    text("Keep the rest reachable.", 48, 287, size: 20,
         tint: muted, maxWidth: 355)
    text("code  ·  docs  ·  source", 48, 365, size: 17,
         tint: mint, mono: true, maxWidth: 350)

    text("THE QUESTION CHANGES THE VIEW", 478, 30, size: 16,
         weight: .bold, tint: amber, mono: true, maxWidth: 620)
    let rows: [(String, String, CGFloat)] = [
        ("DISCOVER", "implementation + relationships", 79),
        ("EXAMINE", "callers, tests + written contracts", 151),
        ("CHECK", "exact matches + current source", 223)
    ]
    // Highlight a different evidence view; the sequence is not a required workflow.
    let selected = [0, 2, 1, 2][frame / 10]
    let travel = CGFloat(frame % 10) / 9
    for (index, row) in rows.enumerated() {
        let (label, detail, y) = row
        line(465, 187, 491, y + 31, color(0x527467, 0.65), width: 2)
        box(500, y, 657, 63, color(0x202D2A), radius: 9)
        box(500, y, 4, 63, selected == index ? mint : color(0x46645A), radius: 2)
        text(label, 519, y + 15, size: 16, weight: .bold,
             tint: selected == index ? mint : muted, mono: true, maxWidth: 145)
        text(detail, 678, y + 13, size: 18,
             tint: selected == index ? ink : muted, maxWidth: 450)
    }
    circle(465, 187, 7, amber)
    let destinationY = rows[selected].2 + 31
    circle(465 + 27 * travel, 187 + (destinationY - 187) * travel,
           5, amber)
    circle(491, destinationY, 5, mint)

    box(500, 318, 657, 78, color(0x1E312B), radius: 9)
    text("EVIDENCE YOU CAN REVISIT", 519, 329, size: 16,
         weight: .bold, tint: mint, mono: true, maxWidth: 420)
    text("Scope + omissions  ·  deeper source stays reachable", 519, 354,
         size: 17, maxWidth: 615)
    text("Complete current lines can carry into a checked edit", 519, 377,
         size: 15, tint: muted, maxWidth: 615)

    NSGraphicsContext.restoreGraphicsState()
    guard let image = bitmap.cgImage else { fatalError("Cannot encode GIF") }
    CGImageDestinationAddImage(destination, image,
        [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 0.11]] as CFDictionary)
}
guard CGImageDestinationFinalize(destination) else { fatalError("Cannot finish GIF") }
print(output)
