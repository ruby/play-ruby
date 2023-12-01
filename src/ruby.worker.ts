import { Directory, File, OpenFile, PreopenDirectory, SyncOPFSFile, WASI, strace } from "@bjorn3/browser_wasi_shim"
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
    instnace: Promise<WebAssembly.Instance>;
    wasi: WASI;

    constructor(module: WebAssembly.Module, private fs: WASIFs) {
        this.module = module
    }

    static async create(zipBuffer: ArrayBuffer, setStatus: (message: string) => void): Promise<RubyWorker> {
        setStatus("Loading...")
        const fs = new WASIFs()
        const installer = new RubyInstall(setStatus)
        await installer.installZip(fs, new Response(zipBuffer))
        const rubyModuleEntry = fs.readFileSync("/usr/local/bin/ruby")
        const rubyModule = WebAssembly.compile(rubyModuleEntry as Uint8Array)
        setStatus("Ready")

        return Comlink.proxy(new RubyWorker(await rubyModule, fs))
    }

    async run(code: string, action: string, log: (message: string) => void) {
        let extraArgs: string[] = []
        switch (action) {
            case "eval": break
            case "compile": extraArgs = ["--dump=insns"]; break
            case "syntax": extraArgs = ["--dump=parsetree"]; break
            default: throw new Error(`Unknown action: ${action}`)
        }

        const wasi = new WASI(
            ["ruby", "--disable=gems", "-e", code].concat(extraArgs),
            [],
            [
                new OpenFile(new File([])), // stdin
                new OpenFile(new File([])), // stdout
                new OpenFile(new File([])), // stderr
                new PreopenDirectory("/", this.fs.rootContents),
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

        {
            // WORKAROUND: browser_wasi_shim does not support some syscalls yet
            // and returns -1 instead of proper ERRNO values and it results in confusing
            // error messages "Success -- /path/to/file".
            // Update browser_wasi_shim version when my fix[^1] will be released.
            // [^1]: https://github.com/bjorn3/browser_wasi_shim/commit/6193f7482633ef818604375d9755ded67946adfc
            const syscalls = imports["wasi_snapshot_preview1"]
            for (const name of Object.keys(syscalls)) {
                const original = syscalls[name];
                syscalls[name] = (...args: any[]) => {
                    const result = original(...args);
                    if (result === -1) {
                        return 58; // ENOTSUP
                    }
                    return result;
                };
            }
        }

        const instnace: any = await WebAssembly.instantiate(this.module, imports);
        printer.setMemory(instnace.exports.memory);
        try {
            wasi.start(instnace)
        } catch (e) {
            log(e)
        }
    }
}

Comlink.expose(RubyWorker)
