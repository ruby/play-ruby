import * as monaco from "monaco-editor"
import * as Comlink from "comlink"
import type { RubyWorker } from "./ruby.worker"

class GitHubAPIError extends Error {
    constructor(context: string, public response: Response) {
        super(`GitHub API error (${context}): ${response.status} ${response.statusText}`)
    }

    isUnauthorized() {
        return this.response.status === 401
    }
}

/**
 * Provides access to GitHub Actions artifacts
 */
class GitHubArtifactRegistry {
    constructor(private repo: string, private cache: Cache, private headers: HeadersInit) { }

    async getPullRequestLatestRunId(prNumber: string, workflowPath: string) {
        const headers = {
            "Accept": "application/vnd.github.v3+json",
            ...this.headers,
        }
        const prUrl = `https://api.github.com/repos/${this.repo}/pulls/${prNumber}`
        const prResponse = await fetch(prUrl, { headers })
        if (!prResponse.ok) {
            throw new GitHubAPIError("PR fetch", prResponse)
        }
        const pr = await prResponse.json()
        const headSha = pr["head"]["sha"]

        const runsUrl = `https://api.github.com/repos/${this.repo}/actions/runs?event=pull_request&head_sha=${headSha}`
        const runsResponse = await fetch(runsUrl, { headers })
        if (!runsResponse.ok) {
            throw new GitHubAPIError("Runs fetch", runsResponse)
        }
        const runs = await runsResponse.json()

        for (const run of runs["workflow_runs"]) {
            if (run["path"] === workflowPath) {
                return run["id"]
            }
        }
        throw new Error(`No run for ${workflowPath} in PR ${prNumber}`)
    }

    /**
     * Fetches the metadata for a GitHub Actions run and returns the metadata for the given artifact
     * @param runId The ID of the GitHub Actions run
     * @param artifactName The name of the artifact
     * @returns The metadata for the artifact in the given run
     */
    async getMetadata(runId: string, artifactName: string) {
        const headers = {
            "Accept": "application/vnd.github.v3+json",
            ...this.headers,
        }
        const runUrl = `https://api.github.com/repos/${this.repo}/actions/runs/${runId}`
        const runResponse = await fetch(runUrl, { headers })
        if (!runResponse.ok) {
            throw new GitHubAPIError("Run fetch", runResponse)
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

    /**
     * Returns the artifact at the given URL, either from the cache or by downloading it
     */
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

/**
 * Passes through a response, but also calls setProgress with the number of bytes downloaded
 */
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


async function initRubyWorkerClass(setStatus: (status: string) => void, setMetadata: (run: any) => void) {
    setStatus("Installing Ruby...")
    const rubySource = rubySourceFromURL()
    if (rubySource == null) {
        setStatus("No ?run= or ?pr= query parameter")
        return null;
    }

    const artifactRegistry = new GitHubArtifactRegistry("ruby/ruby", await caches.open("ruby-wasm-install-v1"), {
        "Authorization": `token ${localStorage.getItem("GITHUB_TOKEN")}`
    })

    let actionsRunId: string | null = null
    if (rubySource.type === "github-actions-run") {
        actionsRunId = rubySource.runId
    } else if (rubySource.type === "github-pull-request") {
        actionsRunId = await artifactRegistry.getPullRequestLatestRunId(rubySource.prNumber, ".github/workflows/wasm.yml")
    }

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

type RubySource = {
    type: "github-actions-run",
    runId: string,
} | {
    type: "github-pull-request",
    prNumber: string,
}

function rubySourceFromURL(): RubySource | null {
    const query = new URLSearchParams(window.location.search)
    for (const [key, value] of query.entries()) {
        if (key === "run") {
            return { type: "github-actions-run", runId: value }
        } else if (key === "pr") {
            return { type: "github-pull-request", prNumber: value }
        }
    }
    return null
}

type UIState = {
    code: string,
    action: string,
}

function initEditor(state: UIState) {
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

    editor.setValue(state.code)
    editor.onDidChangeModelContent(() => {
        const url = new URL(window.location.href)
        url.searchParams.set("code", editor.getValue())
        window.history.replaceState({}, "", url.toString())
    })

    return editor;
}

function stateFromURL(): UIState {
    const query = new URLSearchParams(window.location.search)
    let code = query.get("code")
    if (code == null) {
        code = `def hello = puts "Hello"
hello
puts "World"
puts RUBY_DESCRIPTION`
    }

    let action = query.get("action")
    if (action == null) {
        action = "eval"
    }

    return { code, action }
}

function initUI(state: UIState) {
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
    const uiState = stateFromURL();
    initUI(uiState);
    const editor = initEditor(uiState)
    const buttonRun = document.getElementById("button-run")
    const outputPane = document.getElementById("output")
    const actionSelect = document.getElementById("action") as HTMLSelectElement
    actionSelect.value = uiState.action
    actionSelect.addEventListener("change", () => {
        const url = new URL(window.location.href)
        url.searchParams.set("action", actionSelect.value)
        window.history.replaceState({}, "", url.toString())
    })

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

    try {
        const makeRubyWorker = await initRubyWorkerClass(setStatus, setMetadata)
        if (makeRubyWorker == null) {
            return
        }
        const worker = await makeRubyWorker()
        const writeOutput = (message: string) => {
            outputPane.innerText += message
        }
        const run = async (code: string) => {
            const selectedAction = actionSelect.value
            outputPane.innerText = ""
            await worker.run(code, selectedAction, Comlink.proxy(writeOutput))
        }

        buttonRun.addEventListener("click", () => {
            const text = editor.getValue()
            run(text)
        })
    } catch (error) {
        setStatus(error.message)
        if (error instanceof GitHubAPIError && error.isUnauthorized()) {
            const configModal = document.getElementById("modal-config") as HTMLDialogElement
            configModal.showModal()
            return
        }
    }
    console.log("init")
}

init();
