// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "WatchCoordinatorAdapter",
    platforms: [
        .watchOS(.v9),
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(
            name: "WatchCoordinatorAdapter",
            targets: ["WatchCoordinatorAdapter"]
        ),
    ],
    targets: [
        .target(name: "WatchCoordinatorAdapter"),
        .testTarget(
            name: "WatchCoordinatorAdapterTests",
            dependencies: ["WatchCoordinatorAdapter"]
        ),
    ]
)
