// Renders the app icon: white car glyph on a rounded Subaru-blue gradient.
import AppKit

let S = 1024.0
let img = NSImage(size: NSSize(width: S, height: S))
img.lockFocus()

let bg = NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: S, height: S),
                      xRadius: S * 0.225, yRadius: S * 0.225)
let grad = NSGradient(colors: [
    NSColor(srgbRed: 0.05, green: 0.32, blue: 0.72, alpha: 1),
    NSColor(srgbRed: 0.11, green: 0.62, blue: 0.94, alpha: 1),
])!
grad.draw(in: bg, angle: -55)

if let sym = NSImage(systemSymbolName: "car.fill", accessibilityDescription: nil) {
    let cfg = NSImage.SymbolConfiguration(pointSize: S * 0.44, weight: .semibold)
    let s = sym.withSymbolConfiguration(cfg) ?? sym
    let r = NSRect(x: (S - s.size.width) / 2, y: (S - s.size.height) / 2,
                   width: s.size.width, height: s.size.height)
    // composite white over the glyph shape
    let tinted = NSImage(size: r.size)
    tinted.lockFocus()
    s.draw(in: NSRect(origin: .zero, size: r.size))
    NSColor.white.set()
    NSRect(origin: .zero, size: r.size).fill(using: .sourceAtop)
    tinted.unlockFocus()
    tinted.draw(in: r)
}

img.unlockFocus()

guard let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
    exit(1)
}
try! png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
