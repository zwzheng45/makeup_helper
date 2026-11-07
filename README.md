# Mirror

Mirror is a grooming assistant built for disabled people, including blind, low-vision and nonverbal users. A short setup page comes first; then the camera fills the screen. Ask questions out loud, or type them, and Mirror answers using a current camera image. Replies are shown as text and, unless turned off, spoken.

This prototype uses automatic conversational turns through `generateContent`. It does not use Gemini Live or continuously upload video. Responses take a round trip to the configured Gemini proxy and are validated in full before speech generation. A local Kokoro service then synthesizes short English phrases; the browser plays the returned PCM audio through Web Audio.

Add a photo of a makeup look to use either of two reference modes: a longer step-by-step guide toward the look, or a quick check against your current appearance. Ask anything remains available without a photo.

The interface targets WCAG 2.2 level AA and follows the visitor's own browser and device settings. See [Setup and accessibility](#setup-and-accessibility).

## Requirements

- Docker Engine or Docker Desktop with Docker Compose v2.24.4 or later.
- A recent Chrome or Safari browser with AudioWorklet support and a camera. Voice mode also needs a microphone; spoken replies need audio output.
- A Gemini proxy key with access to the configured model.
- An NVIDIA GPU with a CUDA 12.6-compatible driver and NVIDIA Container Toolkit configured for Docker. The speech image targets Linux amd64, reserves one GPU, and allows four CPU cores and 2 GiB host RAM. No cloud TTS key is required.

Node.js, npm, model assets, and test browsers run inside containers. No host Node.js installation is required. Camera and microphone access happens in the visitor's browser; containers do not need camera device mounts.

## Configure

Copy `.env.example` to `.env.local`, then set `GEMINI_PROXY_KEY`. Keep the file outside version control.

| Variable | Purpose | Default |
| --- | --- | --- |
| `GEMINI_PROXY_KEY` | Server-only proxy credential | Required |
| `GEMINI_PROXY_BASE_URL` | Gemini-compatible API base URL | Supplied project proxy |
| `GEMINI_MODEL` | Model used for each conversational turn | `gemini-4-argon` |
| `TTS_BASE_URL` | Server-only URL of the internal speech service | `http://tts:8000` |
| `TTS_THREADS` | ONNX host-side inference threads, with a four-core container limit | `4` |
| `APP_HOST` | Hostname or LAN IP on the HTTPS certificate | `localhost` |
| `HTTPS_PORT` | Published HTTPS port | `8443` |
| `BIND_ADDRESS` | Host interface on which HTTPS is published | `127.0.0.1` |
| `CODE_SERVER_BASE_PATH` | Public path used by the code-server override | `/proxy/8443` |
| `CODE_SERVER_PORT` | Loopback HTTP port forwarded by code-server | `8443` |

Always pass `--env-file .env.local` when using the main Compose stack. This configures both Compose's port/hostname interpolation and the application's runtime environment. Credentials are injected at runtime; they are not build arguments and are excluded from the image build context.

Choose the entry point that matches your environment: use the default local HTTPS stack below when opening Mirror directly, the [code-server override](#use-through-code-server) for its port proxy, or the [Cloudflare Tunnel override](#use-through-cloudflare-tunnel) for a dedicated public hostname.

## Run the production build

```sh
docker compose --env-file .env.local up -d --build
docker compose --env-file .env.local ps
```

Open `https://localhost:8443`. Before using camera or microphone access, trust the local HTTPS certificate as described in [Local HTTPS and phone testing](docs/local-https.md).

The application runs as a non-root Node.js process from Vinext's standalone production output. Caddy provides HTTPS. The app waits for the local speech service to load and warm its model, and the app's `/api/health` endpoint is checked before the proxy starts. This command runs locally; it does not publish a public website or provision external hosting.

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


## Use through Cloudflare Tunnel

Use this HTTP origin when Cloudflare Tunnel supplies public HTTPS for a dedicated hostname. The application is built at `/`:

```sh
docker compose --env-file .env.local -f compose.yaml -f compose.tunnel.yaml up -d --build --wait
```

The origin defaults to `127.0.0.1:8080`. If the tunnel connector runs on a different LAN host, set `TUNNEL_BIND_ADDRESS` in `.env.local` to this application's LAN address. For an application host at `192.168.31.101` and a connector at `192.168.31.100`, set `TUNNEL_BIND_ADDRESS=192.168.31.101`, then configure the tunnel's public hostname `mirror.axistence.org` with HTTP service `http://192.168.31.101:8080`. `TUNNEL_PORT` changes the origin port.

Open `https://mirror.axistence.org/` in the browser so camera and microphone APIs have a secure context. The LAN HTTP URL is the tunnel's upstream, not the browser URL. This override replaces the code-server entry point; do not combine it with `compose.codeserver.yaml`.

## Develop with hot reload

Stop the production stack first, then start its development override:

```sh
docker compose --env-file .env.local down
docker compose --env-file .env.local -f compose.yaml -f compose.dev.yaml up --build
```

Source files are mounted into the development container. Dependencies use a named Docker volume; startup compares the lockfile hash and runs `npm ci` whenever it changes. Vinext's temporary cache and process lock live in a container-local `tmpfs`, preventing stale locks from crossing container restarts. Assets for local voice detection are copied automatically before the dev server starts. Caddy forwards regular requests and hot-reload WebSocket connections.

The development override also mounts `services/tts/` into the speech container. After changing its Python files, restart `tts` with the same Compose file combination. Model files remain in the image and are not downloaded when the service restarts.

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

When running isolated stacks concurrently, set a different `MIRROR_TEST_ARTIFACTS` directory for each one so their Playwright reports and traces do not overwrite each other.

The standard suite uses deterministic PCM fixtures and does not require a GPU. To additionally connect the production app and real browser AudioWorklet to the GPU speech service, run the following isolated integration stack. Gemini stays mocked, so this consumes no provider quota:

```sh
docker compose -p mirror-real-tts-test -f compose.test.yaml -f compose.test.tts.yaml up --build --abort-on-container-exit --exit-code-from test
docker compose -p mirror-real-tts-test -f compose.test.yaml -f compose.test.tts.yaml down
```

This integration check requires an NVIDIA GPU and the NVIDIA Container Toolkit, just like deployment.

To test the code-server deployment, use the isolated proxy override. It places a prefix-stripping HTTP proxy in front of the same Caddy configuration used for deployment, and checks page startup, a spoken turn, reference selection, and a guided reference turn in both browsers:

```sh
docker compose -p mirror-codeserver-test -f compose.test.yaml -f compose.test.codeserver.yaml up --build --abort-on-container-exit --exit-code-from test
docker compose -p mirror-codeserver-test -f compose.test.yaml -f compose.test.codeserver.yaml down
```

Playwright runs Chromium and WebKit in its official, version-matched image. Browser device input is simulated, but the voice activity detector and WAV processing run normally against a synthesized English speech fixture. Deterministic speech-service fixtures supply PCM audio; playback tests exercise the real AudioWorklet queue and sample output. No personal recordings or live Gemini quota are used by the automated suite. The local service's own Docker tests and real-model benchmark are described in [services/tts/README.md](services/tts/README.md).

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

To check reference modes against the running application, the following separate live check draws two synthetic faces with different lip colors and sends an opening request in each mode. It consumes two real API requests and does not read a credential in the runner:

```sh
docker build --target test -t mirror:test-runner .
MIRROR_APP_CONTAINER=$(docker compose --env-file .env.local -f compose.yaml -f compose.codeserver.yaml ps -q app)
docker run --rm --network "container:$MIRROR_APP_CONTAINER" \
  -e MIRROR_BASE_URL=http://127.0.0.1:3000/proxy/8443 \
  mirror:test-runner npm run test:live:reference
```

For the direct local HTTPS stack, omit the code-server override and use `http://127.0.0.1:3000` as the internal application base URL. Add `-e MIRROR_REFERENCE_MODE=guided` or `compare` to check just one mode. This check validates dual-image connectivity and structured replies; it is not a measure of makeup instruction quality on real faces.

## Interaction and data flow

- The setup page (`/`) opens first. `Save and continue` opens the mirror (`/mirror`); choosing nothing gives the standard voice mirror. `Settings` on the mirror page returns to setup. Leaving the mirror page turns the camera and microphone off and clears its conversation and photo.
- `Start mirror` requests permission and provides a brief framing check. The camera then fills the page behind the controls.
- Voice mode: speak without holding a button. New speech interrupts a current answer. `Mute microphone` keeps the camera on but sends nothing until `Unmute microphone`. Saying "pause" or "stop listening" also mutes.
- Nonverbal mode never requests the microphone. Type in `Your question` and press `Send` or Enter.
- Replies are spoken by the local speech service at the talking speed chosen in setup. With `Read replies aloud` off, the server answers in plain JSON and no speech is synthesized.
- Quiet local tones acknowledge a captured sentence and indicate that the assistant is processing. These cues are generated with Web Audio; they do not use the device's speech voice or a TTS request.
- In either mode, the suggested questions under the reply are sent as typed questions. In step-by-step mode, "Done, next step" confirms the current step.
- `Finish` ends the session (camera and microphone off, conversation and photo cleared) and returns to the setup page. There is no pause button: otherwise capture stops only when the page moves to the background or a device is lost, and `Start mirror` reconnects. Saying "stop" cancels a spoken answer, and saying "end session" ends the session in place.
- Preview video is mirrored; images sent to Gemini are not. Directions refer to the user's own left and right.

## Setup and accessibility

| Setting | Choices | Starts from |
| --- | --- | --- |
| How will you use Mirror? | Blind or low vision; Nonverbal (type instead). Pick one, both or neither. | Neither |
| Text size | Default, Large (125%), Larger (150%) | The browser's own text size |
| Contrast | Standard, High | The device's `prefers-contrast` setting |
| Theme | Auto, Light, Dark | Auto follows `prefers-color-scheme` |
| Read replies aloud | On, Off | On |
| Talking speed | Slow, Normal, Fast | Normal |

Choices are saved in this browser's `localStorage` only and are applied by a small script in `<head>` before the page paints. A contrast choice that matches the device is stored as automatic, so later device changes are still followed. If storage is blocked, the choices are carried in the mirror page's address instead.

Accessibility behaviour:

- All sizes use `rem`, so browser zoom, the browser's default font size and the Text size setting all scale the whole interface. The fixed full-screen layout returns to normal page flow at narrow widths, large text or zoom, and reflows without horizontal scrolling at 320 CSS pixels.
- Windows high contrast (`forced-colors`) and `prefers-reduced-motion` are supported. Every control is a native button, link, checkbox, radio or text field with a visible label and a visible two-tone focus ring, at least 44 pixels tall.
- With Read replies aloud off, the reply is announced through a polite live region instead of being spoken, so screen-reader users hear it once. Status changes such as mute are announced in a status region, and errors in an alert.
- When the controls swap after Start or after capture stops, keyboard focus moves to the next control instead of being lost.
- Automated tests run axe-core on both pages in light, dark and high-contrast themes.

The application keeps at most ten conversational turns per mode in browser memory and does not save recordings or transcripts to a database. Audio and current images are sent through the configured proxy to Gemini. Reference modes also send the prepared reference image; guided mode includes the current step and a short progress summary. Provider retention is governed by the proxy and upstream service, not by this application. Only English interface copy and responses are included in this MVP.

Validated reply text is sent to the local speech container. It uses full-precision Kokoro-82M v1.0 with the fixed `af_heart` voice at speed 1.0 and ONNX Runtime's CUDA provider. Both model and voices are downloaded and SHA256-verified during the Docker build, then bundled in the image. Startup verifies real CUDA model computation during warmup and refuses to silently fall back to CPU. The runtime has no published port or external network access. It keeps one inference active and at most one request waiting; extra requests receive a busy response. A cancellation immediately discards obsolete output, while an already-running ONNX operation finishes before its execution slot is reused.

Local speech removes a cloud TTS round trip, but total response time still includes the Gemini proxy's complete answer and the first phrase's synthesis. It does not guarantee a response within 500 ms. Measurements must distinguish first PCM arrival, leading low-level audio, the browser's playback buffer, and the user's actual device output.

## Use a reference look

Choose a JPEG, PNG, or WebP image with `Add photo` at the top of the mirror page. The original file must be no larger than 10 MiB. The browser prepares a JPEG with a longest edge of at most 1280 pixels and a size of at most 512 KiB; the original file is not uploaded. The image stays in page memory until removed, replaced, the session ends, or the page reloads.

| Mode (internal name) | Behavior |
| --- | --- |
| Ask anything (`general`) | Answers everyday grooming questions using your current camera view. An uploaded photo is not sent in this mode. |
| Step-by-step guide (`guided`) | The longer mode. Introduces the look, clarifies your target and available products, then gives one step at a time and keeps progress across turns. |
| Quick check (`compare`) | The quick mode. Describes visible differences between the photo and your current camera view without continuing the guided sequence. |

The mode choices appear once a photo is ready. They can be changed before or during a session. Changing mode keeps the camera running, discards any answer still in progress for the old mode, and immediately opens the new one. Each mode keeps its own conversation, so returning to the step-by-step guide retains its step and progress.

In step-by-step mode, say or type "done" or "next step" when the current step is finished. Asking a question does not confirm completion. The server preserves the current step until it receives an explicit confirmation, and records the completed step in the progress summary.

Replacing the photo clears photo-related histories and progress, rejects any answer about the old photo, and restarts the current mode with the new one. Removing it returns to Ask anything. Neither action turns the camera off. The photo and current camera image are labelled separately in requests so the assistant can distinguish the desired look from what is currently visible.

## Project structure

- `app/`: setup page (`app/page.tsx`), full-screen mirror page (`app/mirror/`), shared styles, and same-origin API routes.
- `lib/`: request contracts, saved settings, media/session logic, and Gemini integration.
- `services/tts/`: offline GPU speech service, pinned model manifest, dependency locks, service tests, and timing benchmark.
- `docker/` and `compose*.yaml`: container development, HTTPS, deployment, and tests.
- `tests/`: unit and end-to-end tests.
- `docs/`: local HTTPS setup and validation notes.

The project uses React, TypeScript, Vinext, local Silero voice detection, and the Gemini REST API. `POST /api/turn` handles an opening check or one voice turn; `GET /api/health` reports process health without calling Gemini.
