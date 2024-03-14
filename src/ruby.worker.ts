import { Directory, File, OpenFile, PreopenDirectory, SyncOPFSFile, ConsoleStdout, WASI } from "@bjorn3/browser_wasi_shim"
import * as Comlink from "comlink"
import { IFs, RubyInstall } from "./ruby-install"


type IDir = Pick<Directory, "get_entry_for_path" | "create_entry_for_path">;

class WASIFs implements IFs {
    public rootContents: { [key: string]: File | Directory | SyncOPFSFile } = {}
    constructor() { }

    private _getRoot(): IDir {
        return {
            get_entry_for_path: (path: string) => {
                return this.rootContents[path]
            },
            create_entry_for_path: (path: string, is_dir: boolean) => {
                if (is_dir) {
                    const dir = new Directory({})
                    this.rootContents[path] = dir
                    return dir
                } else {
                    const file = new File([])
                    this.rootContents[path] = file
                    return file
                }
            }
        }
    }

    private _getDirectoryAtPath(path: string[]): IDir {
        let dir = this._getRoot()
        for (const part of path) {
            const entry = dir.get_entry_for_path(part)
            if (entry == null) {
                dir = dir.create_entry_for_path(part, true) as Directory
            } else if (entry instanceof Directory) {
                dir = entry
            } else {
                throw new Error(`ENOTDIR: not a directory, open '${path}'`)
            }
        }
        return dir
    }

    private _splitPath(path: string): string[] {
        const parts = path.split("/")
        // Remove empty parts, meaning that "/usr//local" becomes ["", "usr", "", "local"]
        // and then remove "." because:
        // - Our cwd is always "/"
        // - "." does not change the path
        return parts.filter((part) => part !== "" && part !== ".")
    }

    mkdirSync(path: string, options?: any): void {
        const parts = this._splitPath(path)
        const recursive = options?.recursive ?? false

        let current = this._getRoot()

        for (const part of parts) {
            if (part === "") {
                continue
            }
            const entry = current.get_entry_for_path(part)
            if (entry == null) {
                if (recursive) {
                    current = current.create_entry_for_path(part, true) as Directory
                } else {
                    throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`)
                }
            } else if (entry instanceof Directory) {
                current = entry
            } else {
                throw new Error(`EEXIST: file already exists, mkdir '${path}'`)
            }
        }
    }

    writeFileSync(path: string, data: any, options?: any): void {
        const parts = this._splitPath(path)
        const dir = this._getDirectoryAtPath(parts.slice(0, parts.length - 1))
        const createdFile = dir.create_entry_for_path(parts[parts.length - 1], false) as File
        createdFile.data = data
    }

    readFileSync(path: string, options?: any): any {
        const parts = this._splitPath(path)
        const dir = this._getDirectoryAtPath(parts.slice(0, parts.length - 1))
        const file = dir.get_entry_for_path(parts[parts.length - 1]) as File
        if (file == null) {
            throw new Error(`ENOENT: no such file or directory, open '${path}'`)
        }
        return file.data
    }
}

export class RubyWorker {
    module: WebAssembly.Module;

    constructor(module: WebAssembly.Module, private prefix: string | null, private fs: WASIFs) {
        this.module = module
    }

    static async create(zipBuffer: ArrayBuffer, prefix: string | null, setStatus: (message: string) => void): Promise<RubyWorker> {
        setStatus("Loading...")
        const fs = new WASIFs()
        const installer = new RubyInstall(setStatus)
        await installer.installZip(fs, new Response(zipBuffer))
        const rubyModuleEntry = fs.readFileSync((prefix || "") + "/usr/local/bin/ruby")
        const rubyModule = WebAssembly.compile(rubyModuleEntry as Uint8Array)
        setStatus("Ready")

        return Comlink.proxy(new RubyWorker(await rubyModule, prefix, fs))
    }

    async run(code: string, action: string, extraArgs: string[], log: (message: string) => void) {
        switch (action) {
            case "eval": break
            case "compile": extraArgs.push("--dump=insns"); break
            case "syntax": extraArgs.push("--dump=parsetree"); break
            case "syntax+prism": extraArgs.push("--dump=prism_parsetree"); break
            default: throw new Error(`Unknown action: ${action}`)
        }

        let rootContents = this.fs.rootContents
        if (this.prefix != null) {
            rootContents = (this.fs.rootContents[this.prefix] as Directory).contents
        }

        const wasi = new WASI(
            ["ruby", "-e", code].concat(extraArgs),
            [],
            [
                new OpenFile(new File([])), // stdin
                ConsoleStdout.lineBuffered(log), // stdout
                ConsoleStdout.lineBuffered(log), // stderr
                new PreopenDirectory("/", rootContents),
            ],
            {
                debug: false
            }
        )
        const imports = {
            wasi_snapshot_preview1: wasi.wasiImport,
        }

        const instnace: any = await WebAssembly.instantiate(this.module, imports);
        try {
            wasi.start(instnace)
        } catch (e) {
            log(e)
        }
    }
}

Comlink.expose(RubyWorker)
