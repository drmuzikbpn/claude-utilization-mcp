import Foundation
import Testing
@testable import UsageCore

struct EventStreamTests {
    let host = uniqueHost("sse")

    func stream(addrs: [String]? = nil) -> EventStream {
        let config = DeviceConfig(record: record(addrs: addrs ?? [host]), token: "tok")
        return EventStream(config: config, session: StubURLProtocol.session(), endpoints: Endpoints(record: config.record))
    }

    func collect(_ s: EventStream) async -> [StreamItem] {
        var items: [StreamItem] = []
        for await item in s.connect() {
            items.append(item)
        }
        return items
    }

    @Test func emitsOpenThenParsedEventsThenClosed() async throws {
        let body = "id: 1\nevent: snapshot\ndata: {\"summary\":{},\"sessions\":[],\"rules\":[],\"rev\":1}\n\nevent: heartbeat\ndata: {}\n\n"
        StubURLProtocol.register(host: host) { _ in
            .respond(.init(headers: ["Content-Type": "text/event-stream"], body: Data(body.utf8)))
        }
        let items = await collect(stream())
        #expect(items.count == 4)
        #expect(items.first == .open)
        if case let .event(.snapshot(s)) = items[1] {
            #expect(s.rev == 1)
        } else {
            Issue.record("no snapshot")
        }
        #expect(items[2] == .event(.emptyHeartbeat))
        #expect(items.last == .closed(nil))
        let request = try #require(StubURLProtocol.recorded(host: host).first)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
        #expect(request.value(forHTTPHeaderField: "Accept") == "text/event-stream")
        #expect(request.url?.path() == "/v1/events")
    }

    @Test func theRecordedTranscriptStreamsInOrder() async {
        StubURLProtocol.register(host: host) { _ in .respond(.init(body: Fixtures.data("stream.sse"))) }
        let items = await collect(stream())
        #expect(items.count == 8, "open, six events, closed")
        #expect(items.first == .open)
        #expect(items.last == .closed(nil))
    }

    @Test func unauthorizedClosesWithTheEnvelope() async {
        StubURLProtocol.register(host: host) { _ in
            .respond(.init(status: 401, body: Fixtures.errorBody("unauthorized")))
        }
        let items = await collect(stream())
        #expect(!items.contains(.open))
        guard case let .closed(error?) = items.last else { Issue.record("no error"); return }
        #expect(error.code == "unauthorized")
    }

    @Test func tooManyClientsClosesWithTheUnavailableEnvelope() async {
        StubURLProtocol.register(host: host) { _ in
            .respond(.init(status: 503, body: Data(#"{"error":{"code":"unavailable","message":"Too many event stream clients"}}"#.utf8)))
        }
        guard case let .closed(error?) = await collect(stream()).last else { Issue.record("no error"); return }
        #expect(error.code == "unavailable")
        #expect(error.userMessage == "Too many event stream clients")
    }

    @Test func connectionRefusedClosesWithANetworkError() async {
        let items = await collect(stream(addrs: [uniqueHost("dead")]))
        #expect(items == [.closed(.network)])
    }
}
