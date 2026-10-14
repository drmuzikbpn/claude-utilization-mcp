// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation

/// Reads an HTTP response without trusting the device about how much it will send: the body is
/// taken byte by byte and given up on at a cap, instead of being buffered whole.
enum BoundedBody {
    /// An error envelope is a few hundred bytes; anything past this is not one.
    static let errorLimit = 64 * 1024

    static let tooLarge = DaemonError(code: "bad_response", message: "The device sent more data than this app accepts.")

    /// The response and its body. A 2xx body over `limit` throws `tooLarge` (final: another
    /// address would only send the same thing). Any other status keeps at most `errorLimit`
    /// bytes, so an oversized error still reports its status.
    static func data(_ session: URLSession, for request: URLRequest, limit: Int) async throws -> (Data, HTTPURLResponse) {
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw DaemonError.network }
        let ok = (200 ..< 300).contains(http.statusCode)
        if ok, http.expectedContentLength > Int64(limit) {
            throw tooLarge
        }
        let cap = ok ? limit : errorLimit
        var body = Data()
        for try await byte in bytes {
            if body.count >= cap {
                if ok {
                    throw tooLarge
                }
                break
            }
            body.append(byte)
        }
        return (body, http)
    }
}
