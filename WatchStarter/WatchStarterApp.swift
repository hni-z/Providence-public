import SwiftUI

@main
struct WatchStarterApp: App {
    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if ProvidenceFlowPreview.requested {
                ProvidenceFlowPreview()
            } else {
                ContentView()
            }
            #else
            ContentView()
            #endif
        }
    }
}
