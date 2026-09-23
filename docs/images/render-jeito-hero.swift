// Rebuild the README animation on macOS:
// swift docs/images/render-jeito-hero.swift docs/images/jeito-system-hero.gif
// The first frame contains the whole explanation; motion follows an illustrative loop.
import AppKit
import ImageIO
import UniformTypeIdentifiers

let output = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "docs/images/jeito-system-hero.gif"
let width = 1200
let height = 420
let frameCount = 32
let canvasHeight = CGFloat(height)

func color(_ hex: UInt32, alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255,
            green: CGFloat((hex >> 8) & 255) / 255,
            blue: CGFloat(hex & 255) / 255,
            alpha: alpha)
}

let ink = color(0xEAF4EE)
let muted = color(0xA4B9B0)
let mint = color(0x70E6BF)

func rectangle(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat,
               fill: NSColor, radius: CGFloat = 0) {
    let rect = NSRect(x: x, y: canvasHeight - y - h, width: w, height: h)
    fill.setFill()
    NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
}

func segment(_ x1: CGFloat, _ y1: CGFloat, _ x2: CGFloat, _ y2: CGFloat,
             stroke: NSColor, lineWidth: CGFloat = 1) {
    let path = NSBezierPath()
    path.move(to: NSPoint(x: x1, y: canvasHeight - y1))
    path.line(to: NSPoint(x: x2, y: canvasHeight - y2))
    path.lineWidth = lineWidth
    stroke.setStroke()
    path.stroke()
}

func label(_ value: String, _ x: CGFloat, _ y: CGFloat, size: CGFloat,
           weight: NSFont.Weight = .regular, color tint: NSColor = ink,
           mono: Bool = false, maxWidth: CGFloat = 720) {
    let font = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: weight)
                    : NSFont.systemFont(ofSize: size, weight: weight)
    let style = NSMutableParagraphStyle()
    style.lineBreakMode = .byTruncatingTail
    (value as NSString).draw(in: NSRect(x: x, y: canvasHeight - y - size * 1.4,
                                       width: maxWidth, height: size * 1.55),
                             withAttributes: [.font: font, .foregroundColor: tint,
                                              .paragraphStyle: style])
}

let rows: [(name: String, action: String, proof: String)] = [
    ("understand", "task + constraints", "intent"),
    ("choose", "code, docs, web, relations", "right source"),
    ("inspect", "bounded evidence + gaps", "omissions"),
    ("act", "guarded edit + checks", "receipt")
]

let destinationURL = URL(fileURLWithPath: output)
guard let destination = CGImageDestinationCreateWithURL(destinationURL as CFURL,
                                                       UTType.gif.identifier as CFString,
                                                       frameCount, nil) else {
    fatalError("Cannot create GIF at \(output)")
}
CGImageDestinationSetProperties(destination,
    [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)

for frame in 0..<frameCount {
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

    rectangle(0, 0, 1200, 420, fill: color(0x111C1C))
    rectangle(0, 0, 430, 420, fill: color(0x172723))
    // Restrained graph-paper texture, behind the content.
    for x in stride(from: CGFloat(24), through: CGFloat(1190), by: 32) {
        segment(x, 0, x, 420, stroke: color(0x83B9A2, alpha: 0.055))
    }
    for y in stride(from: CGFloat(24), through: CGFloat(420), by: 32) {
        segment(0, y, 1200, y, stroke: color(0x83B9A2, alpha: 0.055))
    }
    rectangle(0, 0, 1200, 5, fill: mint)
    segment(430, 28, 430, 392, stroke: color(0x40655A), lineWidth: 1)

    label("PI CODING AGENT  /  WORKING CONTEXT", 48, 35, size: 15,
          weight: .semibold, color: mint, mono: true, maxWidth: 348)
    label("jeito", 42, 86, size: 94, weight: .bold, maxWidth: 355)
    rectangle(48, 214, 68, 5, fill: mint, radius: 2)
    label("A coding harness", 48, 242, size: 29, weight: .semibold, maxWidth: 360)
    label("built to show its work.", 48, 278, size: 29, weight: .semibold, maxWidth: 368)
    label("Context for the next decision.", 48, 348, size: 18, color: muted, maxWidth: 348)
    label("Omissions stay visible.", 48, 374, size: 18, color: muted, maxWidth: 348)

    label("UNDERSTAND BEFORE ACTING", 478, 36, size: 16, weight: .bold,
          color: mint, mono: true, maxWidth: 400)
    label("illustrative loop", 979, 37, size: 15, color: muted, maxWidth: 185)
    segment(502, 103, 502, 335, stroke: color(0x3B5D52), lineWidth: 3)

    let active = frame / 8
    for (index, row) in rows.enumerated() {
        let y = CGFloat(86 + index * 77)
        let reached = index <= active
        let selected = index == active
        if selected {
            rectangle(480, y - 4, 687, 65, fill: color(0x25463B), radius: 11)
            rectangle(480, y - 4, 4, 65, fill: mint, radius: 2)
        }
        if reached && index > 0 {
            segment(502, y - 30, 502, y + 17, stroke: mint, lineWidth: 3)
        }
        rectangle(495, y + 10, 14, 14,
                  fill: reached ? mint : color(0x537368), radius: 7)
        label(String(format: "%02d", index + 1), 533, y + 1, size: 17,
              weight: .semibold, color: reached ? mint : muted, mono: true, maxWidth: 35)
        label(row.name, 586, y - 1, size: 25, weight: .bold,
              color: selected ? ink : color(0xD5E4DC), mono: true, maxWidth: 160)
        label(row.action, 778, y + 3, size: 19,
              color: selected ? ink : muted, maxWidth: 310)
        let badgeWidth: CGFloat = index == 1 ? 165 : index == 2 ? 150 : 115
        rectangle(1150 - badgeWidth, y + 28, badgeWidth, 29,
                  fill: selected ? color(0x3A6755) : color(0x273A35), radius: 5)
        label(row.proof, 1157 - badgeWidth, y + 30, size: 18,
              weight: .semibold, color: selected ? mint : muted, mono: true,
              maxWidth: badgeWidth - 12)
        if index < 3 {
            segment(532, y + 69, 1166, y + 69,
                    stroke: color(0x53675E, alpha: 0.45))
        }
    }

    // A moving signal connects the inspected stage to the next one. The four
    // labels and their consequences stay visible even when the GIF is paused.
    let travel = CGFloat(frame % 8) / 7
    let signalY = CGFloat(103 + max(0, active - 1) * 77) +
                  (active == 0 ? 0 : travel * 77)
    rectangle(491, signalY - 11, 22, 22,
              fill: color(0x70E6BF, alpha: 0.18), radius: 11)
    rectangle(497, signalY - 5, 10, 10, fill: mint, radius: 5)

    NSGraphicsContext.restoreGraphicsState()
    guard let image = bitmap.cgImage else { fatalError("Cannot encode GIF frame") }
    CGImageDestinationAddImage(destination, image,
        [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 0.125]] as CFDictionary)
}
guard CGImageDestinationFinalize(destination) else { fatalError("Cannot finish GIF") }
print(output)
