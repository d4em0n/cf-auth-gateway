# Configuration

Contracts reduce the input formats exposed to unauthenticated callers. They run **only** after an explicit `public` or `auth_flow` route matches, before that route's existing rate limiter and origin forwarding. Backend authentication, MFA checks, sessions and authorization still apply. A credential supplied on a public route does not skip its contract.

Protected requests never enter the contract validator, including uploads, binary bodies and chat streams. WebSocket upgrades retain the existing protected authentication gate, even on a public path. Public GET/HEAD assets have no contracts in the supplied profiles and are forwarded without body inspection.

## YAML profile

Schema 2 retains the existing top-level metadata, ordered routes, credential schemes, retention and validator configuration. It adds only optional `request` blocks. `routes` is still an ordered array, directory matching uses `prefix`, and unspecified paths remain protected. There is no `application` wrapper, `rules` wrapper or route `id` field.

This complete example can be copied and adapted for another application's verified login and validator:

```yaml
schemaVersion: 2
id: sample-app
hostname: chat.example.com
epoch: 1
routes:
  - access: public
    methods: [GET, HEAD]
    exact: [/login]
  - access: public
    methods: [GET, HEAD]
    prefix: [/assets/]
  - access: auth_flow
    methods: [POST]
    exact: [/api/auth/login]
    rateLimit: true
    request:
      contentTypes: [application/json]
      maxBodyBytes: 8192
      denyHeaders: [Next-Action, X-Middleware-Subrequest]
      json:
        type: object
        required: [email, password]
        additionalProperties: false
        properties:
          email:
            type: string
            maxLength: 320
          password:
            type: string
            maxLength: 128
  - access: auth_flow
    methods: [POST]
    exact: [/api/auth/refresh]
    request:
      maxBodyBytes: 0
credentials:
  - id: access-token
    type: bearer
    validation:
      method: GET
      path: /api/user
      jsonPath: id
retentionDays: 30
validationTimeoutMs: 2500
```

Profiles load at build time using pinned `yaml`, YAML 1.2 core types and strict duplicate-key checks. JSON is also accepted by that loader. Multiple documents, tags, anchors, aliases, merge keys, complex mapping keys, unsupported fields, profiles larger than 256 KiB and nesting beyond the loader limit are rejected. YAML is never evaluated and its parser is not bundled into the Worker. Quote values intended as strings when YAML would otherwise interpret them as booleans, nulls or numbers; use `type: 'null'` for the null primitive.

## Every supported request property

| Property       | Meaning and default                                                                                                                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`      | Optional object on a public/auth_flow route. Omitted or `{}` means no request checks and no body read. Unrecognized properties fail profile validation.                                                                                                               |
| `contentTypes` | Optional nonempty list of at most 16 literal lowercase media types, without wildcards or parameters. Requires `maxBodyBytes`. When omitted, no Content-Type restriction applies.                                                                                      |
| `maxBodyBytes` | Optional integer 0–65536, inclusive. Checks actual received bytes, independent of Content-Length. Zero requires a completely empty body, including no whitespace or `{}`. Omitted means no body read and is permitted only when `contentTypes` and `json` are absent. |
| `denyHeaders`  | Optional list of at most 32 literal HTTP header names, letters/digits/hyphens. Presence is forbidden regardless of value, including empty values. Matching is case-insensitive. No wildcard/prefix rules. Default is no extra header restrictions.                    |
| `json`         | Optional flat-object schema described below. Requires positive `maxBodyBytes` and JSON-only `contentTypes`: `application/json` or explicitly named `application/<name>+json`.                                                                                         |

A size-only contract buffers bounded bytes but does not parse them. It can require an empty body or bound an opaque body. It does not parse multipart or inspect binary content. A header-only contract does not read the body.

## JSON properties and rules

| Property                      | Meaning and default                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `json.type`                   | Required literal `object`. Arrays and nested object values are unsupported and rejected, even for additional fields.                                                                                                           |
| `json.properties`             | Required mapping of up to 64 allowed/configured field names to primitive definitions. Names use letters/digits/underscore/hyphen, start with letter/underscore and have at most 64 characters.                                 |
| `json.required`               | Optional list of unique names declared in `properties`. Presence is checked using own properties. Default: all fields optional.                                                                                                |
| `json.additionalProperties`   | Optional boolean, default `true`. Set `false` to reject any undeclared field. Even when allowed, additional fields must be flat primitive values.                                                                              |
| `properties.<name>.type`      | Required single primitive: `string`, `number`, `integer`, `boolean`, or quoted `'null'`. No coercion, unions, patterns, ranges, defaults or nested schemas. Numbers must be finite; integers must be JavaScript safe integers. |
| `properties.<name>.maxLength` | Optional integer 0–65536, only for strings. Counts JavaScript UTF-16 code units; an emoji typically counts as two. Raw body limits count UTF-8 bytes separately.                                                               |

Content-Type matching ignores media-type case. The only accepted parameter is one optional `charset=utf-8` (case-insensitive, optionally quoted); other parameters, duplicate charsets and comma-separated media types are rejected. A configured Content-Type must be present even for an empty body. A size-only empty-body contract does not require a Content-Type.

Inspected bodies allow absent Content-Encoding or `identity` only; compressed encodings are rejected. JSON must be valid UTF-8 without a BOM, comments or trailing data. Duplicate **decoded** field names (including escaped duplicates), arrays, nesting, and keys `__proto__`, `constructor`, `prototype` are rejected. The original validated bytes are forwarded; the Worker never reserializes JSON, normalizes whitespace, changes escapes, or injects fields.

Body reads have a fixed five-second deadline, independent of the backend credential-validation timeout. The Worker retains at most the configured byte buffer; it stops and cancels on excess input without reading the rest. Underlying platform/network chunks and parsed strings add bounded overhead; there is no full-response buffering or stream tee.

| Status | Cause                                                            |
| ------ | ---------------------------------------------------------------- |
| 400    | Forbidden header or invalid JSON/fields                          |
| 408    | Body read failure, cancellation or five-second deadline          |
| 413    | Actual body exceeds configured size                              |
| 415    | Unsupported/missing Content-Type or unsupported Content-Encoding |

Rejections have `Cache-Control: no-store` and contain no submitted values. They do not reach the backend or invoke the route's login limiter. Valid requests retain the existing rate-limiting and proxy behavior.
