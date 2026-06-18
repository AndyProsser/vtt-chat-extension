import fs from "fs";
import path from "path";

const srcDir = 'src';

function load(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function write(dir, file, data) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), data);
}

function copy(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

function build(target, overrideFile) {
  const base = load(`${srcDir}/manifest.base.json`);
  const override = load(`${srcDir}/${overrideFile}`);
  const manifest = { ...base, ...override };

  const outDir = `build/${target}`;
  write(outDir, "manifest.json", JSON.stringify(manifest, null, 2));

  copy(`icons`, `${outDir}/icons`);
  copy(`${srcDir}/content.js`, `${outDir}/content.js`);
  copy(`${srcDir}/background.js`, `${outDir}/background.js`);
  copy(`${srcDir}/popup.html`, `${outDir}/popup.html`);
  copy(`${srcDir}/popup.js`, `${outDir}/popup.js`);
}

build("firefox", "manifest.firefox.json");
build("chrome", "manifest.chrome.json");
build("edge", "manifest.chrome.json");
