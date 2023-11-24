import { ZipReader } from "@zip.js/zip.js"
import * as tar from "tar-stream"

export type IFs = {
    mkdirSync(path: string, options?: any): void
    writeFileSync(path: string, data: any, options?: any): void
}

export class RubyInstall {
    constructor(private setStatus: (status: string) => void = () => { }) { }

    async installZip(fs: IFs, zipResponse: Response) {
        const zipReader = new ZipReader(zipResponse.body);
        const entries = await zipReader.getEntries()
        const installTarGz = entries.find((entry) => entry.filename === "install.tar.gz")
        if (installTarGz == null) {
            throw new Error("No install.tar.gz!?")
        }
        await this.installTarGz(fs, (writable) => installTarGz.getData(writable))
    }

    async installTarGz(fs: IFs, pipe: (writable: WritableStream) => void) {
        const gzipDecompress = new DecompressionStream("gzip")
        pipe(gzipDecompress.writable)
        await this.installTar(fs, gzipDecompress.readable)
    }

    async installTar(fs: IFs, tarStream: ReadableStream) {
        const tarExtract = tar.extract()

        this.setStatus("Downloading, unzipping, and untarring...")
        // TODO: Figure out proper way to bridge Node.js's stream and Web Streams API
        const buffer = await new Response(tarStream).arrayBuffer()
        tarExtract.write(Buffer.from(buffer))
        tarExtract.end()

        this.setStatus("Installing...")

        const dataWorks = []
        for await (const entry of tarExtract) {
            const header = entry.header;
            const path = header.name
            if (header.type === "directory") {
                fs.mkdirSync(path, { recursive: true })
            } else if (header.type === "file") {
                const dataWork = new Promise<void>((resolve, reject) => {
                    const chunks: Uint8Array[] = []
                    entry.on("data", (chunk) => {
                        chunks.push(chunk)
                    })
                    entry.on("end", () => {
                        const data = Buffer.concat(chunks)
                        fs.writeFileSync(path, data)
                        resolve()
                    })
                    entry.on("error", (err) => {
                        reject(err)
                    })
                })
                dataWorks.push(dataWork)
            } else {
                throw new Error(`Unknown entry type ${header.type}`)
            }
            entry.resume()
        }
        await Promise.all(dataWorks)
        this.setStatus("Installed")
    }
}
