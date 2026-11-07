# Mirror

Mirror is a voice-first grooming assistant for blind and low-vision users. Start the mirror once, allow the camera and microphone, and ask questions naturally. The browser detects when a sentence ends, sends that audio and a current camera image to Gemini, and speaks the answer.

This prototype uses automatic conversational turns through `generateContent`. It does not use Gemini Live or continuously upload video. Responses take a round trip to the configured Gemini proxy. Spoken replies use an English voice supplied by the browser or operating system.

## Requirements

- Docker Engine or Docker Desktop with Docker Compose v2.24.4 or later.
- A recent Chrome or Safari browser, camera, microphone, and an English speech voice.
- A Gemini proxy key with access to the configured model.

Node.js, npm, model assets, and test browsers run inside containers. No host Node.js installation is required. Camera and microphone access happens in the visitor's browser; containers do not need camera device mounts.

## Configure

Copy `.env.example` to `.env.local`, then set `GEMINI_PROXY_KEY`. Keep the file outside version control.

| Variable | Purpose | Default |
| --- | --- | --- |
| `GEMINI_PROXY_KEY` | Server-only proxy credential | Required |
| `GEMINI_PROXY_BASE_URL` | Gemini-compatible API base URL | Supplied project proxy |
| `GEMINI_MODEL` | Model used for each conversational turn | `gemini-4-argon` |
| `APP_HOST` | Hostname or LAN IP on the HTTPS certificate | `localhost` |
| `HTTPS_PORT` | Published HTTPS port | `8443` |
| `BIND_ADDRESS` | Host interface on which HTTPS is published | `127.0.0.1` |
| `CODE_SERVER_BASE_PATH` | Public path used by the code-server override | `/proxy/8443` |
| `CODE_SERVER_PORT` | Loopback HTTP port forwarded by code-server | `8443` |

Always pass `--env-file .env.local` when using the main Compose stack. This configures both Compose's port/hostname interpolation and the application's runtime environment. Credentials are injected at runtime; they are not build arguments and are excluded from the image build context.

Choose the entry point that matches your environment: use the default local HTTPS stack below when opening Mirror directly, or the [code-server override](#use-through-code-server) when opening it through a code-server port proxy.

## Run the production build

```sh
docker compose --env-file .env.local up -d --build
docker compose --env-file .env.local ps
```

Open `https://localhost:8443`. Before using camera or microphone access, trust the local HTTPS certificate as described in [Local HTTPS and phone testing](docs/local-https.md).

The application runs as a non-root Node.js process from Vinext's standalone production output. Caddy provides HTTPS. The app's `/api/health` endpoint is checked before the proxy starts. This command runs locally; it does not publish a public website or provision external hosting.

```sh
docker compose --env-file .env.local logs --tail=100 app caddy
docker compose --env-file .env.local down
```

Stopping the stack preserves the local certificate authority in Docker volumes. Reuse those volumes to avoid having to trust a new development certificate authority.

## Use through code-server

The `/proxy/<port>/` feature forwards HTTP to a local service. Use this override so code-server does not send plain HTTP to Mirror's local HTTPS listener:

```sh
docker compose --env-file .env.local -f compose.yaml -f compose.codeserver.yaml up -d --build
```

Open `https://code.example.org/proxy/8443/`, replacing the example hostname with your code-server hostname. Keep the trailing slash. Sign in through any access gateway protecting your code-server instance.

This mode publishes HTTP only on loopback; the browser still uses the existing code-server HTTPS connection, which supplies the secure context needed for camera and microphone access. No Mirror-specific certificate installation is needed. The proxy restores the path prefix stripped by code-server before forwarding to the application.

`CODE_SERVER_PORT` controls this HTTP entry point independently of `HTTPS_PORT`. If you change it, also update `CODE_SERVER_BASE_PATH` to the corresponding `/proxy/<port>`. The override supplies `NEXT_PUBLIC_BASE_PATH` at build time and runtime; changing the base path requires rebuilding the application. In this mode, the internal health URL is `http://app:3000/proxy/8443/api/health` with the default prefix.

For hot-reload development through the same proxy, keep the override order:

```sh
docker compose --env-file .env.local -f compose.yaml -f compose.dev.yaml -f compose.codeserver.yaml up --build
```

Use those same three files for development `exec` or `run` commands. To return to direct local HTTPS, omit `compose.codeserver.yaml` and run the normal deployment or development command with `--build`. See [Connection modes and troubleshooting](docs/local-https.md) for details.

## Develop with hot reload

Stop the production stack first, then start its development override:

```sh
docker compose --env-file .env.local down
docker compose --env-file .env.local -f compose.yaml -f compose.dev.yaml up --build
```

Source files are mounted into the development container. Dependencies use a named Docker volume; startup compares the lockfile hash and runs `npm ci` whenever it changes. Vinext's temporary cache and process lock live in a container-local `tmpfs`, preventing stale locks from crossing container restarts. Assets for local voice detection are copied automatically before the dev server starts. Caddy forwards regular requests and hot-reload WebSocket connections.

Run development commands in the same container:

```sh
docker compose --env-file .env.local -f compose.yaml -f compose.dev.yaml exec app npm run typecheck
docker compose --env-file .env.local -f compose.yaml -f compose.dev.yaml exec app npm test
```

To add or update a package, run `npm install` through this container rather than on the host, and commit both `package.json` and `package-lock.json`.

## Run automated tests

```sh
docker compose -p mirror-test -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from test
docker compose -p mirror-test -f compose.test.yaml down
```

The standalone test configuration does not load `.env.local`. It supplies a fake key and a local mock Gemini HTTP service. Tests exercise the same production application image used for deployment, and the runner performs type checking, unit tests, and Playwright tests. Reports and failure traces are written to `artifacts/`.

To test the code-server deployment, use the isolated proxy override. It places a prefix-stripping HTTP proxy in front of the same Caddy configuration used for deployment, and checks page startup and a spoken turn in both browsers:

```sh
docker compose -p mirror-codeserver-test -f compose.test.yaml -f compose.test.codeserver.yaml up --build --abort-on-container-exit --exit-code-from test
docker compose -p mirror-codeserver-test -f compose.test.yaml -f compose.test.codeserver.yaml down
```

Playwright runs Chromium and WebKit in its official, version-matched image. Browser device input is simulated, but the voice activity detector and WAV processing run normally against a synthesized English speech fixture. Speech synthesis is mocked to inspect playback and cancellation deterministically. No personal recordings or live Gemini quota are used by the automated suite.

Real browser audio, external speaker feedback, screen readers, and iOS permissions still require device testing. See [Validation](docs/validation.md) for coverage and the manual checklist.

An optional real API smoke check uses the configured key and a synthetic spoken sentence. It consumes API quota:

```sh
docker compose --env-file .env.local -f compose.yaml -f compose.dev.yaml run --build --rm --no-deps app npm run test:live
```

To check the complete running application-to-provider path instead of calling the provider directly:

```sh
docker compose --env-file .env.local -f compose.yaml -f compose.dev.yaml run --build --rm --no-deps -e MIRROR_BASE_URL=http://app:3000 app npm run test:live
```

Keep the application stack running for this check. The helper sends only synthetic audio and an image; the application's server uses its runtime credential. Single-request latency observations are recorded in [Validation](docs/validation.md).

When checking a code-server deployment, include `compose.codeserver.yaml` last in the helper's Compose command and set `MIRROR_BASE_URL=http://app:3000/proxy/8443` (or your configured prefix). Internal application requests must include that build-time base path.

## Interaction and data flow

- `Start mirror` requests permission and provides a brief framing check.
- Speak without holding a button. New speech interrupts a current answer.
- `Stop talking` cancels the answer while leaving the microphone active.
- `Pause mirror` stops camera, microphone, and playback. Use `Resume mirror` to reconnect.
- `End session` also clears the in-memory conversation. Moving the page to the background pauses capture.
- Preview video is mirrored; images sent to Gemini are not. Directions refer to the user's own left and right.

The application keeps at most ten conversational turns in browser memory and does not save recordings or transcripts to a database. Audio and current images are sent through the configured proxy to Gemini. Provider retention is governed by the proxy and upstream service, not by this application. Only English interface copy and responses are included in this MVP.

## Project structure

- `app/`: interface and same-origin API routes.
- `lib/`: request contracts, media/session logic, and Gemini integration.
- `docker/` and `compose*.yaml`: container development, HTTPS, deployment, and tests.
- `tests/`: unit and end-to-end tests.
- `docs/`: local HTTPS setup and validation notes.

The project uses React, TypeScript, Vinext, local Silero voice detection, and the Gemini REST API. `POST /api/turn` handles an opening check or one voice turn; `GET /api/health` reports process health without calling Gemini.
