type FileEntry = {
    content: string,
    /// The line number in the original source where this file starts. 0-indexed.
    sourceLine: number
}

/// A utility inspired by the LLVM `split-file` tool.
/// This tool takes a file content and splits it into multiple files
/// by regex pattern `^#--- filename` where `filename` is the
/// name of the file to be created.
/// Returns a tuple of the files and the remaining content.
/// See https://reviews.llvm.org/D83834 for the original tool.
function splitFile(content: string): [{ [filename: string]: FileEntry }, string] {
    const files: { [filename: string]: FileEntry } = {}

    const lines = content.split("\n")
    let currentFile = null
    let currentSourceLine = 0
    let currentContent = ""
    let remaining = ""

    for (const [i, line] of lines.entries()) {
        const match = line.match(/^#--- (.+)$/)
        if (match != null) {
            if (currentFile === null) {
                remaining = currentContent
            } else {
                files[currentFile] = { content: currentContent, sourceLine: currentSourceLine }
            }
            currentFile = match[1]
            currentSourceLine = i
            currentContent = ""
        } else {
            currentContent += line + "\n"
        }
    }

    if (currentFile === null) {
        remaining = currentContent
    } else {
        files[currentFile] = { content: currentContent, sourceLine: currentSourceLine }
    }

    return [files, remaining]
}

export { splitFile }
