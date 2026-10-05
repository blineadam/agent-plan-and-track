# invoice-proxy

Node HTTP service that proxies invoice lookups to the billing API; run locally with `npm run dev`.

## Logging

Log through `src/log.js`. It is a deliberately thin console wrapper (`log(message)`), recorded here as our convention, so call sites use it and it stays small.
