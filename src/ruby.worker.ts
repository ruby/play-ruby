import { Directory, File, OpenFile, PreopenDirectory, SyncOPFSFile, WASI } from "@bjorn3/browser_wasi_shim"
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

    /// This is a shallow clone, so the contents of directories under the root are not cloned
    shallowClone(): WASIFs {
        const fs = new WASIFs()
        fs.rootContents = { ...this.rootContents }
        return fs
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

const consolePrinter = (log: (fd: number, str: string) => void) => {
    let memory: WebAssembly.Memory | undefined = undefined;
    let view: DataView | undefined = undefined;

    const decoder = new TextDecoder();

    return {
        addToImports(imports: WebAssembly.Imports): void {
            const original = imports.wasi_snapshot_preview1.fd_write as (
                fd: number,
                iovs: number,
                iovsLen: number,
                nwritten: number,
            ) => number;
            imports.wasi_snapshot_preview1.fd_write = (
                fd: number,
                iovs: number,
                iovsLen: number,
                nwritten: number,
            ): number => {
                if (fd !== 1 && fd !== 2) {
                    return original(fd, iovs, iovsLen, nwritten);
                }

                if (typeof memory === "undefined" || typeof view === "undefined") {
                    throw new Error("Memory is not set");
                }
                if (view.buffer.byteLength === 0) {
                    view = new DataView(memory.buffer);
                }

                const buffers = Array.from({ length: iovsLen }, (_, i) => {
                    const ptr = iovs + i * 8;
                    const buf = view.getUint32(ptr, true);
                    const bufLen = view.getUint32(ptr + 4, true);
                    return new Uint8Array(memory.buffer, buf, bufLen);
                });

                let written = 0;
                let str = "";
                for (const buffer of buffers) {
                    str += decoder.decode(buffer);
                    written += buffer.byteLength;
                }
                view.setUint32(nwritten, written, true);

                log(fd, str);

                return 0;
            };
        },
        setMemory(m: WebAssembly.Memory) {
            memory = m;
            view = new DataView(m.buffer);
        },
    };
};


export class RubyWorker {
    module: WebAssembly.Module;

    constructor(module: WebAssembly.Module, private fs: WASIFs) {
        this.module = module
    }

    static async create(zipBuffer: ArrayBuffer, stripComponents: number, setStatus: (message: string) => void): Promise<RubyWorker> {
        setStatus("Loading...")
        const fs = new WASIFs()
        const installer = new RubyInstall({ stripComponents, setStatus })
        await installer.installZip(fs, new Response(zipBuffer))
        const rubyModuleEntry = fs.readFileSync("/usr/local/bin/ruby")
        const rubyModule = WebAssembly.compile(rubyModuleEntry as Uint8Array)
        setStatus("Ready")

        return Comlink.proxy(new RubyWorker(await rubyModule, fs))
    }

    async run(code: { [path: string]: string }, mainScriptPath: string, action: string, extraArgs: string[], log: (message: string) => void) {
        switch (action) {
            case "eval": break
            case "compile": extraArgs.push("--dump=insns"); break
            case "syntax": extraArgs.push("--dump=parsetree"); break
            case "syntax+prism": extraArgs.push("--dump=prism_parsetree"); break
            default: throw new Error(`Unknown action: ${action}`)
        }

        // Build a fresh file system by merging given code files and the Ruby installation
        const codeFs = this.fs.shallowClone()
        const textEncoder = new TextEncoder()
        for (const path in code) {
            codeFs.writeFileSync(path, textEncoder.encode(code[path]))
        }
        const rootContents = codeFs.rootContents

        // Run the Ruby module with the given code
        const wasi = new WASI(
            ["ruby"].concat(extraArgs).concat([mainScriptPath]),
            [],
            [
                new OpenFile(new File([])), // stdin
                new OpenFile(new File([])), // stdout
                new OpenFile(new File([])), // stderr
                new PreopenDirectory("/", rootContents),
            ],
            {
                debug: false
            }
        )
        const imports = {
            wasi_snapshot_preview1: wasi.wasiImport,
        }
        const printer = consolePrinter((fd, str) => { log(str) })
        printer.addToImports(imports)

        const instnace: any = await WebAssembly.instantiate(this.module, imports);
        printer.setMemory(instnace.exports.memory);
        try {
            wasi.start(instnace)
        } catch (e) {
            log(e)
            throw e
        }
    }
}

Comlink.expose(RubyWorker)
