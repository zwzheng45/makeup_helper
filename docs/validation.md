# Validation

## Automated coverage

Run the isolated stack from the README. Tests never load the real proxy key. The Gemini mock validates the application's HTTP integration without spending provider quota; the browser tests use generated audio and camera frames.

For Linux WebKit, the synthetic camera playback and frame metadata are shimmed at the test-device boundary because its canvas capture stream does not produce usable decoded video. Audio streams, ONNX inference, VAD, WAV encoding, API calls, and resource lifecycle behavior still run normally. Speech synthesis is mocked in both browser engines.

The suite covers:

- Production health and keyboard-accessible startup.
- Automated accessibility checks on the initial page.
- Real browser voice activity detection against synthesized speech.
- A new audio turn with a current image, and spoken reply handling.
- Interruption of an answer and rejection of obsolete responses.
- Pause, resume, end, and stopped media tracks.
- Permission denial, provider failure, and recovery.
- Ending while permission or VAD loading is pending, including later resource cleanup.
- Speech playback errors and missing playback-start events, with audio reconnection.
- Simulated backgrounding, page restoration, and explicit resume.

Type checking and unit tests run in the same test container before browser tests. The production image is built from the lockfile and run without a development server. A test run is successful only when the test service exits with code zero; HTML reports and retained traces are exported to `artifacts/`.

## Real API smoke check

The optional `npm run test:live` command must be run through the development container. It uses synthetic speech and a generated image, exercises the configured model's audio/image request, and reports a bounded result without printing the credential. This is separate from the deterministic mock tests and uses live quota.

## Manual acceptance

Record results for each available device rather than treating Linux browser emulation as a real-device pass:

| Device/browser | Assistive technology | Status |
| --- | --- | --- |
| Desktop Chrome | NVDA | Pending real-device validation |
| iPhone Safari | VoiceOver | Pending real-device validation |
| Android Chrome | TalkBack | Pending real-device validation |

For each target:

1. Start, grant permissions, and complete ten voice turns without touching the screen again.
2. Interrupt five spoken answers and verify the old answer never returns.
3. Test device speakers at normal volume; check for echo-driven false interruptions. Repeat with grooming-device background noise and short coughs.
4. Test left/right with a clear unilateral marker, poor lighting, occlusion, and moving out of frame. Check that uncertain observations are described as uncertain.
5. Use only the screen reader to pause, resume, and end. Verify no duplicated automatic reading of AI replies and no unexpected focus movement.
6. Reject permissions, interrupt the network, switch apps, and lock/unlock the phone. Confirm that capture stops when paused and only resumes explicitly.
7. Verify camera and microphone indicators turn off after ending the session.
8. Measure time from the end of a sentence to the first spoken response, and time from beginning an interruption to playback stopping. Report medians and observed slow cases rather than assuming a real-time guarantee.

Playwright WebKit is not the branded Safari browser. Media behavior varies across operating systems, so automated WebKit success does not establish iPhone speech synthesis, VoiceOver, or permission compatibility. See [Playwright's browser documentation](https://playwright.dev/docs/browsers#webkit).

## Results

### Code-server proxy follow-up

The code-server deployment adds an HTTP loopback entry point and a build-time `/proxy/8443` base path while retaining the default direct HTTPS mode.

- The production override builds and runs successfully, publishing HTTP on `127.0.0.1:8443`. Both stripped and prefixed health requests return 200.
- An isolated two-proxy Docker stack strips `/proxy/8443` before forwarding, matching code-server's behavior, and rejects requests outside that prefix.
- Chromium and WebKit each pass page startup/accessibility and a spoken-turn scenario through this proxy (four checks total). The checks audit same-origin requests for prefix escapes and failed resources, including the ONNX model and WASM, and exercise the API using synthetic speech and a camera frame. The latest report is available at `artifacts/playwright-report/index.html`; each browser run replaces this report.
- HTML, JavaScript, CSS, favicon, and audio worklet requests return the expected content types through the HTTP entry point. Type checking and all 66 unit tests pass in Docker.
- The combined development and code-server overrides start successfully in an isolated Docker project. Development HTML uses prefixed script URLs; Vite hot-reload WebSocket connections receive `connected` both with the prefix intact and after simulating code-server's prefix stripping. No source edit was needed for this handshake check. Vinext's lock/cache directory uses container-local `tmpfs`; the existing host lock was left untouched.

The real external code-server URL is protected by an access-gateway login. Its authenticated browser-to-application path has not been verified from this environment. A strip-prefix proxy simulation verifies the routing behavior but does not establish that external authentication, browser permissions, or a user's device have been tested.

### 2026-11-07: workspace verification

- Production and development Docker images build successfully from the lockfile.
- Production runs with Node.js 24.22.2 as UID 1000. The application health endpoint responds through Caddy HTTPS, with the exported root certificate explicitly verified by the client.
- Development source mounting and CSS hot reload work through the same Caddy HTTPS entry point. Desktop Chromium and mobile WebKit previews render without horizontal overflow.
- Containerized TypeScript checking and all 66 unit tests pass, including the final voice-control clarification regressions. Chromium and WebKit each pass 13 end-to-end scenarios (26 total). The browser suite exits with code zero.
- The real `gemini-4-argon` proxy accepted synthetic speech and a red JPEG, returned the correct transcript and color, and followed the structured JSON contract: 11.711 seconds for a direct request and 8.324 seconds through the production application's `/api/turn` endpoint.
- The same direct synthetic check passed with `gemini-3.8-flash` in 5.832 seconds. The default remains `gemini-4-argon`; the operator can change `GEMINI_MODEL` without changing the user interface.

These are individual connectivity samples, not a latency benchmark or an end-to-end speech-response guarantee. The real-device and screen-reader checklist above remains pending.

The pinned Vinext runtime can log `ERR_STREAM_UNABLE_TO_PIPE` when an intentional client interruption closes a response stream. The cancellation scenarios pass and the service remains healthy; this log does not indicate that an obsolete answer was played.
