import AppKit
import Foundation
import Vision

guard CommandLine.arguments.count == 2 else {
    fputs("用法：swift macos-vision-ocr.swift 图片路径\n", stderr)
    exit(2)
}

let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = NSImage(contentsOf: imageURL) else {
    fputs("无法读取图片\n", stderr)
    exit(3)
}

var proposed = CGRect(origin: .zero, size: image.size)
guard let cgImage = image.cgImage(forProposedRect: &proposed, context: nil, hints: nil) else {
    fputs("无法转换图片\n", stderr)
    exit(4)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true

do {
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])
    let lines = (request.results ?? []).compactMap { observation in
        observation.topCandidates(1).first?.string
    }
    print(lines.joined(separator: "\n"))
} catch {
    fputs("Vision OCR 失败：\(error.localizedDescription)\n", stderr)
    exit(5)
}
