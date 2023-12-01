import esbuild from "esbuild";
import { polyfillNode } from "esbuild-plugin-polyfill-node";
import { spawn } from "node:child_process"
import fs from "node:fs"
import https from "node:https"

const buildOptions = {
    entryPoints: ["src/index.ts", "src/ruby.worker.ts"],
    bundle: true,
    format: "esm",
    outdir: "./dist/build",
    splitting: true,
    sourcemap: true,
    logLevel: "info",
    loader: {
        '.ttf': 'file'
    },
    plugins: [
        polyfillNode(),
    ]
}

async function downloadBuiltinRuby(version) {
    const url = `https://github.com/ruby/ruby.wasm/releases/download/${version}/ruby.wasm`
    const destination = `./dist/build/ruby.wasm`
    if (fs.existsSync(destination)) {
        return
    }
    fs.mkdirSync("./dist/build", { recursive: true })

    async function downloadUrl(url, destination) {
        const response = await new Promise((resolve, reject) => {
            https.get(url, resolve).on("error", reject)
        })
        if (response.statusCode === 302) {
            return downloadUrl(response.headers.location, destination)
        }
        if (response.statusCode !== 200) {
            throw new Error(`Unexpected status code: ${response.statusCode}`)
        }
        const file = fs.createWriteStream(destination)
        await new Promise((resolve, reject) => {
            response.pipe(file)
            file.on("finish", resolve)
            file.on("error", reject)
        })
    }
    console.log(`Downloading ${url} to ${destination}`)
    await downloadUrl(url, destination)
}

await downloadBuiltinRuby("2.3.0")

const action = process.argv[2] ?? "build"
switch (action) {
    case "dev": {
        const ctx = await esbuild.context(buildOptions)
        const build = ctx.watch()
        spawn("ruby", ["-run", "-e", "httpd", "./dist"], { stdio: "inherit" })
        await build
        break
    }
    case "build": {
        await esbuild.build(buildOptions)
        break
    }
    default:
        console.error("Unknown action:", action)
        process.exit(1)
}
