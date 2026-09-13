package com.evenseal.usagedeck.alerts

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlin.math.PI
import kotlin.math.sin

/**
 * A short, soft two-note chime synthesised on the fly, so the alert sound needs no asset and never
 * sounds like a phone ringing across the room. Rising fifth (E5 → B5), ~0.3 s, with a gentle decay.
 */
object Chime {
    private const val SAMPLE_RATE = 44_100
    private const val NOTE_SECONDS = 0.16
    private const val GAIN = 0.28

    private val NOTES = doubleArrayOf(659.25, 987.77)

    /** Renders the chime to 16-bit PCM. Pure, so the shape can be tested without an AudioTrack. */
    fun pcm(): ShortArray {
        val perNote = (SAMPLE_RATE * NOTE_SECONDS).toInt()
        val out = ShortArray(perNote * NOTES.size)
        NOTES.forEachIndexed { n, hz ->
            for (i in 0 until perNote) {
                val t = i.toDouble() / SAMPLE_RATE
                val attack = (i / (SAMPLE_RATE * 0.01)).coerceAtMost(1.0)
                val decay = 1.0 - (i.toDouble() / perNote)
                val sample = sin(2 * PI * hz * t) * GAIN * attack * decay * decay
                out[n * perNote + i] = (sample * Short.MAX_VALUE).toInt().toShort()
            }
        }
        return out
    }

    fun play() {
        val data = pcm()
        runCatching {
            val track = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(SAMPLE_RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build()
                )
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(data.size * 2)
                .build()
            track.write(data, 0, data.size)
            track.setNotificationMarkerPosition(data.size)
            track.setPlaybackPositionUpdateListener(
                object : AudioTrack.OnPlaybackPositionUpdateListener {
                    override fun onMarkerReached(t: AudioTrack) = t.release()

                    override fun onPeriodicNotification(t: AudioTrack) = Unit
                }
            )
            track.play()
        }
    }
}
