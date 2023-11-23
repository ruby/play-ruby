import { WASI, useAll } from "uwasi"
import * as Comlink from "comlink"
import { memfs } from "memfs"
import { type IFs } from "memfs"
import { RubyInstall } from "./ruby-install"

export class RubyWorker {
    module: WebAssembly.Module;
    instnace: Promise<WebAssembly.Instance>;
    wasi: WASI;
    fs: IFs;

    constructor(module: WebAssembly.Module, fs: IFs) {
        this.module = module
        this.fs = fs
    }

    static async create(zipBuffer: ArrayBuffer, setStatus: (message: string) => void): Promise<RubyWorker> {
        setStatus("Loading...")
        const { fs } = memfs()
        const installer = new RubyInstall(setStatus)
        await installer.installZip(fs, new Response(zipBuffer))
        const rubyModuleEntry = fs.readFileSync("/usr/local/bin/ruby")
        const rubyModule = WebAssembly.compile(rubyModuleEntry as Uint8Array)

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

        const wasi = new WASI({
            args: ["ruby", "--disable=gems", "-e", code].concat(extraArgs),
            features: [useAll({
                stderr(lines) { log(lines) },
                stdout(lines) { log(lines) },
            })]
        })
        const imports = {
            wasi_snapshot_preview1: wasi.wasiImport
        }
        const instnace = await WebAssembly.instantiate(this.module, imports);
        wasi.start(instnace)
    }
}

Comlink.expose(RubyWorker)
