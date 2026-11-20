# Origin protection

Restrict the origin IP to Cloudflare's published ranges and private administration networks. Also require a gateway-specific secret independently on **every path**, including login, assets, validators, SSE and WebSocket handshakes. Other Cloudflare tenants share network egress and the global AOP certificate; neither identifies your Worker.

Minimal Nginx HTTPS server (render the placeholder securely, never commit the value):

```nginx
server {
    listen 443 ssl;
    server_name origin-staging.example.com;
    ssl_certificate /etc/tls/fullchain.pem;
    ssl_certificate_key /etc/tls/privkey.pem;
    if ($http_x_cf_auth_gateway_secret != "REPLACE_WITH_RANDOM_SECRET") { return 403; }
    client_max_body_size 64m;
    location / {
        proxy_pass http://private-app:3080;
        proxy_http_version 1.1;
        proxy_set_header Host chat-staging.example.com;
        proxy_set_header X-Forwarded-Host chat-staging.example.com;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $http_x_forwarded_for;
        proxy_set_header X-Real-IP $http_x_forwarded_for;
        proxy_set_header X-CF-Auth-Gateway-Secret "";
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $http_connection;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

Trust forwarded IPs only after the secret check. Configure the app's proxy trust to the actual hop count; adding another Cloudflare/NPM hop can otherwise collapse backend rate limits onto proxy IPs. For Nginx Proxy Manager, check the generated location: its standard include appends its peer address and overrides headers. Set explicit headers in that location rather than adding duplicate server-level directives.

Keep origin TLS verification enabled. A DNS-only origin lets the Worker verify the server certificate directly. A proxied origin adds a second TLS hop: use **Full (strict)** on Cloudflare-to-origin too, scoped to staging if changing a live zone would affect production. Use a valid certificate matching origin SNI. The Worker sets Host/SNI from its fixed HTTPS destination and does not accept a client-selected origin. Do not place a gateway Worker route on the origin hostname or create redirect loops.

Test with no secret, a wrong secret and spoofed forwarding headers: direct origin login, assets and protected API must return 403; public gateway login must work. Repeat through another Cloudflare route/proxied hostname and with a forged Host to the extent Cloudflare permits it. A request from a Cloudflare source must still fail without the secret. Verify raw app ports and alternate virtual hosts cannot expose the same backend.

With trusted administrator access, confirm correct-secret origin access works, but never put the secret in shell arguments/history, screenshots or CI artifacts. In origin access logs, use a unique harmless query marker to show an unauthenticated protected gateway request produced **no** origin entry, while an authenticated request did. Log method/path/status only; avoid Authorization, Cookie, bodies and sensitive callback query strings.
