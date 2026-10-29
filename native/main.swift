import AppKit
import WebKit

// A local display. Notifications are handled by the CLI, outside the web view.
final class WorkHub: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var timer: Timer?
    private var previousData: Data?
    private var lastError: String?
    private var compact = false
    private var expandedSize = NSSize(width: 900, height: 640)
    private var requestedStateURL: URL?
    private let webRoot = Bundle.main.resourceURL!.appendingPathComponent("web")
    private var stateURL: URL {
        if let requestedStateURL = requestedStateURL { return requestedStateURL }
        if let index = CommandLine.arguments.firstIndex(of: "--state"),
           CommandLine.arguments.indices.contains(index + 1) {
            return URL(fileURLWithPath: CommandLine.arguments[index + 1])
        }
        let root = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
        return root.appendingPathComponent(".runtime/state.json")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.appearance = NSAppearance(named: .darkAqua)
        compact = UserDefaults.standard.bool(forKey: "compact")
        let savedWidth = UserDefaults.standard.double(forKey: "expandedWidth")
        let savedHeight = UserDefaults.standard.double(forKey: "expandedHeight")
        if savedWidth >= 350 && savedHeight >= 270 {
            expandedSize = NSSize(width: savedWidth, height: savedHeight)
        }
        buildMenu()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "luma")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        window = NSWindow(contentRect: NSRect(origin: .zero, size: expandedSize),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "LUMA"
        window.backgroundColor = NSColor(calibratedRed: 16/255, green: 20/255, blue: 22/255, alpha: 1)
        window.contentMinSize = NSSize(width: 350, height: 270)
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("Luma.WorkHub.Window")
        window.setContentSize(compact ? NSSize(width: 400, height: 340) : expandedSize)
        window.isReleasedWhenClosed = false
        webView.loadFileURL(webRoot.appendingPathComponent("index.html"), allowingReadAccessTo: webRoot)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        timer = Timer.scheduledTimer(withTimeInterval: 0.65, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        timer?.tolerance = 0.15
    }

    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        guard let path = filenames.last else { sender.reply(toOpenOrPrint: .failure); return }
        requestedStateURL = URL(fileURLWithPath: path)
        previousData = nil
        lastError = nil
        if webView != nil { refresh() }
        window?.makeKeyAndOrderFront(nil)
        sender.reply(toOpenOrPrint: .success)
    }

    private func buildMenu() {
        let bar = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Lumaを終了", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        bar.addItem(appItem)
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "編集")
        edit.addItem(withTitle: "コピー", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "すべて選択", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        bar.addItem(editItem)
        NSApp.mainMenu = bar
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        previousData = nil
        refresh()
        sendPreferences()
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url,
              url.isFileURL, url.standardizedFileURL.path.hasPrefix(webRoot.path + "/") else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    private func refresh() {
        do {
            guard FileManager.default.fileExists(atPath: stateURL.path) else {
                let empty = Data("{\"schemaVersion\":1,\"sessions\":[]}".utf8)
                if previousData != empty || lastError != nil { deliver(empty) }
                return
            }
            let data = try Data(contentsOf: stateURL)
            guard data != previousData || lastError != nil else { return }
            guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  root["schemaVersion"] as? Int == 1, root["sessions"] is [[String: Any]] else {
                throw NSError(domain: "Luma", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "状態ファイルの形式を確認してください"])
            }
            deliver(data)
        } catch {
            let message = "状態ファイルを読み込めません。最後の表示を保持しています。"
            if lastError != message {
                lastError = message
                webView.callAsyncJavaScript("window.luma.connectionError(message)",
                    arguments: ["message": message], in: nil, in: .page, completionHandler: nil)
            }
        }
    }

    private func deliver(_ data: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: data) else { return }
        webView.callAsyncJavaScript("window.luma.receive(payload)", arguments: ["payload": object],
            in: nil, in: .page) { [weak self] result in
                if case .success = result { self?.previousData = data; self?.lastError = nil }
            }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let action = message.body as? String else { return }
        switch action {
        case "pin":
            window.level = window.level == .floating ? .normal : .floating
        case "compact":
            if !compact { expandedSize = window.contentLayoutRect.size }
            compact.toggle()
            let origin = window.frame.origin
            let oldHeight = window.frame.height
            window.setContentSize(compact ? NSSize(width: 400, height: 340) : expandedSize)
            window.setFrameOrigin(NSPoint(x: origin.x, y: origin.y + oldHeight - window.frame.height))
        default: return
        }
        sendPreferences()
    }

    private func sendPreferences() {
        savePreferences()
        webView.callAsyncJavaScript("window.luma.preferences(prefs)",
            arguments: ["prefs": ["pinned": window.level == .floating, "compact": compact]],
            in: nil, in: .page, completionHandler: nil)
    }

    private func savePreferences() {
        UserDefaults.standard.set(compact, forKey: "compact")
        UserDefaults.standard.set(expandedSize.width, forKey: "expandedWidth")
        UserDefaults.standard.set(expandedSize.height, forKey: "expandedHeight")
    }

    func applicationWillTerminate(_ notification: Notification) {
        if !compact { expandedSize = window.contentLayoutRect.size }
        savePreferences()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }
}

let app = NSApplication.shared
let delegate = WorkHub()
app.delegate = delegate
app.run()
