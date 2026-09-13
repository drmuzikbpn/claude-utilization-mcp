# Limits fixtures

`live-YYYY-MM-DD.json` — verbatim response of `GET https://api.anthropic.com/api/oauth/usage`
(headers: `Authorization: Bearer <claudeAiOauth.accessToken>`, `anthropic-beta: oauth-2025-04-20`),
captured from a real Max account. Contains no credentials; timestamps are real.

Credentials JSON shape (`claudeAiOauth`): `accessToken`, `refreshToken`, `expiresAt` (ms epoch),
`refreshTokenExpiresAt`, `scopes[]`, `subscriptionType`, `rateLimitTier`.
