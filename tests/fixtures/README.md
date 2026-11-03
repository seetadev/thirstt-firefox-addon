# Test double: NOT the real Thirstt API

Everything in this directory is **synthetic test data** written for this repository. It is not a recording
of, and makes no claim to match byte-for-byte, the real Thirstt backend (which was unreachable when this
add-on was rebuilt; the owner is being asked for the real API). It follows the request/response shape that
the original add-on code used:

* `GET  /mediaservice/fetchExtract?url=<page url>` -> JSON array whose first element has `title` and `content`
  (HTML). Without a logged-in session the original treated a reply that is not that JSON as "please log in".
* `POST /login` with `{"email", "password", "isJson": 1}` -> 200 on success (sets a session cookie), otherwise 401.

When the real API (or a recorded sample) is available, replace these fixtures and update `mock-server.mjs`.
`test-user@example.invalid` / `test-password-not-real` are fake credentials that only this mock accepts.
