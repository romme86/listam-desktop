// Renders the listam icon into a macOS app-icon master PNG:
// 1024x1024 transparent canvas, white squircle on Apple's icon grid
// (824pt box, 185.4pt corner radius), source artwork aspect-filled into it.
// Usage: swift make-icns.swift <src.png> <out-master.png>
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let src = NSImage(contentsOfFile: args[1]) else {
  FileHandle.standardError.write("usage: make-icns.swift <src.png> <out-master.png>\n".data(using: .utf8)!)
  exit(1)
}

let canvas = 1024
let box = NSRect(x: 100, y: 100, width: 824, height: 824)
let radius: CGFloat = 185.4

let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: canvas, pixelsHigh: canvas,
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: canvas, height: canvas)

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

NSBezierPath(roundedRect: box, xRadius: radius, yRadius: radius).addClip()
NSColor.white.setFill()
box.fill()

let scale = max(box.width / src.size.width, box.height / src.size.height)
let w = src.size.width * scale
let h = src.size.height * scale
src.draw(
  in: NSRect(x: box.midX - w / 2, y: box.midY - h / 2, width: w, height: h),
  from: .zero, operation: .sourceOver, fraction: 1)

NSGraphicsContext.restoreGraphicsState()

try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
