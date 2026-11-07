# Connection modes and phone testing

Microphone and camera APIs require a secure browser context. A phone opening `http://192.168.x.x` is not using localhost, so plain LAN HTTP is insufficient. Direct local access uses Caddy's local certificate authority. Access through code-server instead uses code-server's existing external HTTPS connection.

## Access through code-server

For a public browser address such as `https://code.example.org/proxy/8443/`, start:

```sh
docker compose --env-file .env.local -f compose.yaml -f compose.codeserver.yaml up -d --build
```

For development with hot reload, include all three files in this order:

```sh
docker compose --env-file .env.local -f compose.yaml -f compose.dev.yaml -f compose.codeserver.yaml up --build
```

The browser connects to code-server over HTTPS. Code-server strips `/proxy/8443` and forwards the request over HTTP to Mirror's loopback entry point. Mirror restores the prefix before forwarding to the application, whose routes, JavaScript, CSS, API calls, and VAD assets are built for that base path.

No local root certificate needs to be installed on devices using this HTTPS address. Authenticate through the existing access gateway before opening Mirror. These instructions do not change or bypass the gateway's authentication.

The relevant `.env.local` settings are:

```dotenv
CODE_SERVER_BASE_PATH=/proxy/8443
CODE_SERVER_PORT=8443
```

Keep the path and port aligned. `HTTPS_PORT`, `APP_HOST`, and `BIND_ADDRESS` configure the default direct-access mode; the code-server override uses its own HTTP port and keeps publication restricted to loopback. Do not change the browser address to plain HTTP. The externally trusted HTTPS connection is what lets the browser use camera and microphone APIs.

The override sets the build-time `NEXT_PUBLIC_BASE_PATH`. After changing the path, rebuild with the same Compose command. The default internal application health URL becomes `http://app:3000/proxy/8443/api/health`; unprefixed application routes are not the health target for this build.

Use the normal Compose command without the code-server override, including `--build`, to return to direct local HTTPS. The default local certificate setup below remains available.

## Desktop

1. Keep `APP_HOST=localhost`, `HTTPS_PORT=8443`, and `BIND_ADDRESS=127.0.0.1` in `.env.local`.
2. Start the stack with `docker compose --env-file .env.local up -d --build`.
3. Create an `artifacts` directory on the host, then export the **public root certificate**:

```sh
docker compose --env-file .env.local cp caddy:/data/caddy/pki/authorities/local/root.crt ./artifacts/mirror-root.crt
```

4. Import that certificate into the browser or operating system's trusted root certificate store. The exact dialog varies by platform. Restart the browser if necessary.
5. Open `https://localhost:8443` and verify the connection is trusted before starting Mirror.

Export only `root.crt`. Keep the certificate authority's private key inside the Docker volume. Clicking past a certificate warning is not a substitute for establishing a trusted secure context.

## iPhone or Android on the same network

Set the host computer's LAN IP address in `.env.local`, for example:

```dotenv
APP_HOST=192.168.1.50
BIND_ADDRESS=0.0.0.0
HTTPS_PORT=8443
```

Restart the stack with the same Compose files used to start it. Allow inbound TCP port 8443 through the host firewall. The phone must be able to reach the host on the local network.

Export `root.crt` using the command above and transfer that public certificate to the test phone. On iOS, install the downloaded certificate profile, then enable full trust for that root under **Settings → General → About → Certificate Trust Settings**. Android's certificate installation location varies by manufacturer; install it as a trusted CA certificate for the testing device. Device management policies may restrict custom certificates.

Open `https://192.168.1.50:8443` in Safari on iPhone or Chrome on Android. Use the IP configured in `APP_HOST`, not `localhost`. Confirm that the browser shows a trusted connection and grant both camera and microphone access.

Certificate trust is a test-device setup step. A public deployment would use a public hostname and publicly trusted certificates instead. This repository's default configuration remains local.

## Troubleshooting

- **"Client sent an HTTP request to an HTTPS server" through code-server:** use `compose.codeserver.yaml`; the default HTTPS listener cannot accept code-server's plain HTTP upstream request.
- **Page loads through code-server but scripts, API calls, or the voice listener fail:** verify `CODE_SERVER_BASE_PATH` matches the public `/proxy/<port>` path, rebuild, and check that JS/CSS and `/vad/` requests retain that prefix.
- **An access-gateway login page appears:** sign in through the gateway in the browser. The app cannot validate that authenticated external path from an unauthenticated environment.
- **Connection refused:** verify `BIND_ADDRESS=0.0.0.0`, the LAN IP, firewall access, and that Caddy is running.
- **Certificate mismatch:** the URL's hostname/IP must equal `APP_HOST`; restart Caddy after changing it.
- **Camera or microphone denied:** verify HTTPS trust, then reset the site's camera/microphone permission and retry.
- **Hot reload does not connect:** use the HTTPS address through Caddy, keep the development override active, and check `app` logs.
- **A previously trusted certificate stops working:** deleting the `caddy_data` volume creates a new certificate authority. Export and trust its new root certificate.

All application and proxy processes run in Docker. Browser permission prompts, device certificate trust, and real screen-reader testing happen on the device using the website.
