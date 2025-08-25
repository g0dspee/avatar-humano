// generaManifest.ts
import { writeFileSync, readdirSync } from "node:fs";
import { join } from "path";

const dir = "C:/Users/admin/Desktop/real-avatar-move/real-avatar/public/assets/demo_avatar/img";
const files = readdirSync(dir)
  .filter(f => f.endsWith(".jpg"))
  .sort(); // asegúrate que sea 0001.jpg, 0002.jpg, etc.

const manifest = {
  basePath: "/assets/demo_avatar/img/",
  frames: files,
  fps: 25,
  width: 640,
  height: 360,
  audio: "audio.ogg" // ← cambia si tu audio tiene otro nombre
};

writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("✓ manifest.json generado");
