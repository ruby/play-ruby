import esbuild from "esbuild";
import { polyfillNode } from "esbuild-plugin-polyfill-node";
import { spawn } from "node:child_process"
import fs from "node:fs"
import https from "node:https"

const buildOptions = {
    entryPoints: [
        "src/index.ts", "src/ruby.worker.ts",
        "./node_modules/monaco-editor/esm/vs/editor/editor.worker.js",
        "./node_modules/monaco-editor/esm/vs/language/json/json.worker.js",
    ],
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

async function downloadBuiltinRuby(version, rubyVersion) {
    const tarball = `ruby-${rubyVersion}-wasm32-unknown-wasi-full.tar.gz`
    const url = `https://github.com/ruby/ruby.wasm/releases/download/${version}/${tarball}`
    const destination = `./dist/build/ruby-${rubyVersion}/install.tar.gz`
    const zipDest = `./dist/build/ruby-${rubyVersion}.zip`
    fs.mkdirSync(`./dist/build/ruby-${rubyVersion}`, { recursive: true })

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
    if (!fs.existsSync(destination)) {
        console.log(`Downloading ${url} to ${destination}`)
        await downloadUrl(url, destination)
    }

    if (!fs.existsSync(zipDest)) {
        console.log(`Zipping ${destination} to ${zipDest}`)
        await new Promise((resolve, reject) => {
            const zip = spawn("zip", ["-j", zipDest, destination])
            zip.on("exit", resolve)
            zip.on("error", reject)
        })
    }
}

await downloadBuiltinRuby("2.4.1", "3.2")
await downloadBuiltinRuby("2.4.1", "3.3")

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
