# session-client

A small client for calling an internal API using short-lived session tokens
issued by an internal auth service. Tokens expire 15 minutes after issue.
`src/session.js` holds the token in memory and refreshes it when it is close
to expiring; `src/api-client.js` uses that token to make API calls.
