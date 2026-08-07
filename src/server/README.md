# server/

Server-only logic: request handling helpers, and in later approved stages
sessions, permission checks, and other server-side concerns.

Currently contains the health-check logic backing `/api/health`.
Nothing in this directory may be imported from client-only code.
