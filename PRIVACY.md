# Privacy

Usage Deck collects nothing.

- **No accounts, no analytics, no tracking, no ads.** The app has no server of its own.
- **It talks only to your own devices.** The iPhone app connects to the `claude-usage` daemons
  you pair it with — on your local network, or over your own VPN — and to nothing else. It
  never contacts Anthropic. The Apple Watch app talks only to your iPhone.
- **What stays on your iPhone:** the list of paired devices, your settings, and each device's
  access token, which is kept in the iPhone Keychain (this device only; not synced to iCloud,
  not shared with the watch, widgets or any other app).
- **What reaches your watch and widgets:** usage percentages, reset times, project and session
  names and token counts — the same numbers the iPhone shows. Never the access token.
- **Camera:** used only to scan a pairing QR code when you choose to; no image is stored.
- **Local network:** used only to reach the devices you pair.

**TestFlight:** while you test a TestFlight build, Apple's TestFlight service may share crash
reports and basic usage information (such as sessions and device model) with the developer,
under Apple's own privacy policy. That data is collected by Apple, not by this app, and you can
turn it off in TestFlight's settings.

Questions: open an issue at <https://github.com/drmuzikbpn/claude-utilization-mcp>.
