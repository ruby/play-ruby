import { WASI, useAll } from "uwasi"
import * as Comlink from "comlink"

export class RubyWorker {
    module: WebAssembly.Module;
    instnace: Promise<WebAssembly.Instance>;
    wasi: WASI;

    constructor(module: WebAssembly.Module) {
        this.module = module
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
