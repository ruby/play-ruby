import { splitFile } from "./split-file"
import { expect, test } from "vitest"

test("basic", () => {
    const content = `#--- foo
foo
#--- bar
bar
#--- baz
baz`
    const [files, remaining] = splitFile(content)
    expect(remaining).toEqual("")
    expect(files).toEqual({
        foo: { content: "foo\n", sourceLine: 0 },
        bar: { content: "bar\n", sourceLine: 2 },
        baz: { content: "baz\n", sourceLine: 4 },
    })
})


test("remaining with trailing file", () => {
    const content = `main
#--- foo
foo`
    const [files, remaining] = splitFile(content)
    expect(remaining).toEqual("main\n")
    expect(files).toEqual({
        foo: { content: "foo\n", sourceLine: 1 },
    })
})

test("remaining with no files", () => {
    const content = `main`
    const [files, remaining] = splitFile(content)
    expect(remaining).toEqual("main\n")
    expect(files).toEqual({})
})
