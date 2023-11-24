import * as monaco from "monaco-editor"
import * as Comlink from "comlink"
import type { RubyWorker } from "./ruby.worker"

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
            throw new Error(`Metadata fetch error: ${runResponse.status}`)
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

function teeDownloadProgress(response: Response, setProgress: (bytes: number) => void): Response {
    let loaded = 0
    return new Response(new ReadableStream({
        async start(controller) {
            const reader = response.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                loaded += value.byteLength;
                setProgress(loaded);
                controller.enqueue(value);
            }
            controller.close();
        },
    }));
}


async function authenticate() {
    const stored = localStorage.getItem("GITHUB_TOKEN");
    if (stored == null || stored === "") {
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

    setStatus("Downloading Ruby...")
    const zipResponse = teeDownloadProgress(
        await artifactRegistry.get(artifact["archive_download_url"]),
        (bytes) => {
            const total = Number(artifact["size_in_bytes"])
            const percent = Math.round(bytes / total * 100)
            setStatus(`Downloading Ruby... ${percent}%`)
        }
    )
    const zipBuffer = await zipResponse.arrayBuffer();

    const RubyWorkerClass = Comlink.wrap(new Worker("build/ruby.worker.js", { type: "module" })) as unknown as {
        create(zipBuffer: ArrayBuffer, setStatus: (message: string) => void): Promise<RubyWorker>
    }
    return async () => {
        return await RubyWorkerClass.create(zipBuffer, Comlink.proxy(setStatus))
    }
}

function initEditor() {
    const editor = monaco.editor.create(document.getElementById('editor'), {
        value: ['def hello = puts "Hello"'].join('\n'),
        language: "ruby",
        fontSize: 16,
    });

    const layoutEditor = () => {
        // 1. Squash the editor to 0x0 to layout the parent container
        editor.layout({ width: 0, height: 0 })
        // 2. Wait for the next animation frame to ensure the parent container has been laid out
        window.requestAnimationFrame(() => {
            // 3. Resize the editor to fill the parent container
            const { width, height } = editor.getContainerDomNode().getBoundingClientRect()
            editor.layout({ width, height })
        })
    }
    window.addEventListener("resize", layoutEditor)

    editor.setValue(`def hello = puts "Hello"
hello
puts "World"
puts RUBY_DESCRIPTION
`)

    return editor;
}

function initUI() {
    const showHelpButton = document.getElementById("button-show-help")
    const helpModal = document.getElementById("modal-help") as HTMLDialogElement
    showHelpButton.addEventListener("click", () => {
        helpModal.showModal()
    })

    const showConfigButton = document.getElementById("button-show-config")
    const configModal = document.getElementById("modal-config") as HTMLDialogElement
    const configGithubToken = document.getElementById("config-github-token") as HTMLInputElement
    showConfigButton.addEventListener("click", () => {
        configGithubToken.value = localStorage.getItem("GITHUB_TOKEN") ?? ""
        configModal.showModal()
    })
    const configForm = document.getElementById("config-form") as HTMLFormElement
    configForm.addEventListener("submit", (event) => {
        event.preventDefault()
        localStorage.setItem("GITHUB_TOKEN", configGithubToken.value)
        configModal.close()
    })

    for (const modal of [helpModal, configModal]) {
        modal.addEventListener("click", (event) => {
            if (event.target === modal) {
                // Clicked on the modal backdrop
                modal.close()
            }
        })
    }
}

async function init() {
    initUI();
    const editor = initEditor()
    const buttonRun = document.getElementById("button-run")
    const output = document.getElementById("output")
    const action = document.getElementById("action") as HTMLSelectElement

    const setStatus = (status: string) => {
        document.getElementById("status").innerText = status
    }
    const setMetadata = (run: any) => {
        const description = `${run["head_commit"]["message"]}`
        const metadataElement = document.getElementById("metadata") as HTMLAnchorElement
        metadataElement.innerText = run["head_commit"]["id"].slice(0, 7) + ": " + description
        metadataElement.href = run["html_url"]
        metadataElement.target = "_blank"
    }

    setStatus("Authenticating...")
    await authenticate()
    try {
        const makeRubyWorker = await initRubyWorkerClass(setStatus, setMetadata)
        if (makeRubyWorker == null) {
            return
        }
        const worker = await makeRubyWorker()
        const writeOutput = (message: string) => {
            output.innerText += message
        }
        const run = async (code: string) => {
            const selectedAction = action.value
            output.innerText = ""
            await worker.run(code, selectedAction, Comlink.proxy(writeOutput))
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
