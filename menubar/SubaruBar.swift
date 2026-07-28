// Subaru Bar — menu bar remote for Subaru STARLINK vehicles.
//
// Native reimplementation of the TypeScript client in ../src. There is no
// bundled backend: the MySubaru API is four form POSTs plus a polling loop,
// which URLSession handles directly. Credentials live in the Keychain rather
// than a .env, since this ships as an app rather than a checkout.
//
// If the command payloads here drift from ../src/client.ts, the TypeScript
// side is the reference — it is the one covered by tests.

import AppKit
import SwiftUI
import UserNotifications

// MARK: - Credentials (Keychain)

/// Account details, stored as a single JSON blob in the login keychain.
struct Credentials: Codable, Equatable {
    var username = ""
    var password = ""
    var pin = ""
    var vehicleKey = ""
    var vin = ""
    /// Client-chosen identifier. MySubaru ties "remember this device" to it, so
    /// it is generated once and then left alone.
    var deviceId = String(Int(Date().timeIntervalSince1970 * 1000))

    var isComplete: Bool {
        !username.isEmpty && !password.isEmpty && !pin.isEmpty && !vehicleKey.isEmpty
    }
}

enum Keychain {
    private static let service = "com.digitalhen.subarubar"
    private static let account = "mysubaru"

    static func load() -> Credentials {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let creds = try? JSONDecoder().decode(Credentials.self, from: data)
        else { return Credentials() }
        return creds
    }

    static func save(_ creds: Credentials) {
        guard let data = try? JSONEncoder().encode(creds) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        // Update in place if present, otherwise add.
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(add as CFDictionary, nil)
        }
    }
}

// MARK: - API

enum Command: String, CaseIterable {
    case lock, unlock, start, stop

    /// Path segment on the g2 API — not always the same as the verb.
    var endpoint: String {
        switch self {
        case .lock: return "lock"
        case .unlock: return "unlock"
        case .start: return "engineStart"
        case .stop: return "engineStop"
        }
    }

    var title: String {
        switch self {
        case .lock: return "Lock"
        case .unlock: return "Unlock"
        case .start: return "Start Engine"
        case .stop: return "Stop Engine"
        }
    }

    var progressLabel: String {
        switch self {
        case .lock: return "Locking…"
        case .unlock: return "Unlocking…"
        case .start: return "Starting…"
        case .stop: return "Stopping…"
        }
    }

    var symbol: String {
        switch self {
        case .lock: return "lock.fill"
        case .unlock: return "lock.open.fill"
        case .start: return "power"
        case .stop: return "stop.fill"
        }
    }
}

struct SubaruError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Settings for a remote start. Defaults match the published shortcuts.
struct StartSettings: Codable {
    var runTimeMinutes = 10
    var frontTemp = 70
    var airConditioning = true
    var rearDefrost = true
    var heatedSeats = false

    static var current: StartSettings {
        get {
            guard let data = UserDefaults.standard.data(forKey: "startSettings"),
                  let decoded = try? JSONDecoder().decode(StartSettings.self, from: data)
            else { return StartSettings() }
            return decoded
        }
        set {
            if let data = try? JSONEncoder().encode(newValue) {
                UserDefaults.standard.set(data, forKey: "startSettings")
            }
        }
    }
}

actor SubaruAPI {
    private let base = URL(string: "https://www.mysubaru.com")!
    private let session: URLSession
    private var authenticated = false

    init() {
        let config = URLSessionConfiguration.ephemeral
        // Session is cookie-based (JSESSIONID); let URLSession manage the jar.
        config.httpCookieStorage = HTTPCookieStorage()
        config.httpShouldSetCookies = true
        config.httpCookieAcceptPolicy = .always
        session = URLSession(configuration: config)
    }

    /// The g2 endpoints reject callers that don't look like the web app —
    /// x-requested-with in particular is checked.
    private func request(_ path: String, form: [String: String]?) -> URLRequest {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = form == nil ? "GET" : "POST"
        req.setValue("application/json, text/javascript, */*; q=0.01", forHTTPHeaderField: "accept")
        req.setValue("XMLHttpRequest", forHTTPHeaderField: "x-requested-with")
        req.setValue("https://www.mysubaru.com", forHTTPHeaderField: "origin")
        req.setValue("https://www.mysubaru.com/home.html", forHTTPHeaderField: "referer")
        req.setValue(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                + "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
            forHTTPHeaderField: "user-agent")
        if let form {
            req.setValue("application/x-www-form-urlencoded; charset=UTF-8", forHTTPHeaderField: "content-type")
            req.httpBody = encode(form).data(using: .utf8)
        }
        return req
    }

    private func encode(_ form: [String: String]) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return form.map { key, value in
            let k = key.addingPercentEncoding(withAllowedCharacters: allowed) ?? key
            let v = value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
            return "\(k)=\(v)"
        }.joined(separator: "&")
    }

    /// Log in and return the dashboard HTML. URLSession follows the redirect,
    /// so the response body is the dashboard itself — which is also where the
    /// vehicle details are scraped from, making this do double duty.
    @discardableResult
    func login(_ creds: Credentials) async throws -> String {
        let (data, _) = try await session.data(for: request("/login", form: [
            "username": creds.username,
            "password": creds.password,
            "lastSelectedVehicleKey": creds.vehicleKey,
            "deviceId": creds.deviceId,
        ]))
        var html = String(decoding: data, as: UTF8.self)

        // Landing anywhere other than the dashboard means we're not signed in.
        if !html.contains("currenVehicleKey") {
            let (home, _) = try await session.data(for: request("/home.html", form: nil))
            html = String(decoding: home, as: UTF8.self)
        }
        guard html.contains("currenVehicleKey") else {
            throw SubaruError(message: "Sign-in failed. Check your email and password.")
        }
        authenticated = true
        return html
    }

    private func ensureLogin(_ creds: Credentials) async throws {
        if !authenticated { try await login(creds) }
    }

    private func json(_ path: String, form: [String: String]) async throws -> [String: Any] {
        let (data, _) = try await session.data(for: request(path, form: form))
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            // An HTML body here means the session lapsed mid-command.
            authenticated = false
            throw SubaruError(message: "Lost the MySubaru session. Try again.")
        }
        return obj
    }

    /// Fire a command and poll until the car confirms it. `execute.json` only
    /// means "accepted" — the car is reached over cellular and takes ~15s.
    func run(_ command: Command, creds: Credentials, settings: StartSettings) async throws -> String {
        try await ensureLogin(creds)

        let accepted = try await json(
            "/service/g2/\(command.endpoint)/execute.json",
            form: payload(command, creds: creds, settings: settings))

        let data = accepted["data"] as? [String: Any]
        guard let requestId = (data?["serviceRequestId"] ?? accepted["serviceRequestId"]) as? String else {
            let code = (accepted["errorCode"] as? String).map { " (\($0))" } ?? ""
            throw SubaruError(message: "\(command.title) was rejected\(code). Check your PIN.")
        }

        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline {
            try await Task.sleep(nanoseconds: 2_000_000_000)
            let status = try await json("/service/g2/remoteService/status.json",
                                        form: ["serviceRequestId": requestId])
            guard let d = status["data"] as? [String: Any],
                  let state = d["remoteServiceState"] as? String
            else { continue }

            if ["finished", "cancelled", "canceled", "error", "failed"].contains(state.lowercased()) {
                guard d["success"] as? Bool == true else {
                    throw SubaruError(message: "The car reported \(command.title.lowercased()) failed (\(state)).")
                }
                return requestId
            }
        }
        throw SubaruError(message: "Timed out waiting for the car. The command may still complete.")
    }

    /// Command form bodies. Kept identical to buildCommandForm in ../src/client.ts.
    private func payload(_ command: Command, creds: Credentials, settings: StartSettings) -> [String: String] {
        var form = [
            "now": String(Int(Date().timeIntervalSince1970 * 1000)),
            "pin": creds.pin,
            "delay": "0",
            "horn": "true",
        ]
        switch command {
        case .lock, .unlock:
            form["startConfiguration"] = "ALL_DOORS_CMD"
        case .stop:
            break
        case .start:
            form["unlockDoorType"] = "ALL_DOORS_CMD"
            form["name"] = "Auto"
            form["runTimeMinutes"] = String(settings.runTimeMinutes)
            form["climateZoneFrontTemp"] = String(settings.frontTemp)
            form["climateZoneFrontAirMode"] = "AUTO"
            form["climateZoneFrontAirVolume"] = "AUTO"
            form["outerAirCirculation"] = "auto"
            form["heatedRearWindowActive"] = String(settings.rearDefrost)
            form["airConditionOn"] = String(settings.airConditioning)
            form["heatedSeatFrontLeft"] = settings.heatedSeats ? "high" : "off"
            form["heatedSeatFrontRight"] = settings.heatedSeats ? "high" : "off"
            form["startConfiguration"] = "START_ENGINE_ALLOW_KEY_IN_IGNITION"
            form["disabled"] = "false"
            form["vehicleType"] = "gas"
        }
        return form
    }

    /// Read the vehicle key, VIN and nickname out of the dashboard. MySubaru
    /// has no vehicle-list API — the data is server-rendered into the page.
    /// Mirrors parseDashboard in ../src/discover.ts.
    func discover(_ creds: Credentials) async throws -> (key: String, vin: String, name: String) {
        let html = try await login(creds)

        // Note the misspelling: `currenVehicleKey` is Subaru's, and load-bearing.
        let key = firstMatch(in: html, #"id\s*=\s*["']curren[t]?VehicleKey["']\s+value\s*=\s*["'](\d{4,12})["']"#)
        let vin = firstMatch(in: html, #"\b((?:JF|4S)[A-HJ-NPR-Z0-9]{15})\b"#)
        let name = firstMatch(in: html, #"vehicle-attention-bar__heading[^>]*>\s*([^<]{1,40}?)\s*<"#)

        guard let key else {
            throw SubaruError(message: "Signed in, but couldn't find a vehicle key on the dashboard.")
        }
        return (key, vin ?? "", name ?? "Vehicle")
    }

    private nonisolated func firstMatch(in text: String, _ pattern: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              m.numberOfRanges > 1,
              let range = Range(m.range(at: 1), in: text)
        else { return nil }
        return String(text[range])
    }
}

// MARK: - Notifications

enum Notifier {
    static func requestAuth() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    static func post(_ title: String, _ body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
}

// MARK: - Status bar

@MainActor
final class StatusBarController: NSObject, NSMenuDelegate {
    private var item: NSStatusItem!
    private let menu = NSMenu()
    private let api = SubaruAPI()

    private var credentials = Keychain.load()
    private var inFlight: Command?
    /// Last outcome, shown as a disabled line in the menu.
    private var lastResult = "Ready"
    private var settingsWindow: NSWindow?

    override init() {
        super.init()
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        menu.delegate = self
        item.menu = menu
        updateButton()
        rebuildMenu()
        Notifier.requestAuth()

        if !credentials.isComplete {
            lastResult = "Not signed in"
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.openSettings() }
        }
    }

    private func updateButton() {
        guard let button = item.button else { return }
        let symbol = inFlight == nil ? "car.fill" : "car.badge.gearshape.fill"
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Subaru")?
            .withSymbolConfiguration(.init(pointSize: 13, weight: .medium))
        // Only take up title space while something is happening.
        button.title = inFlight.map { " " + $0.progressLabel } ?? ""
        button.imagePosition = inFlight == nil ? .imageOnly : .imageLeading
    }

    private func rebuildMenu() {
        menu.removeAllItems()

        for command in Command.allCases {
            let entry = NSMenuItem(title: command.title,
                                   action: #selector(runCommand(_:)),
                                   keyEquivalent: "")
            entry.target = self
            entry.representedObject = command.rawValue
            entry.image = NSImage(systemSymbolName: command.symbol, accessibilityDescription: nil)
            entry.isEnabled = inFlight == nil && credentials.isComplete
            menu.addItem(entry)
        }

        menu.addItem(.separator())

        let status = NSMenuItem(title: lastResult, action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)

        menu.addItem(.separator())

        let settings = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        settings.target = self
        menu.addItem(settings)

        let quit = NSMenuItem(title: "Quit Subaru Bar", action: #selector(NSApp.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
    }

    func menuWillOpen(_ menu: NSMenu) {
        credentials = Keychain.load()
        rebuildMenu()
    }

    @objc private func runCommand(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let command = Command(rawValue: raw),
              inFlight == nil
        else { return }

        // Unlock is the one that turns a stolen Mac into a stolen car, so it
        // asks first. Everything else fires straight away.
        if command == .unlock && !confirmUnlock() { return }

        inFlight = command
        lastResult = command.progressLabel
        updateButton()
        rebuildMenu()

        let creds = credentials
        let settings = StartSettings.current
        let began = Date()

        Task { [weak self] in
            var outcome: String
            var failed = false
            do {
                _ = try await self?.api.run(command, creds: creds, settings: settings)
                outcome = String(format: "%@ confirmed · %.0fs", command.title, Date().timeIntervalSince(began))
            } catch {
                outcome = error.localizedDescription
                failed = true
            }
            await MainActor.run {
                guard let self else { return }
                self.inFlight = nil
                self.lastResult = outcome
                self.updateButton()
                self.rebuildMenu()
                Notifier.post(failed ? "\(command.title) failed" : "\(command.title) confirmed", outcome)
            }
        }
    }

    private func confirmUnlock() -> Bool {
        let alert = NSAlert()
        alert.messageText = "Unlock the car?"
        alert.informativeText = "This unlocks all doors immediately."
        alert.addButton(withTitle: "Unlock")
        alert.addButton(withTitle: "Cancel")
        alert.alertStyle = .warning
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }

    @objc func openSettings() {
        if let window = settingsWindow {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let view = SettingsView(api: api) { [weak self] in
            self?.credentials = Keychain.load()
            self?.lastResult = self?.credentials.isComplete == true ? "Ready" : "Not signed in"
            self?.rebuildMenu()
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 560),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Subaru Bar Settings"
        window.contentViewController = NSHostingController(rootView: view)
        window.isReleasedWhenClosed = false
        window.center()
        settingsWindow = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

// MARK: - Settings

struct SettingsView: View {
    let api: SubaruAPI
    let onSave: () -> Void

    @State private var creds = Keychain.load()
    @State private var settings = StartSettings.current
    @State private var status = ""
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("MySubaru Account").font(.headline)
            Form {
                TextField("Email", text: $creds.username)
                SecureField("Password", text: $creds.password)
                SecureField("PIN", text: $creds.pin)
            }

            HStack {
                Button(busy ? "Finding vehicle…" : "Find My Vehicle") { discover() }
                    .disabled(busy || creds.username.isEmpty || creds.password.isEmpty)
                Spacer()
            }

            Form {
                TextField("Vehicle key", text: $creds.vehicleKey)
                TextField("VIN", text: $creds.vin)
            }

            Divider()

            Text("Remote Start").font(.headline)
            Form {
                Picker("Run time", selection: $settings.runTimeMinutes) {
                    ForEach([5, 10, 15], id: \.self) { Text("\($0) min").tag($0) }
                }
                Stepper("Temperature: \(settings.frontTemp)°F", value: $settings.frontTemp, in: 60...85)
                Toggle("Air conditioning", isOn: $settings.airConditioning)
                Toggle("Rear defroster", isOn: $settings.rearDefrost)
                Toggle("Heated seats", isOn: $settings.heatedSeats)
            }

            if !status.isEmpty {
                Text(status).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }

            Spacer()

            HStack {
                Spacer()
                Button("Save") {
                    Keychain.save(creds)
                    StartSettings.current = settings
                    status = "Saved."
                    onSave()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!creds.isComplete)
            }
        }
        .padding(20)
        .frame(width: 420)
    }

    private func discover() {
        busy = true
        status = ""
        let attempt = creds
        Task {
            do {
                let found = try await api.discover(attempt)
                await MainActor.run {
                    creds.vehicleKey = found.key
                    creds.vin = found.vin
                    status = "Found \(found.name) — key \(found.key)."
                    busy = false
                }
            } catch {
                await MainActor.run {
                    status = error.localizedDescription
                    busy = false
                }
            }
        }
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    var controller: StatusBarController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        controller = StatusBarController()
    }
}

// Top-level bootstrap, so no @main. .accessory = menu bar only, no Dock icon.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
