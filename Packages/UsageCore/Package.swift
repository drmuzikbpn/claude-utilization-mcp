// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "UsageCore",
    platforms: [
        .iOS(.v18),
        .watchOS(.v11),
        // macOS only so `swift test` runs on the development Mac; no app ships there.
        .macOS(.v15),
    ],
    products: [
        .library(name: "UsageCore", targets: ["UsageCore"]),
    ],
    targets: [
        .target(
            name: "UsageCore",
            swiftSettings: [.enableUpcomingFeature("ExistentialAny")]
        ),
        .testTarget(
            name: "UsageCoreTests",
            dependencies: ["UsageCore"],
            resources: [.copy("Fixtures")],
            swiftSettings: [.enableUpcomingFeature("ExistentialAny")]
        ),
    ]
)
