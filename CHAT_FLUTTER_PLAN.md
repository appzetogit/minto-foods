# Support Chat — Flutter Implementation Plan

For the three mobile apps: **user**, **delivery partner**, **restaurant**. Each talks to the
same admin support desk, which is already live in the web panel at
`/admin/food/chattings`.

Verified against `Backend/src/modules/food/chat/` and `Backend/src/config/socket.js` as of
2026-09-09. Supersedes the short chat section in
[FLUTTER_API_SPEC.md](FLUTTER_API_SPEC.md) §7c, which predates attachments, admin support
threads, assignment and unread counts.

Companion docs: [FLUTTER_API_SPEC.md](FLUTTER_API_SPEC.md),
[DELIVERY_API_SPEC.md](DELIVERY_API_SPEC.md),
[RESTAURANT_API_SPEC.md](RESTAURANT_API_SPEC.md).

---

## The one idea to hold on to

**Nobody chooses who to write to.** A conversation id is *derived* from the two parties and
an optional order:

```
buildConversationId(tokenA, tokenB, orderId)
  → `${orderId ?? 'direct'}::${[tokenA, tokenB].sort().join('|')}`
```

where a party token is `ADMIN` for any admin, or `ROLE:id` for anyone else — e.g.
`direct::ADMIN|USER:6a633945baae16d03add7500`.

The one exception: a **customer↔rider** thread is keyed on the bare `orderId` with no
`::` at all, because the client already holds the order id and looks the thread up by it.
Don't pattern-match ids expecting the `scope::tokens` form.

Three consequences the client must respect:

1. **Never invent or store a conversation id as the source of truth.** Send `peerRole` (and
   `orderId` when relevant) and let the server land the message in the right thread.
2. **A `conversationId` in a send request is advisory.** The server ignores it and returns
   the id it actually used. Compare `response.message.conversationId` against the thread on
   screen before appending — if they differ, the reply belongs elsewhere. *(This bit us in
   the web client: an optimistic append drew a message into a thread it wasn't in.)*
3. **Support threads are per order.** Chat opened from order X is a different thread from
   general support. When looking up an existing thread, match on **both** `peerToken ==
   'ADMIN'` **and** the order, or a question about one order attaches to another's thread.

Every admin shares the token `ADMIN` — support is one destination, not a person. Individual
admins are still identifiable per message via `senderName`.

---

## Global

- **Base URL:** `{HOST}/api/v1`
- **Prefix:** `/food/chat`
- **Auth:** `Authorization: Bearer <accessToken>`; roles `USER`, `RESTAURANT`,
  `DELIVERY_PARTNER`, `ADMIN`
- **Envelope:** `{ "success": true, "message": "…", "data": … }`
- **Socket:** same origin as the API, **not** `/api/v1` — `{HOST}` with path `/socket.io/`

Limits worth encoding in the client so the user learns them before the server says no:

| thing | limit |
|---|---|
| message text | 2000 chars |
| attachments per message | 5 |
| upload size | 25 MB (`MAX_UPLOAD_BYTES`) |
| image types | JPEG, PNG, WebP, GIF — re-encoded to WebP server-side |
| history page size | 1–100, default 30 |

A message needs **either** text or at least one attachment. Empty is rejected with
`"Write a message or attach an image"`.

---

## 1. REST contract

### `POST /food/chat/messages` — send

```json
{
  "text": "The order arrived cold",
  "peerRole": "ADMIN",
  "orderId": "070e0e0a0353e255f6202c74",
  "attachments": [
    { "path": "chat/1788869036019-094544df1d3b76ec.webp",
      "mimeType": "image/webp", "size": 1228, "name": "photo.jpg" }
  ]
}
```

- `peerRole` — `ADMIN` for support. On an order thread a **customer** or **rider** may omit
  it and the server pairs them with each other; a **restaurant** must always state it,
  because it has two possible counterparts (`"peerRole is required for this sender"`).
- `orderId` — the **database id** (24 hex), not `FOD-…`. Optional for support.
- `attachments` — echo back what the upload endpoint returned. Only `path` is trusted; the
  server rebuilds the url from it and drops every other field. A `../` in `path` is
  rejected.

→ `201 data.message` — see [Message shape](#message-shape).

Errors: `"Write a message or attach an image"`, `"Message is too long (max 2000 chars)"`,
`"At most 5 attachments per message"`,
`"orderId is required to chat outside of admin support"`,
`"You are not a participant of this order"`,
`"No delivery partner is assigned to this order yet"`.

### `POST /food/chat/attachments` — upload one image

`multipart/form-data`, field name **`file`**, one file per request.

→ `201 data.attachment`:
```json
{ "url": "https://…/chat/1788869036019-….webp",
  "path": "chat/1788869036019-….webp",
  "mimeType": "image/webp", "size": 1228, "name": "photo.jpg" }
```

Upload first, send after. The picture is on the server before the message exists, so a slow
upload doesn't block the composer and a failed one loses nothing but itself. Keep `path`;
`url` is regenerated per response and expires (see [Images](#5-images)).

### `GET /food/chat/conversations`

Optional `?orderId=<id>` narrows to one order's threads.

→ `data.conversations[]`, newest first — see [Conversation shape](#conversation-shape).

### `GET /food/chat/messages?conversationId=&page=&limit=`

→ `data: { messages[], pagination: { page, limit, total, totalPages } }`

Messages come back **oldest → newest**, ready to render. Reading a thread marks its
messages read as a side effect — no separate call needed on open.

### `POST /food/chat/conversations` — open a thread with a subject

```json
{ "peerToken": "ADMIN", "title": "Wrong item delivered", "orderId": "…" }
```

Idempotent: same parties → same thread. Use it when you want a `title` on the thread;
otherwise just send a message and the thread appears.

### `PATCH /food/chat/conversations/:conversationId/read`

Only needed if you show a thread without fetching history.

### `PATCH /food/chat/conversations/:conversationId/status`

`{ "status": "open" | "in_progress" | "closed" }`

### `GET /food/chat/unread-count`

→ `data: { unread: 3 }` — one number for a tab badge. Cheaper than summing conversations.

### Admin-only

`PATCH /food/chat/conversations/:conversationId/assign` with `{ "assign": true|false }`.
Not needed by the mobile apps; listed so the shapes below make sense.

---

## 2. Payload shapes

### Message shape

```json
{
  "id": "…",
  "conversationId": "direct::ADMIN|USER:6a63…",
  "orderId": null,
  "senderRole": "ADMIN",
  "senderId": "6a6326b337e4b194f018adea",
  "senderName": "Minto Foods Admin",
  "recipientRole": "USER",
  "recipientId": "6a63…",
  "text": "",
  "attachments": [ { "url": "…", "path": "…", "mimeType": "…", "size": 1228, "name": "…" } ],
  "readAt": null,
  "createdAt": "2026-09-08T17:55:12.000Z"
}
```

- `senderName` is present **only** on `senderRole == "ADMIN"`. Show it under the bubble;
  without it every admin reply reads as one anonymous voice.
- `text` may be `""` when the message is only pictures. Render the images and skip the text
  widget rather than showing an empty bubble.

### Conversation shape

```json
{
  "conversationId": "070e…::ADMIN|USER:6a63…",
  "orderId": "070e0e0a0353e255f6202c74",
  "orderNumber": "FOD-1188555469",
  "title": "Wrong item delivered",
  "peerToken": "ADMIN",
  "peer": { "role": "ADMIN", "id": "", "name": "Support", "phone": "" },
  "lastMessage": "1 photo",
  "lastAt": "2026-09-08T17:55:12.000Z",
  "unread": 2,
  "status": "open",
  "assignedAdminId": null,
  "assignedAdmin": null,
  "createdAt": "…",
  "closedAt": null
}
```

`lastMessage` already says `"1 photo"` / `"3 photos"` for image-only messages — don't
re-derive it.

---

## 3. Sockets

Connect once per signed-in session, not per screen.

```dart
final socket = IO.io(
  host,                                   // {HOST}, no /api/v1
  IO.OptionBuilder()
      .setPath('/socket.io/')
      .setTransports(['websocket', 'polling'])
      .setAuth({'token': accessToken})    // also accepted: ?token= or Authorization header
      .enableReconnection()
      .build(),
);
```

The server puts you in a room from your token — `user:<id>`, `delivery:<id>`,
`restaurant:<id>`, or `admin:all`. **There is no per-thread subscription**, so you receive
every message for your account and filter client-side by `conversationId`.

| event | direction | payload |
|---|---|---|
| `chat:message` | in | the [Message shape](#message-shape) |
| `chat:conversation_update` | in | `{ conversationId, status, title, closedAt, … }` |
| `chat:typing` | both | `{ conversationId, toRole, toId, typing }` out; `{ conversationId, fromRole, fromId, typing }` in |

Two things that bit the web client:

- **The socket echoes to your *other* devices, not the one that sent.** The sending device
  must append the message from the POST response itself.
- **De-dupe on `id`.** Reconnects can redeliver.

Offline delivery is FCM: `data.type == "chat_message"`, with `data.conversationId` and
`data.orderId`. Deep-link the notification straight to the thread.

---

## 4. Auth and token lifetime

Access tokens live **15 minutes**. The web client had a bug worth not repeating: it waited
for a 401, then refreshed and replayed — which works, but logs a failed request every
fifteen minutes and stutters the UI.

**Refresh at ~14 minutes instead**, decoding `exp` from the JWT and renewing when it is
within 60 seconds. Keep the 401 path as a fallback. Make refreshes **single-flight** — a
screen firing six calls at once otherwise sends six refreshes, five of them presenting a
refresh token the first has already rotated, which is what
`"Invalid refresh token"` in the server log is.

The socket needs the same care: on `authRefreshed`, update `socket.auth['token']` so a
reconnect after the old token expires doesn't fail.

---

## 5. Images

Uploads go to S3 and come back as **presigned urls that expire in an hour**. Therefore:

- **Persist `path`, never `url`.** A cached `url` will 403 the next day.
- Take `url` from whatever response you are currently rendering; the server re-signs on
  every response.
- The signing window is rounded to 15 minutes, so within a window the url is byte-identical
  and `CachedNetworkImage` caches normally. Key your cache on `path`, not `url`.

Compress before upload. The server accepts 25 MB and re-encodes to WebP, but a modern phone
camera JPEG over a 3G connection at a restaurant door is the actual use case.

---

## 6. Suggested structure

One shared package, three thin wrappers — the difference between the apps is which token to
send and where the entry point lives.

```
packages/minto_chat/
  lib/
    src/
      chat_api.dart          // the REST calls above
      chat_socket.dart       // connect, listen, typing, reconnect
      models/
        chat_message.dart
        chat_conversation.dart
        chat_attachment.dart
      chat_controller.dart   // thread state: history, send, upload, unread
      ui/
        support_chat_screen.dart   // full screen thread
        message_bubble.dart
        attachment_picker.dart
        image_viewer.dart
```

Each app supplies a `ChatConfig { baseUrl, tokenProvider, role }` and nothing else.

---

## 7. Phases

### Phase 1 — the package, and the user app

Models, `chat_api.dart`, `chat_socket.dart`, `chat_controller.dart`, and a working
`SupportChatScreen`. Wire into the user app in two places:

- **Help / Support screen** → "Chat with support", no `orderId`.
- **Order detail / Order help** → "Chat about this order", passing the order's **database
  id**. This opens a thread of its own, and the admin sees `FOD-…` against it.

Text only in this phase. Ship it, confirm threads appear in the admin panel under
**Customers**.

*Done when:* a customer can open support from both places, send and receive live, and the
thread shows in the panel with the right order against it.

### Phase 2 — attachments

`POST /food/chat/attachments`, a picker (camera + gallery, multi-select up to 5), thumbnail
strip in the composer with remove, image bubbles, and a full-screen viewer. Compress before
upload; show per-file progress.

*Done when:* a photo with no caption sends and renders on both ends, and the list row reads
"1 photo".

### Phase 3 — delivery partner app

Same screen, rider token. Entry point in the help menu, **above** support tickets — tickets
are right for something needing a paper trail and wrong for "I'm outside a closed restaurant
holding the customer's food", which is most of what a rider needs support for.

Riders are the strongest case for attachments: a closed shutter, a wrong address, a damaged
bag.

*Done when:* rider threads appear under **Delivery** in the panel.

### Phase 4 — restaurant app

Same screen, restaurant token, on the support/help screen above the ticket list.

*Done when:* restaurant threads appear under **Restaurants** in the panel.

### Phase 5 — polish

- Unread badge on the help/support tab from `GET /food/chat/unread-count`.
- FCM deep-link into the thread.
- Typing indicator (`chat:typing`) — cheap, since the relay already exists.
- Optimistic send with a pending state and retry on failure.
- History paging when a thread exceeds 100 messages.

---

## 8. Traps, in one list

1. Don't trust your own `conversationId` on send — compare with the response.
2. Match a support thread on peer **and** order, or threads cross.
3. `text` can be empty when there are attachments.
4. Persist attachment `path`, never `url`.
5. The socket doesn't echo to the sender — append from the POST response.
6. De-dupe messages on `id`.
7. `orderId` is the 24-hex id, not `FOD-…`.
8. Refresh the token before expiry, single-flight, and update `socket.auth`.
9. `senderName` only exists on admin messages.
10. The upload field is `file`, one per request.

---

## 9. Open decisions

- **PDFs?** Images only today. Riders photographing receipts may want PDF; it needs an
  allow-list change in `storage.service.js` and a non-image bubble.
- **Voice notes?** Not supported. Would need a new mime allow-list and a player.
- **Closed threads.** The web panel blocks replies on a closed thread. Decide whether the
  apps hide the composer or let a customer reopen by writing.
- **Restaurant↔rider chat** exists in the backend (order-scoped, no admin) but no app
  surfaces it. Out of scope here; worth knowing it is available.
