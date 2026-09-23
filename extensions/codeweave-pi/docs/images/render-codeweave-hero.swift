// Rebuild the codeweave-pi README GIF on macOS:
// swift extensions/codeweave-pi/docs/images/render-codeweave-hero.swift extensions/codeweave-pi/docs/images/codeweave-hero.gif
// Every label remains visible in a paused frame; motion traces the evidence handoff.
import AppKit
import ImageIO
import UniformTypeIdentifiers

let output = CommandLine.arguments.count > 1 ? CommandLine.arguments[1]
    : "extensions/codeweave-pi/docs/images/codeweave-hero.gif"
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

    text("CODE NAVIGATION  /  SOURCE PROOF", 48, 35, size: 14,
         weight: .semibold, tint: mint, mono: true, maxWidth: 360)
    text("codeweave-pi", 43, 101, size: 51, weight: .bold, maxWidth: 382)
    box(48, 214, 68, 5, mint, radius: 2)
    text("Locate the owner.", 48, 242, size: 29, weight: .semibold, maxWidth: 360)
    text("Earn the edit.", 48, 278, size: 29, weight: .semibold, maxWidth: 360)
    text("Prepared evidence finds.", 48, 348, size: 18, tint: muted, maxWidth: 348)
    text("Current bytes authorize.", 48, 374, size: 18, tint: muted, maxWidth: 348)

    text("01  PREPARED EVIDENCE", 478, 29, size: 16,
         weight: .bold, tint: amber, mono: true, maxWidth: 380)
    text("relationships + docs", 478, 56, size: 17,
         tint: muted, maxWidth: 310)
    // A relationship network points to a candidate. It never supplies edit authority.
    let edges: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [
        (520, 134, 616, 103), (520, 134, 615, 160),
        (616, 103, 724, 126), (615, 160, 724, 126)
    ]
    for (x,y,xx,yy) in edges { line(x,y,xx,yy,color(0x52665F),width:2) }
    for (x,y) in [(520.0,134.0),(616.0,103.0),(615.0,160.0),(724.0,126.0)] {
        circle(x,y,7,color(0x41645A))
    }
    let phase = frame / 10
    let travel = CGFloat(frame % 10) / 9
    let selectedEdge = edges[min(phase,2)]
    let px = selectedEdge.0 + (selectedEdge.2-selectedEdge.0)*travel
    let py = selectedEdge.1 + (selectedEdge.3-selectedEdge.1)*travel
    if phase < 2 {
        circle(px,py,12,color(0xF3C57D,0.16))
        circle(px,py,5,amber)
    }
    circle(724,126,8,phase >= 1 ? amber : color(0x41645A))
    line(755, 126, 795, 126, color(0x8C7A5B), width:2)
    box(803, 86, 354, 102, color(0x202C2A), radius:10)
    box(803, 86, 4, 102, phase >= 1 ? amber : color(0x54655E), radius:2)
    text("CANDIDATE  /  not edit authority", 822, 98, size: 16,
         weight: .semibold, tint: phase >= 1 ? amber : muted,
         mono:true, maxWidth:320)
    text("src/tools/edit.ts", 822, 132, size: 22,
         weight:.semibold, mono:true, maxWidth:310)
    line(478, 203, 1160, 203, color(0x52665F), width:1)

    text("02  LIVE SOURCE", 478, 216, size:16, weight:.bold,
         tint:mint, mono:true, maxWidth:280)
    text("read the file as it is now", 478, 245, size:18,
         tint:muted, maxWidth:350)
    box(480, 283, 393, 90, color(0x1E312B), radius:9)
    text("complete displayed lines", 498, 297, size:19,
         weight:.semibold, maxWidth:355)
    box(498, 335, 163, 27, phase >= 2 ? color(0x376650) : color(0x2A4338), radius:5)
    text("[path#hash]", 507, 337, size:18, weight:.semibold,
         tint:phase >= 2 ? mint : muted, mono:true, maxWidth:150)
    if phase == 2 {
        box(478, 283, 4, 90, mint, radius:2)
        box(692 + travel*120, 335, 30, 27, color(0x70E6BF,0.22), radius:6)
    }
    line(886, 327, 911, 327, color(0x70E6BF,0.72), width:2)
    box(919, 283, 238, 90, color(0x263A33), radius:9)
    text("edit", 937, 295, size:23, weight:.bold, mono:true, maxWidth:190)
    text("seen + live → apply", 937, 327, size:16,
         tint:phase == 3 ? mint : muted, mono:true, maxWidth:210)
    text("unsafe → refuse", 937, 351, size:16,
         tint:phase == 3 ? amber : muted, mono:true, maxWidth:210)
    if phase == 3 { box(917, 283, 4, 90, mint, radius:2) }

    NSGraphicsContext.restoreGraphicsState()
    guard let image = bitmap.cgImage else { fatalError("Cannot encode GIF") }
    CGImageDestinationAddImage(destination, image,
        [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 0.11]] as CFDictionary)
}
guard CGImageDestinationFinalize(destination) else { fatalError("Cannot finish GIF") }
print(output)
