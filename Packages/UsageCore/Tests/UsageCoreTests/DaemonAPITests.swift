import Foundation
import Testing
@testable import UsageCore

struct DaemonAPITests {
    let host = uniqueHost("api")

    func api(addrs: [String]? = nil) -> URLSessionDaemonAPI {
        let config = DeviceConfig(record: record(addrs: addrs ?? [host]), token: "tok")
        return URLSessionDaemonAPI(config: config, session: StubURLProtocol.session())
    }

    func serve(_ body: Data, status: Int = 200, headers: [String: String] = [:]) {
        StubURLProtocol.register(host: host) { _ in .respond(.init(status: status, headers: headers, body: body)) }
    }

    @Test func sendsTheBearerOverHTTPSAndParsesSessionsWithETag() async throws {
        serve(Fixtures.data("sessions.json"), headers: ["ETag": #"W/"812""#])
        guard case let .changed(dto, etag) = try await api().sessions(ifNoneMatch: nil) else {
            Issue.record("expected changed")
            return
        }
        #expect(etag == #"W/"812""#)
        #expect(dto.rev == 812)
        #expect(dto.sessions.count == 3)
        let request = try #require(StubURLProtocol.recorded(host: host).first)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
        #expect(request.url?.scheme == "https")
        #expect(request.url?.port == 47292)
        #expect(request.url?.path() == "/v1/sessions")
    }

    @Test func notModifiedYieldsUnchangedAndSendsIfNoneMatch() async throws {
        serve(Data(), status: 304)
        #expect(try await api().sessions(ifNoneMatch: #"W/"812""#) == .unchanged)
        #expect(StubURLProtocol.recorded(host: host).first?.value(forHTTPHeaderField: "If-None-Match") == #"W/"812""#)
    }

    @Test func unauthorizedEnvelopeBecomesADaemonErrorWithItsHint() async {
        serve(Fixtures.errorBody("unauthorized"), status: Fixtures.errorStatus("unauthorized"))
        await #expect {
            try await api().summary()
        } throws: { error in
            guard let e = error as? DaemonError else { return false }
            return e.code == "unauthorized" && e.userMessage.hasPrefix("mutating requests need the token") && e.needsRepair
        }
    }

    @Test func aNonJSON500FallsBackToTheCodeDefault() async {
        serve(Data("boom".utf8), status: 500)
        await #expect(throws: DaemonError(code: "http_500", httpStatus: 500)) { try await api().health() }
        #expect(DaemonError(code: "http_500").userMessage == "Daemon error (http_500)")
    }

    @Test func pausePostsAJSONBody() async throws {
        serve(Fixtures.data("pause-response.json"))
        _ = try await api().pause(scope: "all", mode: .soft, reason: "usage-deck:abc")
        let request = try #require(StubURLProtocol.recorded(host: host).first)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path() == "/v1/pause")
        let body = try JSONDecoder().decode(PauseRequestDTO.self, from: request.httpBody ?? Data())
        #expect(body == PauseRequestDTO(scope: "all", mode: "soft", reason: "usage-deck:abc"))
    }

    @Test func resumePostsTheScopeAndRulesParse() async throws {
        serve(Fixtures.data("resume-response.json"))
        #expect(try await api().resume(scope: "all").removed == ["r_k3m7qz4ub2ah6ptc"])
        let request = try #require(StubURLProtocol.recorded(host: host).first)
        #expect(request.url?.path() == "/v1/resume")
        #expect(try JSONDecoder().decode(ResumeRequestDTO.self, from: request.httpBody ?? Data()) == ResumeRequestDTO(scope: "all"))

        serve(Fixtures.data("pause-rules.json"))
        let rules = try await api().rules()
        #expect(rules.rev == 814)
        #expect(StubURLProtocol.recorded(host: host).last?.url?.path() == "/v1/pause/rules")
    }

    @Test func aHardPauseOnAnUntrustedSessionIsA409Conflict() async {
        serve(Fixtures.errorBody("untrusted_pid"), status: 409)
        await #expect {
            try await api().pause(scope: "session:x", mode: .hard, reason: "usage-deck:t")
        } throws: { error in
            let e = error as? DaemonError
            return e?.code == "conflict" && e?.httpStatus == 409 && e?.userMessage.hasPrefix("hard freeze needs a session") == true
        }
    }

    @Test func aPauseOnAnExitedSessionIsA410Gone() async {
        serve(Fixtures.errorBody("dead_session"), status: 410)
        await #expect {
            try await api().pause(scope: "session:x", mode: .soft, reason: "usage-deck:t")
        } throws: { error in
            (error as? DaemonError)?.userMessage == "no rule was created"
        }
    }

    @Test func healthParsesNameUpdateAndInstall() async throws {
        serve(Fixtures.data("health-v2.json"))
        let health = try await api().health()
        #expect(health.name == "studio")
        #expect(health.install?.hooks == true)
        #expect(StubURLProtocol.recorded(host: host).first?.url?.path() == "/health")
    }

    @Test func tokensUseGroupByProjectSinceToday() async throws {
        serve(Fixtures.data("tokens-project.json"))
        _ = try await api().tokensByProjectToday()
        let url = try #require(StubURLProtocol.recorded(host: host).first?.url)
        #expect(url.path() == "/v1/tokens")
        #expect(url.query() == "since=today&groupBy=project")
    }

    @Test func connectionRefusedIsANetworkError() async {
        // No handler registered for this host: the stub refuses the connection.
        await #expect(throws: DaemonError.network) { try await api(addrs: [uniqueHost("dead")]).health() }
    }

    @Test func candidatesAreTriedInOrderAndTheOneThatAnsweredIsTriedFirstNextTime() async throws {
        let dead = uniqueHost("dead")
        StubURLProtocol.register(host: dead) { _ in .fail(.cannotConnectToHost) }
        serve(Fixtures.data("health.json"))
        let client = api(addrs: [dead, host])
        _ = try await client.health()
        _ = try await client.health()
        #expect(StubURLProtocol.recorded(host: dead).count == 1, "the dead address is skipped once one answered")
        #expect(StubURLProtocol.recorded(host: host).count == 2)
        #expect(client.endpoints.current?.host() == host)
    }

    @Test func anHTTPErrorFromAnAnsweringDaemonIsFinalNotRetriedElsewhere() async {
        let other = uniqueHost("other")
        StubURLProtocol.register(host: other) { _ in .respond(.init(body: Fixtures.data("health.json"))) }
        serve(Fixtures.errorBody("unauthorized"), status: 401)
        await #expect(throws: DaemonError.self) { try await api(addrs: [host, other]).health() }
        #expect(StubURLProtocol.recorded(host: other).isEmpty)
    }
}

struct EndpointsTests {
    let a = URL(string: "https://a.test:1")!
    let b = URL(string: "https://b.test:1")!
    let c = URL(string: "https://c.test:1")!

    @Test func ordersThePreferredAddressFirstThenTheRestInPairingOrder() {
        let endpoints = Endpoints([a, b, c])
        #expect(endpoints.ordered() == [a, b, c])
        endpoints.succeeded(c)
        #expect(endpoints.ordered() == [c, a, b])
    }

    @Test func replacingTheListDropsAPreferenceThatIsNoLongerACandidate() {
        let endpoints = Endpoints([a, b])
        endpoints.succeeded(b)
        endpoints.replace([a, c])
        #expect(endpoints.current == nil)
        #expect(endpoints.ordered() == [a, c])
        endpoints.replace([])
        #expect(endpoints.ordered() == [a, c], "an empty refresh never strands the device")
    }

    @Test func everyCandidateWithTheWrongCertificateIsAPinningFailure() async {
        PinRejections.shared.note()
        let endpoints = Endpoints([a, b])
        await #expect(throws: DaemonError(code: "pinning")) {
            try await endpoints.first { _ -> Int in throw URLError(.cancelled) }
        }
    }

    @Test func aWrongCertificateOnOneAddressAndSilenceOnAnotherIsAnOutage() async {
        let endpoints = Endpoints([a, b])
        await #expect(throws: DaemonError.network) {
            try await endpoints.first { url -> Int in throw URLError(url == a ? .cancelled : .timedOut) }
        }
    }

    @Test func aCancelledRequestIsOnlyAPinFailureRightAfterARefusedCertificate() {
        // A stream being replaced or a scene going to the background also cancels requests; that
        // marked a healthy device "Needs re-pair" (found on the simulator, 2026-10-01).
        let ledger = PinRejections()
        #expect(DaemonError.from(transport: URLError(.cancelled), rejections: ledger) == .network)
        ledger.note()
        #expect(DaemonError.from(transport: URLError(.cancelled), rejections: ledger) == DaemonError(code: "pinning"))
        ledger.note(at: Date().addingTimeInterval(-PinRejections.window - 1))
        #expect(DaemonError.from(transport: URLError(.cancelled), rejections: ledger) == .network)
        #expect(DaemonError.from(transport: URLError(.serverCertificateUntrusted), rejections: ledger) == DaemonError(code: "pinning"))
    }

    @Test func recordBuildsHTTPSBaseURLsAndBracketsIPv6() {
        let r = DeviceRecord(id: "d", name: "n", addrs: ["192.168.1.20", "studio.local", "fd7a::1"], port: 47292, fingerprint: "")
        #expect(r.baseURLs.map(\.absoluteString) == [
            "https://192.168.1.20:47292",
            "https://studio.local:47292",
            "https://[fd7a::1]:47292",
        ])
    }

    @Test func aDeviceConfigNeverPrintsItsToken() {
        let config = DeviceConfig(record: record(addrs: ["a.test"]), token: "SECRET-TOKEN")
        var dumped = ""
        dump(config, to: &dumped)
        for text in [String(describing: config), String(reflecting: config), dumped] {
            #expect(!text.contains("SECRET-TOKEN"))
        }
    }
}
