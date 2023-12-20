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
        async function *commits() {
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


async function initRubyWorkerClass(rubySource: RubySource, setStatus: (status: string) => void, setMetadata: (run: any) => void) {
    setStatus("Installing Ruby...")
    const artifactRegistry = new GitHubArtifactRegistry("ruby/ruby", await caches.open("ruby-wasm-install-v1"), {
        "Authorization": `token ${localStorage.getItem("GITHUB_TOKEN")}`
    })
    const RubyWorkerClass = Comlink.wrap(new Worker("build/src/ruby.worker.js", { type: "module" })) as unknown as {
        createFromModule(module: WebAssembly.Module): Promise<RubyWorker>;
        create(zipBuffer: ArrayBuffer, setStatus: (message: string) => void): Promise<RubyWorker>
    }
    const initFromGitHubActionsRun = async (runId: string) => {
        const { run, artifact } = await artifactRegistry.getMetadata(runId, "ruby-wasm-install")
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

        return async () => {
            return await RubyWorkerClass.create(zipBuffer, Comlink.proxy(setStatus))
        }
    }
    const initFromBuiltin = async () => {
        const rubyWasmBinary = fetch(`build/ruby.wasm`)
        const rubyModule = (typeof WebAssembly.compileStreaming === "function") ?
            WebAssembly.compileStreaming(rubyWasmBinary) :
            WebAssembly.compile(await (await rubyWasmBinary).arrayBuffer())
        return async () => {
            const worker = await RubyWorkerClass.createFromModule(await rubyModule)
            setStatus("Ready")
            return worker
        }
    }

    const workflowPath = ".github/workflows/wasm.yml"
    switch (rubySource.type) {
        case "github-actions-run":
            let runId = rubySource.runId
            if (rubySource.runId === "latest") {
                runId = await artifactRegistry.getBranchLatestRunId("master", workflowPath)
            }
            return initFromGitHubActionsRun(runId)
        case "github-pull-request":
            const actionsRunId = await artifactRegistry.getPullRequestLatestRunId(rubySource.prNumber, workflowPath)
            return initFromGitHubActionsRun(actionsRunId)
        case "builtin":
            return initFromBuiltin()
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
    type: "builtin"
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
            return { type: "builtin" }
        }
    }
    return { type: "github-actions-run", runId: "latest" }
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
    editor.setModel(codeModel)

    type Tab = {
        label: string,
        model: monaco.editor.ITextModel,
        active: boolean,
        queryKey: string,
    }
    const tabs: Tab[] = [
        {
            label: "Code",
            model: codeModel,
            queryKey: "code",
            active: true,
        },
        {
            label: "Options",
            model: optionsModel,
            queryKey: "options",
            active: false,
        }
    ]

    for (const tab of tabs) {
        tab.model.onDidChangeContent(() => {
            const url = new URL(window.location.href)
            let content = tab.model.getValue()
            if (tab.model.getLanguageId() === "json") {
                try {
                    const minified = JSON.stringify(JSON.parse(tab.model.getValue()))
                    content = minified
                } catch (error) {
                    // Ignore invalid JSON
                    return;
                }
            }
            url.searchParams.set(tab.queryKey, content);
            window.history.replaceState({}, "", url.toString())
        })
    }

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
            tab.active = true
            button.classList.add("plrb-editor-tab-button-active")
            editor.setModel(tab.model)
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
    const rubySource = rubySourceFromURL()
    const uiState = stateFromURL();
    initUI(uiState);
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
        document.getElementById("status").innerText = status
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
                const runLink = linkElement(run["html_url"],  run["id"])
                metadataElement.appendChild(document.createTextNode(`GitHub Actions run (`))
                metadataElement.appendChild(runLink)
                metadataElement.appendChild(document.createTextNode(`) `))
                metadataElement.appendChild(commitLink())
                break
            }
            case "github-pull-request": {
                const prLink = linkElement(`https://github.com/ruby/ruby/pull/${rubySource.prNumber}`, `#${rubySource.prNumber}`)
                const description = `GitHub PR (`;
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
        const makeRubyWorker = await initRubyWorkerClass(rubySource, setStatus, setMetadata)
        if (makeRubyWorker == null) {
            return
        }
        const worker = await makeRubyWorker()
        const writeOutput = (message: string) => {
            outputPane.innerText += message
        }
        const runCode = async (code: string) => {
            const selectedAction = actionSelect.value
            outputPane.innerText = ""
            let args: string[] = []
            try {
                args = getOptions().arguments
            } catch (error) {
                writeOutput(`Error parsing options: ${error.message}\n`)
                return;
            }
            await worker.run(code, selectedAction, args, Comlink.proxy(writeOutput))
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
