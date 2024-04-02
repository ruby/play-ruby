import esbuild from "esbuild";
import { polyfillNode } from "esbuild-plugin-polyfill-node";
import { spawn } from "node:child_process"
import fs from "node:fs"
import https from "node:https"

const SERVER_DEVELOPMENT_PORT = 8090
const FRONTEND_DEVELOPMENT_PORT = 8091
function makeBuildOptions(config) {
    return  {
        entryPoints: [
            `src/index.ts`, "src/ruby.worker.ts",
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
        define: Object.fromEntries(Object.entries(config).map(([key, value]) => [key, JSON.stringify(value)])),
        plugins: [
            polyfillNode(),
        ]
    }
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

async function devFrontend(config) {
    const ctx = await esbuild.context(makeBuildOptions(config))
    const watch = ctx.watch()
    spawn("ruby", ["-run", "-e", "httpd", "--", `--port=${FRONTEND_DEVELOPMENT_PORT}`, "./dist"], { stdio: "inherit" })
    console.log(`Frontend: http://localhost:${FRONTEND_DEVELOPMENT_PORT}`)
    return watch
}

function devServer(config) {
    spawn("bundle", [
        "exec", "ruby", "run.rb", "-p", String(SERVER_DEVELOPMENT_PORT),
    ], {
        cwd: "./service", stdio: "inherit",
        env: {
            ...process.env,
            ...config
        }
    })
    console.log(`Server: http://localhost:${SERVER_DEVELOPMENT_PORT}`)
    console.log('Please ensure that you have enabled "Allow invalid certificates for resources loaded from localhost"')
    console.log('in chrome://flags/#allow-insecure-localhost')
}

const action = process.argv[2] ?? "build"
switch (action) {
    case "serve:all": {
        const config = {
            "PLAY_RUBY_SERVER_URL": `https://127.0.0.1:${SERVER_DEVELOPMENT_PORT}`,
            "PLAY_RUBY_FRONTEND_URL": `http://127.0.0.1:${FRONTEND_DEVELOPMENT_PORT}`,
        }

        const watch = devFrontend(config)
        devServer(config)
        await watch
        break
    }
    case "serve": {
        const config = {
            "PLAY_RUBY_SERVER_URL": `https://play-ruby-34872ef1018e.herokuapp.com`,
            "PLAY_RUBY_FRONTEND_URL": `http://127.0.0.1:${FRONTEND_DEVELOPMENT_PORT}`,
        }
        const watch = devFrontend(config)
        await watch
    }
    case "build": {
        const config = {
            "PLAY_RUBY_SERVER_URL": `https://play-ruby-34872ef1018e.herokuapp.com`,
            "PLAY_RUBY_FRONTEND_URL": `https://ruby.github.io/play-ruby`,
        }
        await esbuild.build(makeBuildOptions(config))
        break
    }
    default:
        console.error("Unknown action:", action)
        process.exit(1)
}
