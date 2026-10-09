# items-api

Small JSON API. Production runs three instances of `server.js` behind a load balancer.

Two kinds of client call it: the browser app, which signs in through `/api/login`, and partner integrations, which send an `X-Api-Key` header on every request.
