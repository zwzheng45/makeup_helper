import { mkdir, copyFile, readdir } from "node:fs/promises";
import path from "node:path";
const destination = path.resolve("public/vad");
await mkdir(destination, { recursive: true });
for (const directory of ["node_modules/@ricky0123/vad-web/dist", "node_modules/onnxruntime-web/dist"]) {
  for (const name of await readdir(directory)) {
    if (name === "vad.worklet.bundle.min.js" || name === "silero_vad_v5.onnx" || name.endsWith(".wasm") || name.endsWith(".mjs")) {
      await copyFile(path.join(directory, name), path.join(destination, name));
    }
  }
}
console.log("VAD assets copied to public/vad.");
