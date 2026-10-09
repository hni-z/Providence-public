import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.tintColor = ProvidenceColors.accent
        window.rootViewController = ProvidenceViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        (window?.rootViewController as? ProvidenceViewController)?.suspendVoice()
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        (window?.rootViewController as? ProvidenceViewController)?.resumePage()
    }
}
