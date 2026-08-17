import { watch as watchFiles } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const watch = process.argv.includes("--watch");

async function buildOnce() {
  await rm("dist", { recursive: true, force: true });
  await mkdir("dist", { recursive: true });
  await mkdir(".context/build", { recursive: true });

  await build({
    entryPoints: ["src/main.ts"],
    bundle: true,
    outfile: "dist/code.js",
    target: "es2020",
    format: "iife",
    sourcemap: false,
  });

  await build({
    entryPoints: ["src/ui/index.tsx"],
    bundle: true,
    outfile: ".context/build/ui.js",
    target: "es2020",
    format: "iife",
    sourcemap: false,
    loader: {
      ".css": "css",
    },
  });

  const [js, css] = await Promise.all([
    readFile(".context/build/ui.js", "utf8"),
    readFile(".context/build/ui.css", "utf8").catch(() => ""),
  ]);

  await writeFile(
    "dist/ui.html",
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>${css}</style>
  </head>
  <body>
    <div id="root"></div>
    <script>${js}</script>
  </body>
</html>
`,
  );
}

if (watch) {
  await buildOnce();
  console.log("Watching src/ for changes...");

  let timer;
  watchFiles("src", { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await buildOnce();
      } catch (error) {
        console.error(error);
      }
    }, 100);
  });
} else {
  await buildOnce();
  console.log("Built Figma plugin into dist/");
}
