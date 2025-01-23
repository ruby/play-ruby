import * as monaco from "monaco-editor"
import * as Comlink from "comlink"
import type { RubyWorker } from "./ruby.worker"
import { splitFile } from "./split-file"

type PlayRubyConfig = {
    SERVER_URL: string,
    ENABLE_GITHUB_INTEGRATION: boolean,
}

class GitHubAPIError extends Error {
    constructor(context: string, public response: Response) {
        super(`GitHub API error (${context}): ${response.status} ${response.statusText}`)
    }

    isUnauthorized() {
        return this.response.status === 401
    }
}
interface ArtifactDownloader {
    getDownloadInfo(source: string, payload: string): Promise<{ run: any, artifact: any }>;
    downloadArtifact(url: string): Promise<Response>;
}

/**
 * Provides access to GitHub Actions artifacts using GitHub Access Tokens
 */
class TokenBasedArtifactDownloader implements ArtifactDownloader {
    constructor(private repo: string, private headers: HeadersInit) { }

    private async jsonRequest(url: string, context: string) {
        const headers = {
            "Accept": "application/vnd.github.v3+json",
            ...this.headers,
        }
        const response = await fetch(url, { headers })
        if (!response.ok) {
            throw new GitHubAPIError(context, response)
        }
        return await response.json()
    }

    async getPullRequestLatestRunId(prNumber: string, workflowPath: string) {
        const prUrl = `https://api.github.com/repos/${this.repo}/pulls/${prNumber}`
        const pr = await this.jsonRequest(prUrl, "PR fetch")
        const headSha = pr["head"]["sha"]

        const runsUrl = `https://api.github.com/repos/${this.repo}/actions/runs?event=pull_request&head_sha=${headSha}`
        const runs = await this.jsonRequest(runsUrl, "Runs fetch")

        for (const run of runs["workflow_runs"]) {
            if (run["path"] === workflowPath) {
                return run["id"]
            }
        }
        throw new Error(`No run for ${workflowPath} in PR ${prNumber}`)
    }

    async getBranchLatestRunId(branch: string, workflowPath: string) {
        async function* commits() {
            let page = 1
            while (true) {
                const commitsUrl = `https://api.github.com/repos/${this.repo}/commits?sha=${branch}&page=${page}`
                const commits = await this.jsonRequest(commitsUrl, "Commits fetch")
                for (const commit of commits) {
                    yield commit
                }
                if (commits.length === 0) {
                    break
                }
                page++
            }
        }

        for await (const commit of commits.call(this)) {
            const runsUrl = `https://api.github.com/repos/${this.repo}/actions/runs?event=push&branch=${branch}&commit_sha=${commit["sha"]}&status=success&exclude_pull_requests=true`
            let runs: any;
            try {
                runs = await this.jsonRequest(runsUrl, "Runs fetch")
            } catch (error) {
                if (error instanceof GitHubAPIError && error.response.status === 404) {
                    // No runs for this commit
                    continue
                }
                throw error
            }

            for (const run of runs["workflow_runs"]) {
                if (run["path"] === workflowPath) {
                    return run["id"]
                }
            }
        }
    }

    /**
     * Fetches the metadata for a GitHub Actions run and returns the metadata for the given artifact
     * @param runId The ID of the GitHub Actions run
     * @param artifactName The name of the artifact
     * @returns The metadata for the artifact in the given run
     */
    async getMetadata(runId: string, artifactName: string) {
        const runUrl = `https://api.github.com/repos/${this.repo}/actions/runs/${runId}`
        const run = await this.jsonRequest(runUrl, "Run fetch")
        const artifacts = await this.jsonRequest(run["artifacts_url"], "Artifacts fetch")

        const artifact = artifacts["artifacts"].find((artifact: any) => artifact["name"] === artifactName)
        if (artifact == null) {
            throw new Error(`No ${artifactName} artifact`)
        }
        return { run, artifact }
    }

    async getDownloadInfo(source: string, payload: string): Promise<{ run: any; artifact: any }> {
        const workflowPath = ".github/workflows/wasm.yml"
        const artifactName = "ruby-wasm-install"
        switch (source) {
        case "pr": {
            const runId = await this.getPullRequestLatestRunId(payload, workflowPath)
            return await this.getMetadata(runId, artifactName)
        }
        case "run":
            if (payload === "latest") {
                payload = await this.getBranchLatestRunId("master", workflowPath)
            }
            return await this.getMetadata(payload, artifactName)
        default:
            throw new Error(`Unknown source: ${source} with payload: ${payload}`)
        }
    }

    downloadArtifact(url: string): Promise<Response> {
        return fetch(url, { headers: this.headers });
    }
}

class PlayRubyService implements ArtifactDownloader {
    constructor(public endpoint: string) { }

    private fetch(url: string, options: RequestInit) {
        return fetch(url, { ...options, credentials: "include" })
    }

    /**
     * Fetches the metadata for a GitHub Actions run and returns the metadata for the given artifact
     * @param source The source of the artifact (e.g. "run", "pr")
     * @param payload The payload for the source (e.g. run ID, PR number)
     * @returns The metadata for the artifact in the given run
     */
    async getDownloadInfo(source: string, payload: string): Promise<{ run: any, artifact: any }> {
        const url = new URL(this.endpoint)
        url.pathname = "/download_info"
        url.searchParams.set("source", source)
        url.searchParams.set("payload", payload)
        const response = await this.fetch(url.toString(), {})
        if (!response.ok) {
            throw new GitHubAPIError("Download info", response)
        }
        return await response.json()
    }

    signInLink(origin: string) {
        const url = new URL(this.endpoint)
        url.pathname = "/sign_in"
        url.searchParams.set("origin", origin)
        return url.toString()
    }

    async signOut() {
        const url = new URL(this.endpoint)
        url.pathname = "/sign_out"
        await this.fetch(url.toString(), {})
    }

    async downloadArtifact(url: string) {
        return await fetch(url)
    }
}

/**
 * Provides access to GitHub Actions artifacts
 */
class GitHubArtifactRegistry {
    constructor(private cache: Cache, private downloader: ArtifactDownloader) { }

    /**
     * Returns the artifact at the given URL, either from the cache or by downloading it
     */
    async get(artifactUrl: string, cacheKey: string) {
        let response = await this.cache.match(cacheKey)
        if (response == null || !response.ok) {
            response = await this.downloader.downloadArtifact(artifactUrl)
            if (response.ok) {
                this.cache.put(cacheKey, response.clone())
            } else {
                throw new GitHubAPIError("Artifact download", response)
            }
        }
        return response
    }
}

/**
 * Passes through a response, but also calls setProgress with the number of bytes downloaded
 */
function teeDownloadProgress(response: Response, setProgress: (bytes: number, response: Response) => void): Response {
    let loaded = 0
    return new Response(new ReadableStream({
        async start(controller) {
            const reader = response.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                loaded += value.byteLength;
                setProgress(loaded, response);
                controller.enqueue(value);
            }
            controller.close();
        },
    }));
}


async function initRubyWorkerClass(rubySource: RubySource, service: ArtifactDownloader, setStatus: (status: string) => void, setMetadata: (run: any) => void) {
    setStatus("Installing Ruby...")
    const artifactRegistry = new GitHubArtifactRegistry(await caches.open("ruby-wasm-install-v1"), service)
    const RubyWorkerClass = Comlink.wrap(new Worker("build/src/ruby.worker.js", { type: "module" })) as unknown as {
        create(zipBuffer: ArrayBuffer, stripComponents: number, setStatus: (message: string) => void): Promise<RubyWorker>
    }
    const initFromZipTarball = async (
        url: string, cacheKey: string, stripComponents: number,
        setProgress: (bytes: number, response: Response) => void
    ) => {
        setStatus("Downloading Ruby...")
        const zipSource = await artifactRegistry.get(url, cacheKey)
        if (zipSource.status !== 200) {
            throw new Error(`Failed to download ${url}: ${zipSource.status} ${await zipSource.text()}`)
        }
        const zipResponse = teeDownloadProgress(
            zipSource,
            setProgress
        )
        const zipBuffer = await zipResponse.arrayBuffer();

        return async () => {
            return await RubyWorkerClass.create(zipBuffer, stripComponents, Comlink.proxy(setStatus))
        }
    }
    const initFromGitHubActionsRun = async (run: any, artifact: any) => {
        setMetadata(run)
        const size = Number(artifact["size_in_bytes"]);
        // archive_download_url might be changed, so use runId as cache key
        return await initFromZipTarball(artifact["archive_download_url"], run["id"], 0, (bytes, _) => {
            const total = size
            const percent = Math.round(bytes / total * 100)
            setStatus(`Downloading Ruby... ${percent}%`)
        })
    }
    const initFromBuiltin = async (version: string) => {
        const url = `build/ruby-${version}.zip`
        return await initFromZipTarball(url, url, 1, (bytes, response) => {
            const total = Number(response.headers.get("Content-Length"))
            const percent = Math.round(bytes / total * 100)
            setStatus(`Downloading Ruby... ${percent}%`)
        })
    }

    const workflowPath = ".github/workflows/wasm.yml"
    switch (rubySource.type) {
        case "github-actions-run": {
            let runId = rubySource.runId
            const { run, artifact } = await service.getDownloadInfo("run", runId)
            return initFromGitHubActionsRun(run, artifact)
        }
        case "github-pull-request": {
            const { run, artifact } = await service.getDownloadInfo("pr", rubySource.prNumber)
            return initFromGitHubActionsRun(run, artifact)
        }
        case "builtin":
            return initFromBuiltin(rubySource.version)
        default:
            throw new Error(`Unknown Ruby source type: ${rubySource}`)
    }
}

type RubySource = {
    type: "github-actions-run",
    runId: string,
} | {
    type: "github-pull-request",
    prNumber: string,
} | {
    type: "builtin",
    version: string,
}

function rubySourceFromURL(): RubySource | null {
    const query = new URLSearchParams(window.location.search)
    for (const [key, value] of query.entries()) {
        if (key === "run") {
            return { type: "github-actions-run", runId: value }
        } else if (key === "pr") {
            return { type: "github-pull-request", prNumber: value }
        } else if (key === "latest") {
            return { type: "github-actions-run", runId: "latest" }
        } else if (key === "builtin") {
            return { type: "builtin", version: value }
        }
    }
    return { type: "builtin", version: "3.4" }
}

type Options = {
    arguments: string[],
}

type UIState = {
    code: string,
    action: string,
    options: Options,
}

self.MonacoEnvironment = {
    getWorkerUrl: function (moduleId, label) {
        if (label === 'json') {
            return './build/node_modules/monaco-editor/esm/vs/language/json/json.worker.js';
        }
        return './build/node_modules/monaco-editor/esm/vs/editor/editor.worker.js';
    },
    getWorker: function (moduleId, label) {
        let workerUrl = self.MonacoEnvironment.getWorkerUrl(moduleId, label);
        return new Worker(workerUrl, {
            name: label,
            type: 'module',
        });
    }
};


function initEditor(state: UIState) {
    const editor = monaco.editor.create(document.getElementById('editor'), {
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

    const codeModel = monaco.editor.createModel(state.code, "ruby")
    const optionsModel = monaco.editor.createModel(JSON.stringify(state.options, null, 2), "json")

    type Tab = {
        label: string,
        model: monaco.editor.ITextModel,
        active: boolean,
        queryKey: string,
        computeQueryValue: (value: string) => string | null,
        applyDecorations?: (value: string) => void,
    }
    const tabs: Tab[] = [
        {
            label: "Code",
            model: codeModel,
            queryKey: "code",
            active: true,
            computeQueryValue: (value) => value,
            applyDecorations: (() => {
                let lastDecorations: monaco.editor.IEditorDecorationsCollection | null = null
                return (value) => {
                    const [files, _] = splitFile(value)
                    const decorations: monaco.editor.IModelDeltaDecoration[] = []
                    for (const [filename, file] of Object.entries(files)) {
                        const line = file.sourceLine;
                        const range = new monaco.Range(line + 1, 1, line + 1, 1)
                        decorations.push({
                            range,
                            options: {
                                isWholeLine: true,
                                className: "plrb-editor-file-header",
                            }
                        })
                    }
                    if (lastDecorations) lastDecorations.clear()
                    lastDecorations = editor.createDecorationsCollection(decorations)
                }
            })()
        },
        {
            label: "Options",
            model: optionsModel,
            queryKey: "options",
            active: false,
            computeQueryValue: (value) => {
                try {
                    const minified = JSON.stringify(JSON.parse(value))
                    return minified
                } catch (error) {
                    // Ignore invalid JSON
                    return null;
                }
            },
        }
    ]

    for (const tab of tabs) {
        const updateURL = () => {
            const url = new URL(window.location.href)
            let content = tab.computeQueryValue(tab.model.getValue())
            url.searchParams.set(tab.queryKey, content);
            window.history.replaceState({}, "", url.toString())
        }
        tab.model.onDidChangeContent(() => {
            updateURL()
            if (tab.applyDecorations) {
                tab.applyDecorations(tab.model.getValue())
            }
        })
    }

    const setTab = (tab: Tab) => {
        tab.active = true
        editor.setModel(tab.model)
        if (tab.applyDecorations) {
            tab.applyDecorations(tab.model.getValue())
        }
    }
    setTab(tabs[0]) // Set the first tab as active

    const editorTabs = document.getElementById("editor-tabs") as HTMLDivElement
    for (const tab of tabs) {
        const button = document.createElement("button")
        button.classList.add("plrb-editor-tab-button");
        if (tab.active) {
            button.classList.add("plrb-editor-tab-button-active")
        }
        button.innerText = tab.label
        button.addEventListener("click", () => {
            editorTabs.querySelectorAll(".plrb-editor-tab-button").forEach((button) => {
                button.classList.remove("plrb-editor-tab-button-active")
            });
            for (const tab of tabs) {
                tab.active = false
            }
            button.classList.add("plrb-editor-tab-button-active")
            setTab(tab)
        });
        editorTabs.appendChild(button)
    }

    return {
        editor,
        getOptions() {
            return JSON.parse(optionsModel.getValue()) as Options
        },
        getCode() {
            return codeModel.getValue()
        }
    };
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

    let options = JSON.parse(query.get("options")) as Options | null
    if (options == null) {
        options = {
            arguments: [],
        }
    }

    return { code, action, options }
}

function initUI(state: UIState, config: PlayRubyConfig, service: PlayRubyService) {
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
    const configGitHubSignIn = document.getElementById("config-github-sign-in") as HTMLButtonElement
    configGitHubSignIn.addEventListener("click", () => {
        window.open(service.signInLink(location.href).toString(), "_self")
    })
    const configGitHubSignOut = document.getElementById("config-github-sign-out") as HTMLButtonElement
    configGitHubSignOut.addEventListener("click", async () => {
        await service.signOut()
        window.location.reload()
    })

    // Show the GitHub integration section if the feature is enabled
    document.getElementById("config-github-integration").hidden = !config.ENABLE_GITHUB_INTEGRATION
    document.getElementById("config-github-pat").hidden = config.ENABLE_GITHUB_INTEGRATION

    for (const modal of [helpModal, configModal]) {
        modal.addEventListener("click", (event) => {
            if (event.target === modal) {
                // Clicked on the modal backdrop
                modal.close()
            }
        })
    }
}

interface OutputWriter {
    write(message: string): void;
    finalize(): void;
}

class PlainOutputWriter implements OutputWriter {
    constructor(private element: HTMLElement) { }

    write(message: string) {
        this.element.innerText += message
    }
    finalize(): void {}
}

/// Highlight (A,B)-(C,D) as a range in the editor
class LocationHighlightingOutputWriter implements OutputWriter {
    private buffered: string = ""
    constructor(private element: HTMLElement, private editor: monaco.editor.IEditor) {}

    write(message: string) {
        this.buffered += message
    }
    finalize(): void {
        const rangePattern = /\((\d+),(\d+)\)-\((\d+),(\d+)\)/g
        // Create spans for each range
        this.element.innerHTML = ""
        let lastEnd = 0
        for (const match of this.buffered.matchAll(rangePattern)) {
            const [fullMatch, startLine, startColumn, endLine, endColumn] = match
            const start = this.buffered.slice(lastEnd, match.index)
            const range = this.buffered.slice(match.index, match.index + fullMatch.length)
            lastEnd = match.index + fullMatch.length
            const span = document.createElement("span")
            span.innerText = start
            this.element.appendChild(span)
            const rangeSpan = document.createElement("span")
            rangeSpan.innerText = range
            rangeSpan.addEventListener("mouseover", () => {
                // Highlight the range in the editor
                // NOTE: Monaco's columns are 1-indexed but Ruby's are 0-indexed
                const range = new monaco.Range(Number(startLine), Number(startColumn) + 1, Number(endLine), Number(endColumn) + 1)
                this.editor.revealRangeInCenter(range, monaco.editor.ScrollType.Smooth)
                this.editor.setSelection(range)
            })
            rangeSpan.classList.add("plrb-output-range")
            this.element.appendChild(rangeSpan)
        }
        const end = this.buffered.slice(lastEnd)
        const span = document.createElement("span")
        span.innerText = end
        this.element.appendChild(span)
    }
}

export async function init(config: PlayRubyConfig) {
    const rubySource = rubySourceFromURL()
    const uiState = stateFromURL();

    const service = new PlayRubyService(config.SERVER_URL)
    const tokenBasedDownloader = new TokenBasedArtifactDownloader("ruby/ruby", {
        "Authorization": `token ${localStorage.getItem("GITHUB_TOKEN")}`
    })
    const downloader = config.ENABLE_GITHUB_INTEGRATION ? service : tokenBasedDownloader
    initUI(uiState, config, service);
    const { editor, getOptions, getCode } = initEditor(uiState)
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
        const statusElement = document.getElementById("status")
        statusElement.innerText = status
    }
    const setMetadata = (run: any) => {
        const metadataElement = document.getElementById("metadata") as HTMLSpanElement;
        const linkElement = (link: string, text: string) => {
            const a = document.createElement("a")
            a.href = link
            a.target = "_blank"
            a.innerText = text
            return a
        }
        const commitLink = () => {
            const description = `Commit: ${run["head_commit"]["message"].split("\n")[0]} (${run["head_commit"]["id"].slice(0, 7)})`
            const commitURL = `https://github.com/ruby/ruby/commit/${run["head_commit"]["id"]}`
            return linkElement(commitURL, description)
        }
        switch (rubySource.type) {
            case "github-actions-run": {
                const runLink = linkElement(run["html_url"], run["id"])
                metadataElement.appendChild(document.createTextNode(`GitHub Actions run (`))
                metadataElement.appendChild(runLink)
                metadataElement.appendChild(document.createTextNode(`) `))
                metadataElement.appendChild(commitLink())
                break
            }
            case "github-pull-request": {
                const prLink = linkElement(`https://github.com/ruby/ruby/pull/${rubySource.prNumber}`, `#${rubySource.prNumber}`)
                metadataElement.appendChild(document.createTextNode(`GitHub PR (`))
                metadataElement.appendChild(prLink)
                metadataElement.appendChild(document.createTextNode(`) `))
                metadataElement.appendChild(commitLink())
                break
            }
            case "builtin":
                const description = "Built-in Ruby"
                break
        }
    }

    try {
        const makeRubyWorker = await initRubyWorkerClass(rubySource, downloader, setStatus, setMetadata)
        if (makeRubyWorker == null) {
            return
        }
        const worker = await makeRubyWorker()
        const runCode = async (code: string) => {
            const selectedAction = actionSelect.value
            outputPane.innerText = ""
            let args: string[] = []
            const outputWriter = (selectedAction == "compile" || selectedAction == "syntax" || selectedAction == "syntax+prism")
                ? new LocationHighlightingOutputWriter(outputPane, editor)
                : new PlainOutputWriter(outputPane)
            try {
                args = getOptions().arguments
            } catch (error) {
                outputWriter.write(`Error parsing options: ${error.message}\n`)
                return;
            }
            const mainFile = "main.rb"
            const [files, remaining] = splitFile(code)
            const codeMap = { [mainFile]: remaining }
            for (const [filename, file] of Object.entries(files)) {
                // Prepend empty lines to the file content to match the original source line
                codeMap[filename] = "\n".repeat(file.sourceLine + 1) + file.content
            }
            await worker.run(codeMap, mainFile, selectedAction, args, Comlink.proxy((text) => outputWriter.write(text)))
            outputWriter.finalize()
        }
        const run = async () => await runCode(getCode());

        buttonRun.addEventListener("click", () => run())
        // Ctrl+Enter to run
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => run())

        // If the action is not "eval", run the code every time it changes or the action changes
        const runOnChange = () => {
            if (actionSelect.value !== "eval") {
                run()
            }
        }
        editor.onDidChangeModelContent(() => runOnChange())
        actionSelect.addEventListener("change", () => runOnChange())
    } catch (error) {
        console.error(error)
        setStatus(error.message)
        if (error instanceof GitHubAPIError && error.isUnauthorized()) {
            const configModal = document.getElementById("modal-config") as HTMLDialogElement
            configModal.showModal()
            return
        }
    }
    console.log("init")
}

// @ts-ignore
init({ SERVER_URL: PLAY_RUBY_SERVER_URL, ENABLE_GITHUB_INTEGRATION: true })
