package com.evenseal.usagedeck.pairing

import com.evenseal.usagedeck.core.pairing.PairingInvite

/**
 * What a pairing QR or sideloaded file holds. The v2 link from `claude-usage pair` is the
 * preferred path; the v1 JSON from `claude-usage configure pairing` still works as a fallback.
 */
sealed interface ScannedPairing {
    /** The machine name the QR carries, before anything is redeemed. */
    val name: String

    /** v1: a live bearer for plain HTTP, ready to store as is. */
    data class Legacy(val payload: PairingPayload) : ScannedPairing {
        override val name: String get() = payload.name
    }

    /** v2: a one-time code that must be redeemed over pinned HTTPS ([InvitePairing]). */
    data class Invite(val invite: PairingInvite) : ScannedPairing {
        override val name: String get() = invite.name
    }

    companion object {
        /** Every failure carries a message the pairing screen shows verbatim. */
        fun parse(text: String): Result<ScannedPairing> = if (PairingInvite.isLink(text)) {
            PairingInvite.parse(text).map(::Invite)
        } else {
            PairingPayload.parse(text).map(::Legacy)
        }
    }
}
