import * as monaco from "monaco-editor"
import * as Comlink from "comlink"
import type { RubyWorker } from "./ruby.worker"
import { RubyInstall } from "./ruby-install"

class GitHubArtifactRegistry {
    constructor(private repo: string, private cache: Cache, private headers: HeadersInit) { }

    async getMetadata(runId: string, artifactName: string) {
        const headers = {
            "Accept": "application/vnd.github.v3+json",
            ...this.headers,
        }
        const runUrl = `https://api.github.com/repos/${this.repo}/actions/runs/${runId}`
        const runResponse = await fetch(runUrl, { headers })
        if (!runResponse.ok) {
            throw new Error(`Failed to fetch ${runUrl}: ${runResponse.statusText}`)
        }

        const run = await runResponse.json()
        const artifactsResponse = await fetch(run["artifacts_url"], { headers })
        const artifacts = await artifactsResponse.json()

        const artifact = artifacts["artifacts"].find((artifact: any) => artifact["name"] === artifactName)
        if (artifact == null) {
            throw new Error(`No ${artifactName} artifact`)
        }
        return { run, artifact }
    }

    async get(artifactUrl: string) {
        let response = await this.cache.match(artifactUrl)
        if (response == null || !response.ok) {
            response = await fetch(artifactUrl, { headers: this.headers })
            if (response.ok) {
                this.cache.put(artifactUrl, response.clone())
            }
        }
        return response
    }
}


async function authenticate() {
    if (localStorage.getItem("GITHUB_TOKEN") == null) {
        const token = prompt("GitHub Personal Access Token")
        if (token == null) {
            throw new Error("No GitHub Personal Access Token")
        }
        localStorage.setItem("GITHUB_TOKEN", token)
    }
}

async function initRubyWorkerClass(setStatus: (status: string) => void, setMetadata: (run: any) => void) {
    setStatus("Installing Ruby...")
    const query = new URLSearchParams(window.location.search)
    const actionsRunId = query.get("run")
    if (actionsRunId == null) {
        setStatus("No GitHub Actions run ID found in URL")
        return null;
    }

    const artifactRegistry = new GitHubArtifactRegistry("ruby/ruby", await caches.open("ruby-wasm-install-v1"), {
        "Authorization": `token ${localStorage.getItem("GITHUB_TOKEN")}`
    })
    const { run, artifact } = await artifactRegistry.getMetadata(actionsRunId!, "ruby-wasm-install")
    setMetadata(run)
    const zipResponse = await artifactRegistry.get(artifact["archive_download_url"])
    const zipBuffer = await zipResponse.arrayBuffer();

    setStatus("Ready")
    const RubyWorkerClass = Comlink.wrap(new Worker("build/ruby.worker.js", { type: "module" })) as unknown as {
        create(zipBuffer: ArrayBuffer, setStatus: (message: string) => void): Promise<RubyWorker>
    }
    return async () => {
        return await RubyWorkerClass.create(zipBuffer, Comlink.proxy(setStatus))
    }
}

async function init() {
    const editor = monaco.editor.create(document.getElementById('editor'), {
        value: ['def hello = puts "Hello"'].join('\n'),
        language: "ruby",
        automaticLayout: true,
        fontSize: 16,
    });

    editor.setValue(`def hello = puts "Hello"
hello
puts "World"
puts RUBY_DESCRIPTION
`)

    const buttonRun = document.getElementById("button-run")
    const output = document.getElementById("output")
    const action = document.getElementById("action") as HTMLSelectElement

    const setStatus = (status: string) => {
        document.getElementById("status").innerText = status
    }
    const setMetadata = (run: any) => {
        const description = `${run["head_commit"]["message"]}`
        document.getElementById("metadata").innerText = description
        const revisionElement = document.getElementById("revision") as HTMLAnchorElement
        revisionElement.innerText = "(" + run["head_commit"]["id"].slice(0, 7) + ")"
        revisionElement.href = run["html_url"]
        revisionElement.target = "_blank"
    }

    setStatus("Authenticating...")
    await authenticate()
    try {
        const makeRubyWorker = await initRubyWorkerClass(setStatus, setMetadata)
        if (makeRubyWorker == null) {
            return
        }
        const worker = await makeRubyWorker()
        const run = async (code: string) => {
            const selectedAction = action.value
            output.innerText = ""
            await worker.run(code, selectedAction, Comlink.proxy((lines) => {
                output.innerText += lines
            }))
        }

        buttonRun.addEventListener("click", () => {
            const text = editor.getValue()
            run(text)
        })
    } catch (error) {
        setStatus(error.message)
    }
    console.log("init")
}

init();
