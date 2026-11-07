# Validation

## Automated coverage

Run the isolated stack from the README. Tests never load the real proxy key. The Gemini mock validates the application's HTTP integration without spending provider quota; the browser tests use generated audio and camera frames.

For Linux WebKit, the synthetic camera playback and frame metadata are shimmed at the test-device boundary because its canvas capture stream does not produce usable decoded video. Audio streams, ONNX inference, VAD, WAV encoding, API calls, and resource lifecycle behavior still run normally. The standard speech-service mock produces deterministic PCM; both browsers use the real AudioWorklet and an analyser observes nonzero output. The separate real-TTS integration stack replaces those PCM fixtures with the GPU Kokoro service.

The suite covers:

- Production health and keyboard-accessible startup.
- Automated accessibility checks on the initial page.
- Real browser voice activity detection against synthesized speech.
- A new audio turn with a current image, and spoken reply handling.
- Interruption of an answer and rejection of obsolete responses.
- Pause, resume, end, and stopped media tracks.
- Permission denial, provider failure, and recovery.
- Ending while permission or VAD loading is pending, including later resource cleanup.
- Speech playback errors, stalled playback, truncated PCM, and audio reconnection.
- Ordered PCM playback before synthesis completes, bounded buffering, and cancellation of upstream requests.
- Quiet processing cues and their cleanup on pause, without synthetic microphone turns.
- Simulated backgrounding, page restoration, and explicit resume.
- Reference upload and removal, keyboard-accessible mode selection, and automated accessibility checks with a reference selected.
- Synthetic JPEG, PNG, and WebP inputs normalized to bounded JPEG previews; unsupported, oversized, and unreadable files rejected.
- A real VAD turn in guided mode carrying audio, a reference image, and a separately labelled current camera image.
- Explicit resume after mode changes, independent conversations, guided progress retention, reference replacement, obsolete-answer rejection, and end-session clearing.

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
9. Use the screen reader to upload, replace, and remove a reference, select both reference modes, and return to general conversation. Verify upload errors, mode changes, and guided steps are understandable without inspecting the image preview.
10. Test a reference with asymmetric makeup, a different pose, and poor lighting. Verify the assistant distinguishes the target look from the current face, reports uncertainty, and gives one usable step in guided mode. Confirm comparison mode describes differences without advancing that guided step.
11. Check that the capture confirmation and waiting tones are audible but unobtrusive, stop when speech starts or the session pauses, and do not trigger microphone feedback. The capture cue confirms receipt of audio, not successful transcription.

Playwright WebKit is not the branded Safari browser. Media behavior varies across operating systems, so automated WebKit success does not establish iPhone audio output, VoiceOver, or permission compatibility. See [Playwright's browser documentation](https://playwright.dev/docs/browsers#webkit).

## Results

### Local GPU voice and interaction cues

- Docker production builds and TypeScript checking pass. All 202 application unit tests and 13 Python speech-service tests pass, covering PCM validation, bounded playback, cancellation, timeouts, cue cleanup, and the final-chunk queue race.
- Four Chromium/WebKit checks pass through the simulated code-server proxy with real GPU Kokoro, real browser VAD, and real AudioWorklet playback. Only Argon and the camera/microphone input fixtures are mocked in this stack. Reports are at `artifacts/tts-real/playwright-report/index.html`.
- The V100 runs ONNX Runtime's CUDA provider with cuDNN 9.10.2. Startup profiling confirms 3,976 CUDA node executions, including 544 compute nodes; missing GPU support fails readiness instead of silently falling back to CPU.
- With four CPU threads and a warmed V100, a 17-word sentence has 134 ms median time to first PCM versus 1,027 ms on the CPU baseline. Ten previously unseen short instructions take 97–135 ms; a fresh-container first request takes 198 ms after readiness. These measurements exclude Argon, browser buffering, and speaker output. Samples and benchmark JSON are under `artifacts/tts/gpu/`.
- The deployed code-server stack is healthy. Both prefixed and stripped health routes return 200, and the PCM worklet is served as JavaScript. A live Argon-to-GPU opening turn completes with valid ordered NDJSON and 474,912 PCM bytes: first audio at 10,990 ms, complete at 11,417 ms. This is one connectivity sample, with the model wait included, not an end-to-end latency guarantee.
- Capture confirmation and processing cues are original synthesized tones. Capture confirmation means audio was received, not that transcription succeeded. Physical-device listening, speaker feedback, and screen-reader acceptance remain pending.

### Reference image and separate modes follow-up

- Docker production builds, TypeScript checking, and all 119 unit tests pass. The complete browser suite passes 48 checks across Chromium and WebKit, including the original session scenarios and 22 reference-related checks. The captured full report is at `artifacts/reference-full-report/index.html`.
- The code-server prefix-stripping proxy suite passes 16 checks, including real VAD with audio plus both labelled images, selection races, cancellation, and image orientation. Its report is at `artifacts/playwright-report/index.html`.
- Image checks cover JPEG/PNG/WebP conversion, the 1280-pixel/512-KiB output limits, EXIF orientation, removal of EXIF metadata, unsupported/corrupt/oversized inputs, and preserving the previous image after failed or canceled replacement.
- Session checks cover independent mode histories, saved guided steps, explicit step confirmation, stale response cancellation, removal, and ending while decoding. New reference images do not reopen capture automatically. Mock transcripts make progress checks deterministic; they do not validate real speech recognition accuracy.
- Desktop Chromium and mobile WebKit previews were inspected and have no horizontal overflow. The code-server production stack was redeployed and returns the new reference controls and a healthy API through the existing HTTP upstream.
- The real configured `gemini-4-argon` proxy accepted two synthetic portraits through the application. Comparison correctly distinguished red lips in the reference from blue lips in the current image. Guided opening returned valid progress JSON and asked which part of the look to work on. The first guided request hit the existing 30-second timeout; one explicit retry passed in 13.817 seconds. This is a connectivity sample, not a latency guarantee or validation on real faces.

Earlier results below describe the preceding version. Real-device screen readers, actual makeup guidance, and the authenticated external gateway remain pending manual validation.

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
