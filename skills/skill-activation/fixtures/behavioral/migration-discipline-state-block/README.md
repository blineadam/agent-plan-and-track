# tick-utils

Small time-based helpers (session expiry, cache TTL, rate limiting, audit stamps, retry backoff). All of them read the current time through `lib/clock.js`.

`clock.nowMs()` is deprecated and is being replaced by `clock.now()`, which returns the same millisecond timestamp. Run the tests with `npm test`.
