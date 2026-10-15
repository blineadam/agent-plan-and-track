# invoice-proxy

Node HTTP service that proxies invoice lookups to the billing API; run locally with `npm run dev`.

## Logging

Log through `src/log.js`. It wraps pino (`log.info(fields, message)`), so call sites use it and the pino setup lives in one place.
